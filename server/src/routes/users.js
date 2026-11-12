/**
 * 用户路由
 *
 * 路由前缀：/api/users（在 app.js 中挂载）
 *
 * 接口列表：
 *   PUT   /profile              更新个人资料（需登录）
 *   POST  /avatar               上传头像（需登录，限制 2MB，校验签名后重编码为 512px webp）
 *   GET   /:userId              获取用户信息（需登录）
 *   GET   /:userId/documents    获取用户发布的文档列表
 *   GET   /:userId/stats        获取用户统计（需登录，文档数 / 点赞 / 收藏 / 浏览）
 *
 * 注意：/profile 与 /avatar 必须放在 /:userId 之前，避免被当作 userId 解析。
 */
import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import { config } from '../config/index.js'
import { auth, optionalAuth } from '../middleware/auth.js'
import {
  findUserById,
  updateUserProfile,
  stripPassword,
  listDocuments,
  getUserStats,
  isAdmin,
} from '../db/index.js'
import { success, badRequest, notFound } from '../utils/response.js'
import { paginationSchema, parse, parseId } from '../middleware/validate.js'
import { uploadLimiter } from '../middleware/rateLimit.js'
import { recordError } from '../services/observability.js'

const router = Router()

// 是否允许作为头像的图片类型（仅用于展示，不作为安全依据）
const ALLOWED_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/

// 图片文件头魔数：声明 MIME 与扩展名都可以伪造，必须看真实内容
const IMAGE_SIGNATURES = [
  {
    ext: 'png',
    mime: 'image/png',
    test: (b) =>
      b.length > 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    ext: 'jpg',
    mime: 'image/jpeg',
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: 'gif',
    mime: 'image/gif',
    test: (b) =>
      b.length > 6 &&
      (b.subarray(0, 6).toString('ascii') === 'GIF87a' ||
        b.subarray(0, 6).toString('ascii') === 'GIF89a'),
  },
  {
    ext: 'webp',
    mime: 'image/webp',
    test: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
]

/** 通过文件头识别真实图片类型，识别失败返回 null */
function sniffImage(buffer = Buffer.alloc(0)) {
  return IMAGE_SIGNATURES.find((sig) => sig.test(buffer)) || null
}

/** 只允许删除 uploads 目录内、由系统生成的头像文件，避免路径穿越 */
function resolveOldAvatar(oldUrl) {
  if (typeof oldUrl !== 'string' || !oldUrl.startsWith('/uploads/')) return null
  const fileName = path.basename(oldUrl)
  if (!/^avatar-[\w-]+\.(png|jpg|gif|webp)$/.test(fileName)) return null
  const fullPath = path.resolve(config.uploadDir, fileName)
  const root = path.resolve(config.uploadDir)
  return fullPath.startsWith(root + path.sep) ? fullPath : null
}

// 头像上传：内存接收，校验文件签名后再落盘，文件名使用随机 ID
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 }, // 2MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.test(file.mimetype)) {
      cb(null, true)
    } else {
      cb(badRequest('仅支持 png/jpg/gif/webp 格式'))
    }
  },
})

// 资料更新字段边界；头像仅允许本站上传路径或 http(s) 地址，阻断 javascript:/data: 等协议
const profileSchema = z
  .object({
    name: z.string().trim().min(1, '姓名不能为空').max(50, '姓名过长').optional(),
    department: z.string().trim().max(50, '部门名称过长').optional(),
    avatar: z
      .string()
      .trim()
      .max(500, '头像地址过长')
      .refine(
        (v) =>
          v === '' ||
          /^\/uploads\/[A-Za-z0-9._-]+$/.test(v) ||
          /^https?:\/\//i.test(v),
        '头像地址不合法',
      )
      .optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.department !== undefined ||
      v.avatar !== undefined,
    '没有需要更新的字段',
  )

// 更新个人资料（放在 /:userId 之前避免被当作 id 解析）
router.put('/profile', auth, async (req, res, next) => {
  try {
    const payload = parse(profileSchema, req.body, '资料参数无效')
    const user = await updateUserProfile(req.user.id, payload)
    success(res, stripPassword(user), '更新成功')
  } catch (err) {
    next(err)
  }
})

// 上传头像：返回 /uploads/<filename> 路径，前端直接拼 URL 访问
router.post(
  '/avatar',
  auth,
  uploadLimiter,
  upload.single('avatar'),
  async (req, res, next) => {
    try {
      if (!req.file) throw badRequest('请上传头像文件')
      // 以真实文件头为准，拒绝伪装成图片的其他内容
      if (!sniffImage(req.file.buffer)) throw badRequest('文件内容不是有效的图片')

      // 解码后重新编码：剥离 EXIF/ICC 等元数据与原始文件结构，限制尺寸并压缩体积。
      // 输出统一为 webp，彻底消除“声明 MIME/扩展名与实际格式不一致”的风险。
      let encoded
      try {
        encoded = await sharp(req.file.buffer, {
          limitInputPixels: 40_000_000, // 防止超大像素图拖垮内存
          failOn: 'error',
        })
          .rotate() // 按 EXIF 方向摆正后再丢弃元数据
          .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer()
      } catch (err) {
        // 损坏/伪造的图片属于客户端问题，记录后返回 400
        recordError('avatar.encode', err, { userId: req.user.id })
        throw badRequest('图片解析失败，请更换图片后重试')
      }

      const fileName = `avatar-${req.user.id}-${randomUUID()}.webp`
      const target = path.resolve(config.uploadDir, fileName)
      const root = path.resolve(config.uploadDir)
      if (!target.startsWith(root + path.sep)) {
        throw badRequest('非法的文件路径')
      }
      await fs.mkdir(root, { recursive: true })
      await fs.writeFile(target, encoded)

      const url = `/uploads/${fileName}`
      await updateUserProfile(req.user.id, { avatar: url })

      // 清理旧头像，避免公开目录无限增长；失败不影响本次上传结果
      const oldPath = resolveOldAvatar(req.user.avatar)
      if (oldPath) {
        fs.unlink(oldPath).catch(() => {})
      }
      success(res, { avatar: url }, '头像上传成功')
    } catch (err) {
      next(err)
    }
  },
)

// 获取用户信息（需登录：返回邮箱/部门等资料，不对外开放）
router.get('/:userId', auth, async (req, res, next) => {
  try {
    const user = await findUserById(parseId(req.params.userId, '用户 ID'))
    if (!user) throw notFound('用户不存在')
    success(res, stripPassword(user))
  } catch (err) {
    next(err)
  }
})

// 获取用户文档列表（按作者过滤后分页，下推到 SQL 层）
router.get('/:userId/documents', optionalAuth, async (req, res, next) => {
  try {
    const userId = parseId(req.params.userId, '用户 ID')
    const { page, pageSize } = parse(
      paginationSchema(50, 10),
      req.query,
      '分页参数无效',
    )
    const result = await listDocuments({
      authorId: userId,
      page,
      pageSize,
      viewerId: req.user?.id ?? null,
      viewerIsAdmin: isAdmin(req.user),
    })
    success(res, result)
  } catch (err) {
    next(err)
  }
})

// 获取用户统计（需登录，避免匿名枚举他人数据）
router.get('/:userId/stats', auth, async (req, res, next) => {
  try {
    success(res, await getUserStats(parseId(req.params.userId, '用户 ID')))
  } catch (err) {
    next(err)
  }
})

export default router
