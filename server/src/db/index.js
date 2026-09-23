/**
 * 数据访问层：纯 Supabase 直查（无内存缓存 / 无种子数据 / 无写穿透）
 *
 * 职责：
 * - 对上层（路由 / 服务 / agent）暴露统一的异步数据 API。
 * - 底层全部委托给 ./supabase.js 适配器，直接读写 Supabase。
 * - 所有主键由数据库 identity 自增，写入时不传 id。
 * - 保留少量纯内存/纯函数的业务工具与静态配置（bcrypt 哈希、
 *   积分规则、热门搜索词、stripPassword 等）。
 *
 * 注意：本模块所有查询方法均为异步，调用方必须 await。
 */
import bcrypt from "bcryptjs";
import { formatDateTime } from "../utils/date.js";
import * as supabase from "./supabase.js";

// ---------- 静态配置 / 工具 ----------

/** 热门搜索词（前端首页展示） */
const hotSearches = [
  "React",
  "Elasticsearch",
  "项目规范",
  "API 文档",
  "入职指南",
];

/** 积分规则：发布 / 被点赞 / 被收藏 / 评论，每种行为单独计分 */
const pointsRules = [
  { type: "publish", name: "发布文档", points: 10, dailyLimit: 50 },
  { type: "like", name: "文档被点赞", points: 1, dailyLimit: 20 },
  { type: "favorite", name: "文档被收藏", points: 2, dailyLimit: 20 },
  { type: "comment", name: "发布评论", points: 1, dailyLimit: 10 },
];

/** bcrypt 哈希密码：cost=8，平衡安全与启动速度 */
function hash(pw) {
  return bcrypt.hashSync(pw, 8);
}

/** 字符串 / 数字 id 统一转数字（路由参数都是字符串） */
export const toNumberId = (id) => parseInt(String(id), 10);

/** 返回不含 password 字段的用户副本，避免敏感信息外泄 */
export const stripPassword = (user) => {
  if (!user) return null;
  const { password: _pw, ...rest } = user;
  return rest;
};

/** 读取用户密码哈希（登录 / 改密比对用） */
export const getUserPassword = (user) => user?.password;

export const getHotSearches = () => [...hotSearches];

export const getPointsRules = () => [...pointsRules];

/**
 * 初始化数据层：仅连接 Supabase。
 * 未配置 SUPABASE_URL / SUPABASE_SERVICE_KEY 时抛错，绝不回退到内存种子数据。
 */
export async function initDb() {
  await supabase.connect();
}

// ---------- 用户 ----------

export const findUserById = (id) => supabase.findUserById(toNumberId(id));

export const findUserByEmail = (email) => supabase.findUserByEmail(email);

/** 注册新用户：默认 user 角色，初始积分 0，密码哈希后存储 */
export async function createUser({ name, email, password, department }) {
  return supabase.insertUser({
    name,
    email,
    password: hash(password),
    roles: ["user"],
    department: department || "",
    avatar: "",
    points: 0,
  });
}

/** 修改密码：原密码校验由路由层完成，这里直接覆盖哈希 */
export async function updateUserPassword(userId, newPassword) {
  const id = toNumberId(userId);
  const user = await supabase.findUserById(id);
  if (!user) return false;
  await supabase.updateUser(id, { password: hash(newPassword) });
  return true;
}

/** 更新个人资料：仅修改传入字段，未传的字段保持不变，返回更新后的用户 */
export async function updateUserProfile(userId, { name, department, avatar }) {
  const id = toNumberId(userId);
  const user = await supabase.findUserById(id);
  if (!user) return null;
  await supabase.updateUser(id, { name, department, avatar });
  return supabase.findUserById(id);
}

// ---------- 文档 ----------

export const findDocument = (id) => supabase.findDocument(toNumberId(id));

/** 文档浏览量 +1（详情页访问时调用） */
export async function incrementDocumentViews(documentId) {
  const id = toNumberId(documentId);
  const doc = await supabase.findDocument(id);
  if (!doc) return null;
  const views = (doc.views || 0) + 1;
  await supabase.updateDocument(id, { views });
  return { ...doc, views };
}

/** 创建文档并写入第一个版本快照 */
export async function createDocument(data, author) {
  const now = formatDateTime();
  const doc = await supabase.insertDocument({
    title: data.title,
    content: data.content,
    authorId: author.id,
    authorName: author.name,
    category: data.category,
    tags: data.tags ?? [],
    status: data.status || "draft",
    views: 0,
    likes: 0,
    favorites: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await pushVersion(doc);
  return doc;
}

/** 从数据库删除文档及其版本 / 评论 / 点赞收藏关系 */
export async function removeDocument(documentId) {
  const id = toNumberId(documentId);
  const doc = await supabase.findDocument(id);
  if (!doc) return null;
  await supabase.deleteDocumentById(id);
  return doc;
}

/**
 * 更新文档：版本号 +1 并写入新的版本快照。
 * 注意：调用方需先做权限校验（作者本人或 admin）。
 */
export async function updateDocument(id, data) {
  const doc = await findDocument(id);
  if (!doc) return null;
  const updated = {
    ...doc,
    title: data.title,
    content: data.content,
    category: data.category,
    tags: data.tags ?? doc.tags,
    status: data.status || doc.status,
    version: (doc.version || 1) + 1,
    updatedAt: formatDateTime(),
  };
  await supabase.updateDocument(updated.id, {
    title: updated.title,
    content: updated.content,
    category: updated.category,
    tags: updated.tags,
    status: updated.status,
    version: updated.version,
    updated_at: updated.updatedAt,
  });
  await pushVersion(updated);
  return updated;
}

/** 写入版本快照 */
async function pushVersion(doc) {
  await supabase.insertDocumentVersion({
    documentId: doc.id,
    version: doc.version,
    title: doc.title,
    content: doc.content,
    category: doc.category,
    tags: [...doc.tags],
    authorName: doc.authorName,
    updatedAt: doc.updatedAt,
  });
}

/** 列出文档的版本历史（不含正文，前端按需查看） */
export async function getDocumentVersions(documentId) {
  const versions = await supabase.listDocumentVersions(toNumberId(documentId));
  return versions.map((v) => ({
    id: v.id,
    version: v.version,
    updatedAt: v.updatedAt,
    authorName: v.authorName,
  }));
}

/** 回滚到指定版本：用目标版本覆盖当前文档，版本号继续 +1，并写入新快照 */
export async function rollbackDocument(documentId, versionId) {
  const doc = await findDocument(documentId);
  if (!doc) return null;
  const target = await supabase.findDocumentVersion(
    doc.id,
    toNumberId(versionId),
  );
  if (!target) return null;
  const updated = {
    ...doc,
    title: target.title,
    content: target.content,
    category: target.category,
    tags: [...target.tags],
    version: (doc.version || 1) + 1,
    updatedAt: formatDateTime(),
  };
  await supabase.updateDocument(doc.id, {
    title: updated.title,
    content: updated.content,
    category: updated.category,
    tags: updated.tags,
    version: updated.version,
    updated_at: updated.updatedAt,
  });
  await pushVersion(updated);
  return updated;
}

/** 文档列表：排序 / 筛选 / 分页全部下推到 SQL 层 */
export const listDocuments = (opts) => supabase.listDocuments(opts);

// ---------- 点赞 / 收藏 ----------

/** 点赞文档：幂等，重复点赞返回 toggled:false；首次点赞给作者加积分 */
export async function likeDocument(documentId, userId) {
  const id = toNumberId(documentId);
  const doc = await supabase.findDocument(id);
  if (!doc) return null;
  if (await supabase.hasDocumentLike(id, userId)) return { toggled: false };
  await supabase.addDocumentLike(id, userId);
  await supabase.updateDocument(id, { likes: (doc.likes || 0) + 1 });
  await awardPoints(doc.authorId, "like", "文档被点赞");
  return { toggled: true };
}

/** 取消点赞：幂等，未点过赞返回 toggled:false；不会扣回积分 */
export async function unlikeDocument(documentId, userId) {
  const id = toNumberId(documentId);
  const doc = await supabase.findDocument(id);
  if (!doc) return null;
  if (!(await supabase.hasDocumentLike(id, userId))) return { toggled: false };
  await supabase.removeDocumentLike(id, userId);
  await supabase.updateDocument(id, {
    likes: Math.max(0, (doc.likes || 0) - 1),
  });
  return { toggled: true };
}

/** 收藏文档：幂等，首次收藏给作者加积分 */
export async function favoriteDocument(documentId, userId) {
  const id = toNumberId(documentId);
  const doc = await supabase.findDocument(id);
  if (!doc) return null;
  if (await supabase.hasDocumentFavorite(id, userId)) return { toggled: false };
  await supabase.addDocumentFavorite(id, userId);
  await supabase.updateDocument(id, { favorites: (doc.favorites || 0) + 1 });
  await awardPoints(doc.authorId, "favorite", "文档被收藏");
  return { toggled: true };
}

/** 取消收藏：幂等，不会扣回积分 */
export async function unfavoriteDocument(documentId, userId) {
  const id = toNumberId(documentId);
  const doc = await supabase.findDocument(id);
  if (!doc) return null;
  if (!(await supabase.hasDocumentFavorite(id, userId))) {
    return { toggled: false };
  }
  await supabase.removeDocumentFavorite(id, userId);
  await supabase.updateDocument(id, {
    favorites: Math.max(0, (doc.favorites || 0) - 1),
  });
  return { toggled: true };
}

/** 获取某用户收藏的文档（SQL 层分页），返回 { list, total } */
export async function getFavoriteDocuments(userId, { page, pageSize } = {}) {
  const ids = await supabase.listFavoriteDocumentIds(toNumberId(userId));
  if (!ids.length) return { list: [], total: 0 };
  return supabase.listDocuments({ ids, page, pageSize });
}

// ---------- 评论 ----------

/** 查找评论并校验其归属文档，避免跨文档误操作 */
export const findComment = (documentId, commentId) =>
  supabase.findCommentById(toNumberId(documentId), toNumberId(commentId));

/** 取某文档下的评论（含嵌套 replies 树） */
export const getComments = (documentId) =>
  supabase.listCommentsByDocument(toNumberId(documentId));

/** 创建评论：顶层评论，奖励积分 */
export async function createComment(documentId, content, user) {
  const comment = await supabase.insertComment(
    {
      documentId: toNumberId(documentId),
      userId: user.id,
      userName: user.name,
      content,
      likes: 0,
      createdAt: formatDateTime(),
    },
    null,
  );
  await awardPoints(user.id, "comment", "发布评论");
  return comment;
}

/** 回复评论：回复不奖励积分 */
export async function replyComment(documentId, commentId, content, user) {
  const parent = await findComment(documentId, commentId);
  if (!parent) return null;
  return supabase.insertComment(
    {
      documentId: toNumberId(documentId),
      userId: user.id,
      userName: user.name,
      content,
      likes: 0,
      createdAt: formatDateTime(),
    },
    parent.id,
  );
}

/** 删除评论：递归删除其后代评论与点赞关系 */
export async function deleteComment(documentId, commentId) {
  const comment = await findComment(documentId, commentId);
  if (!comment) return false;
  await supabase.deleteCommentById(comment.id);
  return true;
}

/** 点赞评论：幂等 */
export async function likeComment(documentId, commentId, userId) {
  const comment = await findComment(documentId, commentId);
  if (!comment) return null;
  if (await supabase.hasCommentLike(comment.id, userId)) {
    return { toggled: false };
  }
  await supabase.addCommentLike(comment.id, userId);
  await supabase.updateCommentLikes(comment.id, (comment.likes || 0) + 1);
  return { toggled: true };
}

// ---------- 积分 ----------

/**
 * 发放积分：根据 type 在 pointsRules 中查规则
 * - 累加到用户总积分
 * - 写一条积分明细记录，供明细页展示
 */
export async function awardPoints(userId, type, description) {
  const rule = pointsRules.find((r) => r.type === type);
  if (!rule) return;
  const user = await supabase.findUserById(toNumberId(userId));
  if (!user) return;
  await supabase.updateUser(user.id, {
    points: (user.points || 0) + rule.points,
  });
  await supabase.insertPointsRecord({
    userId: user.id,
    type,
    points: rule.points,
    description,
    createdAt: formatDateTime(),
  });
}

/** 积分排行榜：按积分倒序取前 limit 名，附 rank 序号 */
export async function getPointsRanking(limit = 10) {
  const users = await supabase.listUsersByPoints(limit);
  return users.map((u, i) => ({ ...stripPassword(u), rank: i + 1 }));
}

/** 用户积分明细（SQL 层分页），返回 { list, total } */
export async function getPointsDetail(userId, { page, pageSize } = {}) {
  return supabase.listPointsByUser(toNumberId(userId), { page, pageSize });
}

// ---------- 搜索历史 ----------

/** 记录搜索历史：去重后插入到最前，仅保留最近 10 条 */
export async function addSearchHistory(userId, keyword) {
  if (!keyword) return;
  const id = toNumberId(userId);
  const list = [...(await supabase.getSearchHistory(id))];
  const idx = list.indexOf(keyword);
  if (idx !== -1) list.splice(idx, 1); // 已存在则先移除，保证最近搜索在最前
  list.unshift(keyword);
  await supabase.setSearchHistory(id, list.slice(0, 10));
}

/** 读取用户搜索历史 */
export const getSearchHistory = (userId) =>
  supabase.getSearchHistory(toNumberId(userId));

/** 清除用户搜索历史 */
export const clearSearchHistory = (userId) =>
  supabase.deleteSearchHistory(toNumberId(userId));

// ---------- 用户统计 ----------

/** 用户统计：聚合其名下文档的点赞 / 收藏 / 浏览总数（仅取聚合所需列） */
export async function getUserStats(userId) {
  const docs = await supabase.listDocumentStats(toNumberId(userId));
  return {
    documents: docs.length,
    likes: docs.reduce((s, d) => s + d.likes, 0),
    favorites: docs.reduce((s, d) => s + d.favorites, 0),
    views: docs.reduce((s, d) => s + d.views, 0),
  };
}
