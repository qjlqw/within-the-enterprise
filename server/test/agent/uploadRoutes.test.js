import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import express from 'express'
import { initDb, findUserById } from '../../src/db/index.js'
import { signToken } from '../../src/middleware/auth.js'
import { errorHandler } from '../../src/middleware/error.js'
import documentsRouter from '../../src/routes/documents.js'
import { config } from '../../src/config/index.js'

beforeEach(initDb)

// .env 可能开启 RAG_ENABLED，但测试不会执行服务启动时的向量库初始化，
// 队列会一直停在 waiting。本文件只验证上传/队列路由契约，固定关闭 RAG，
// 此时 upsertDocument 为空操作，任务直接 done。
const ragEnabledSaved = config.rag.enabled
config.rag.enabled = false
after(() => {
  config.rag.enabled = ragEnabledSaved
})

async function setup(t) {
  const app = express()
  app.use('/api/documents', documentsRouter)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const base = `http://127.0.0.1:${server.address().port}/api/documents`

  const auth = (userId) => ({
    Authorization: `Bearer ${signToken(findUserById(userId))}`,
  })

  /** multipart 上传 */
  const upload = (userId, form) =>
    fetch(`${base}/upload`, {
      method: 'POST',
      headers: userId ? auth(userId) : {},
      body: form,
    })

  return { base, auth, upload }
}

/** 构造上传表单 */
function uploadForm({ filename = 'guide.md', content = '# 上传标题\n\n上传正文内容', category, status, tags, withFile = true } = {}) {
  const form = new FormData()
  if (withFile) form.append('file', new Blob([Buffer.from(content)]), filename)
  if (category !== undefined) form.append('category', category)
  if (status !== undefined) form.append('status', status)
  if (tags !== undefined) form.append('tags', tags)
  return form
}

test('上传接口必须登录', async (t) => {
  const { upload } = await setup(t)
  const res = await upload(null, uploadForm({ category: '技术文档' }))
  assert.equal(res.status, 401)
})

test('缺少文件 / 缺少分类 / 非法扩展名均返回 400', async (t) => {
  const { upload } = await setup(t)

  const noFile = await upload(1, uploadForm({ category: '技术文档', withFile: false }))
  assert.equal(noFile.status, 400)

  const noCategory = await upload(1, uploadForm({ category: '' }))
  assert.equal(noCategory.status, 400)

  const badExt = await upload(
    1,
    uploadForm({ filename: 'malware.pdf', category: '技术文档' }),
  )
  assert.equal(badExt.status, 400)
})

test('草稿上传成功：返回解析后的文档且不入索引队列', async (t) => {
  const { upload } = await setup(t)
  const res = await upload(
    1,
    uploadForm({
      content: '# 上传标题\n\n这是通过文件上传进入系统的正文。',
      category: '技术文档',
      status: 'draft',
      tags: 'java,script',
    }),
  )
  assert.equal(res.status, 200)
  const payload = await res.json()
  assert.equal(payload.data.doc.title, '上传标题')
  assert.equal(payload.data.doc.status, 'draft')
  assert.deepEqual(payload.data.doc.tags, ['java', 'script'])
  assert.match(payload.data.doc.content, /文件上传进入系统/)
  assert.equal(payload.data.indexJob, null)
})

test('发布上传成功：返回索引任务，后台执行完成后可查询状态', async (t) => {
  const { upload, base, auth } = await setup(t)
  const form = uploadForm({
    filename: 'release.md',
    content: '# 发布上传\n\n已发布文档进入异步索引队列。',
    category: '规范',
    status: 'published',
    tags: JSON.stringify(['发布', '队列']),
  })
  const res = await upload(2, form)
  assert.equal(res.status, 200)
  const payload = await res.json()
  assert.equal(payload.data.doc.status, 'published')
  assert.ok(payload.data.indexJob?.jobId)
  const docId = payload.data.doc.id

  // RAG 未启用时队列空操作即 done（等待后台 pump）
  let status
  for (let i = 0; i < 20; i++) {
    const jobRes = await fetch(`${base}/index-jobs/${docId}`, { headers: auth(2) })
    assert.equal(jobRes.status, 200, 'index-jobs 路由不能被 /:id 抢先匹配')
    status = (await jobRes.json()).data.status
    if (status === 'done') break
    await delay(30)
  }
  assert.equal(status, 'done')
})

test('索引重试权限：非作者非 admin 返回 403；作者在非 failed 时得到 400', async (t) => {
  const { upload, base, auth } = await setup(t)
  const res = await upload(
    2,
    uploadForm({ category: '培训', status: 'published' }),
  )
  const docId = (await res.json()).data.doc.id

  // 等任务自然完成（RAG 未启用为空操作）
  let status
  for (let i = 0; i < 20; i++) {
    status = (await (await fetch(`${base}/index-jobs/${docId}`, { headers: auth(2) })).json())
      .data.status
    if (status === 'done') break
    await delay(30)
  }
  assert.equal(status, 'done')

  // 其他普通用户无权重试
  const forbidden = await fetch(`${base}/index-jobs/${docId}/retry`, {
    method: 'POST',
    headers: { ...auth(3), 'Content-Type': 'application/json' },
  })
  assert.equal(forbidden.status, 403)

  // 作者本人：任务已成功，不存在失败任务 → 400
  const own = await fetch(`${base}/index-jobs/${docId}/retry`, {
    method: 'POST',
    headers: { ...auth(2), 'Content-Type': 'application/json' },
  })
  assert.equal(own.status, 400)

  // 未登录 → 401
  const anon = await fetch(`${base}/index-jobs/${docId}/retry`, { method: 'POST' })
  assert.equal(anon.status, 401)
})

test('二进制伪装文本文件在解析阶段被拒绝（400），不产生文档', async (t) => {
  const { upload } = await setup(t)
  const form = new FormData()
  form.append('file', new Blob([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])]), 'evil.txt')
  form.append('category', '技术文档')
  const res = await upload(1, form)
  assert.equal(res.status, 400)
})
