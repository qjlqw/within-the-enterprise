/**
 * Supabase 数据访问适配器（纯直查，无内存缓存）
 *
 * 职责：
 * - 通过 service_role key 连接 Supabase 项目（后端专用，绕过 RLS）。
 * - 提供各实体的查询 / 插入 / 更新 / 删除方法，全部直接读写 Supabase。
 * - 所有主键（users/documents/comments/points_records/document_versions）
 *   均由数据库 identity 自增，写入时不传 id。
 *
 * 表结构见 server/migrations/0001_supabase_schema.sql
 * 主键自增见 server/migrations/0002_supabase_identity_ids.sql
 */
let client = null;
let connected = false;

function ensureEnv() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_KEY not set");
  }
}

/**
 * 规范化项目 URL：用户可能误填成 REST 端点（末尾带 /rest/v1/），
 * 这里去掉该后缀，避免 supabase-js 拼出重复的 /rest/v1/ 路径。
 */
function normalizeUrl(url) {
  return String(url || "")
    .replace(/\/rest\/v1\/?$/, "")
    .replace(/\/+$/, "");
}

export async function connect() {
  if (connected && client) return client;
  ensureEnv();
  const { createClient } = await import("@supabase/supabase-js");
  client = createClient(
    normalizeUrl(process.env.SUPABASE_URL),
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } },
  );
  connected = true;
  return client;
}

export function isConnected() {
  return connected && !!client;
}

/** 解包 supabase 查询结果，出错时抛出；多行结果默认返回数组 */
function unwrap({ data, error }) {
  if (error) throw error;
  return data ?? [];
}

/** 解包 .single() 查询结果，出错时抛出；无结果返回 null */
function unwrapSingle({ data, error }) {
  if (error) throw error;
  return data ?? null;
}

// ---------- 行 ↔ 内存对象 映射 ----------
// 注意：写入行不包含 id（由数据库生成），读取行包含 id。

const toUserRow = (u) => ({
  name: u.name,
  email: u.email,
  password: u.password,
  roles: u.roles || [],
  department: u.department || "",
  avatar: u.avatar || "",
  points: u.points || 0,
});

const fromUserRow = (r) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  password: r.password,
  roles: r.roles || [],
  department: r.department || "",
  avatar: r.avatar || "",
  points: r.points || 0,
});

const toDocumentRow = (d) => ({
  title: d.title,
  content: d.content,
  author_id: d.authorId,
  author_name: d.authorName || "",
  category: d.category,
  tags: d.tags || [],
  status: d.status,
  views: d.views || 0,
  likes: d.likes || 0,
  favorites: d.favorites || 0,
  version: d.version || 1,
  created_at: d.createdAt,
  updated_at: d.updatedAt,
});

const fromDocumentRow = (r) => ({
  id: r.id,
  title: r.title,
  content: r.content,
  authorId: r.author_id,
  authorName: r.author_name || "",
  category: r.category,
  tags: r.tags || [],
  status: r.status,
  views: r.views || 0,
  likes: r.likes || 0,
  favorites: r.favorites || 0,
  version: r.version || 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toCommentRow = (c, parentId = null) => ({
  document_id: c.documentId,
  user_id: c.userId,
  user_name: c.userName || "",
  content: c.content,
  likes: c.likes || 0,
  parent_id: parentId,
  created_at: c.createdAt,
});

const toPointsRow = (r) => ({
  user_id: r.userId,
  type: r.type,
  points: r.points || 0,
  description: r.description || "",
  created_at: r.createdAt,
});

const fromPointsRow = (r) => ({
  id: r.id,
  userId: r.user_id,
  type: r.type,
  points: r.points || 0,
  description: r.description || "",
  createdAt: r.created_at,
});

const toVersionRow = (v) => ({
  document_id: v.documentId,
  version: v.version,
  title: v.title,
  content: v.content,
  category: v.category,
  tags: v.tags || [],
  author_name: v.authorName || "",
  updated_at: v.updatedAt,
});

const fromVersionRow = (r) => ({
  id: r.id,
  documentId: r.document_id,
  version: r.version,
  title: r.title,
  content: r.content,
  category: r.category,
  tags: r.tags || [],
  authorName: r.author_name || "",
  updatedAt: r.updated_at,
});

/** 将扁平评论行重建成嵌套树结构 */
function buildCommentTree(rows) {
  const byId = new Map();
  rows.forEach((r) => {
    byId.set(r.id, {
      id: r.id,
      documentId: r.document_id,
      userId: r.user_id,
      userName: r.user_name || "",
      content: r.content,
      likes: r.likes || 0,
      replies: [],
      createdAt: r.created_at,
      _parentId: r.parent_id ?? null,
    });
  });
  const roots = [];
  for (const c of byId.values()) {
    if (c._parentId != null && byId.has(c._parentId)) {
      byId.get(c._parentId).replies.push(c);
    } else {
      roots.push(c);
    }
  }
  const strip = (list) =>
    list.map(({ _parentId, ...rest }) => ({
      ...rest,
      replies: rest.replies.length ? strip(rest.replies) : [],
    }));
  return strip(roots);
}

// ---------- 用户 ----------

export async function findUserById(id) {
  if (!client) await connect();
  const row = await client.from("users").select("*").eq("id", id).maybeSingle();
  const data = unwrapSingle(row);
  return data ? fromUserRow(data) : null;
}

export async function findUserByEmail(email) {
  if (!client) await connect();
  const { data, error } = await client
    .from("users")
    .select("*")
    .eq("email", email)
    .maybeSingle();
  if (error) throw error;
  return data ? fromUserRow(data) : null;
}

export async function insertUser(user) {
  if (!client) await connect();
  const { data, error } = await client
    .from("users")
    .insert(toUserRow(user))
    .select()
    .single();
  if (error) throw error;
  return fromUserRow(data);
}

export async function updateUser(id, patch) {
  if (!client) await connect();
  // 仅允许更新白名单字段，避免误写 id 等不可变列
  const allowed = [
    "name",
    "email",
    "password",
    "roles",
    "department",
    "avatar",
    "points",
  ];
  const row = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) row[key] = patch[key];
  }
  if (Object.keys(row).length === 0) return;
  const { error } = await client.from("users").update(row).eq("id", id);
  if (error) throw error;
}

/** 按积分倒序取前 limit 名（排行榜用） */
export async function listUsersByPoints(limit) {
  if (!client) await connect();
  const { data, error } = await client
    .from("users")
    .select("*")
    .order("points", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(fromUserRow);
}

// ---------- 文档 ----------

export async function findDocument(id) {
  if (!client) await connect();
  const { data, error } = await client
    .from("documents")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? fromDocumentRow(data) : null;
}

export async function insertDocument(doc) {
  if (!client) await connect();
  const { data, error } = await client
    .from("documents")
    .insert(toDocumentRow(doc))
    .select()
    .single();
  if (error) throw error;
  return fromDocumentRow(data);
}

export async function updateDocument(id, patch) {
  if (!client) await connect();
  const { error } = await client
    .from("documents")
    .update(patch)
    .eq("id", id);
  if (error) throw error;
}

export async function deleteDocumentById(id) {
  if (!client) await connect();
  const { data: commentRows, error: commentErr } = await client
    .from("comments")
    .select("id")
    .eq("document_id", id);
  if (commentErr) throw commentErr;
  const commentIds = (commentRows || []).map((c) => c.id);

  const ops = [
    client.from("document_versions").delete().eq("document_id", id),
    client.from("document_likes").delete().eq("document_id", id),
    client.from("document_favorites").delete().eq("document_id", id),
    client.from("comments").delete().eq("document_id", id),
  ];
  if (commentIds.length) {
    ops.push(client.from("comment_likes").delete().in("comment_id", commentIds));
  }
  const results = await Promise.all(ops);
  for (const { error } of results) if (error) throw error;

  const { error } = await client.from("documents").delete().eq("id", id);
  if (error) throw error;
}

/** 文档排序字段白名单：前端字段名 → 数据库列名 */
const DOCUMENT_SORT_COLUMNS = {
  id: "id",
  createdAt: "created_at",
  updatedAt: "updated_at",
  views: "views",
  likes: "likes",
  favorites: "favorites",
};

/** 清洗关键词，避免破坏 PostgREST 的 or/cs 过滤语法 */
function cleanKeyword(keyword) {
  return String(keyword || "")
    .replace(/[%_(),"'[\]]/g, "")
    .trim();
}

/**
 * 列表查询文档，排序 / 筛选 / 分页全部下推到 SQL 层。
 * @param {Object} opts
 * @param {string} [opts.status]    draft | published
 * @param {string} [opts.category]
 * @param {string} [opts.keyword]   标题/内容 ilike 命中，标签 cs 精确命中
 * @param {string} [opts.sortBy]    id/createdAt/updatedAt/views/likes/favorites
 * @param {string} [opts.order]     asc | desc
 * @param {number} [opts.page]
 * @param {number} [opts.pageSize]
 * @param {number} [opts.authorId]
 * @param {number[]} [opts.ids]     限定 id 集合（收藏列表反查）
 * @returns {Promise<{ list: Object[], total: number }>}
 */
export async function listDocuments({
  status,
  category,
  keyword,
  sortBy = "updatedAt",
  order = "desc",
  page,
  pageSize,
  authorId,
  ids,
} = {}) {
  if (!client) await connect();
  let query = client.from("documents").select("*", { count: "exact" });

  if (status) query = query.eq("status", status);
  if (category) query = query.eq("category", category);
  if (authorId != null) query = query.eq("author_id", authorId);
  if (ids && ids.length) query = query.in("id", ids);

  const kw = cleanKeyword(keyword);
  if (kw) {
    query = query.or(
      `title.ilike.%${kw}%,content.ilike.%${kw}%,tags.cs.${JSON.stringify([kw])}`,
    );
  }

  const column = DOCUMENT_SORT_COLUMNS[sortBy] || "updated_at";
  query = query.order(column, { ascending: order !== "desc" });

  if (Number.isInteger(page) && Number.isInteger(pageSize) && pageSize > 0) {
    const from = (page - 1) * pageSize;
    query = query.range(from, from + pageSize - 1);
  }

  const { data, error, count } = await query;
  if (error) throw error;
  return {
    list: (data || []).map(fromDocumentRow),
    total: count ?? (data || []).length,
  };
}

/** 取某作者名下文档的聚合所需列（统计用，仅返回 likes/favorites/views） */
export async function listDocumentStats(authorId) {
  if (!client) await connect();
  const { data, error } = await client
    .from("documents")
    .select("likes, favorites, views")
    .eq("author_id", authorId);
  if (error) throw error;
  return (data || []).map((r) => ({
    likes: r.likes || 0,
    favorites: r.favorites || 0,
    views: r.views || 0,
  }));
}

// ---------- 文档版本 ----------

export async function insertDocumentVersion(version) {
  if (!client) await connect();
  const { data, error } = await client
    .from("document_versions")
    .insert(toVersionRow(version))
    .select()
    .single();
  if (error) throw error;
  return fromVersionRow(data);
}

export async function listDocumentVersions(documentId) {
  if (!client) await connect();
  const { data, error } = await client
    .from("document_versions")
    .select("*")
    .eq("document_id", documentId)
    .order("id", { ascending: false });
  if (error) throw error;
  return (data || []).map(fromVersionRow);
}

export async function findDocumentVersion(documentId, versionId) {
  if (!client) await connect();
  const { data, error } = await client
    .from("document_versions")
    .select("*")
    .eq("document_id", documentId)
    .eq("id", versionId)
    .maybeSingle();
  if (error) throw error;
  return data ? fromVersionRow(data) : null;
}

// ---------- 评论 ----------

export async function listCommentsByDocument(documentId) {
  if (!client) await connect();
  const { data, error } = await client
    .from("comments")
    .select("*")
    .eq("document_id", documentId)
    .order("id", { ascending: true });
  if (error) throw error;
  return buildCommentTree(data || []);
}

export async function findCommentById(documentId, commentId) {
  if (!client) await connect();
  const { data, error } = await client
    .from("comments")
    .select("*")
    .eq("document_id", documentId)
    .eq("id", commentId)
    .maybeSingle();
  if (error) throw error;
  return data
    ? {
        id: data.id,
        documentId: data.document_id,
        userId: data.user_id,
        userName: data.user_name || "",
        content: data.content,
        likes: data.likes || 0,
        parentId: data.parent_id ?? null,
        createdAt: data.created_at,
      }
    : null;
}

export async function insertComment(comment, parentId = null) {
  if (!client) await connect();
  const { data, error } = await client
    .from("comments")
    .insert(toCommentRow(comment, parentId))
    .select()
    .single();
  if (error) throw error;
  return {
    id: data.id,
    documentId: data.document_id,
    userId: data.user_id,
    userName: data.user_name || "",
    content: data.content,
    likes: data.likes || 0,
    replies: [],
    createdAt: data.created_at,
  };
}

export async function updateCommentLikes(commentId, likes) {
  if (!client) await connect();
  const { error } = await client
    .from("comments")
    .update({ likes })
    .eq("id", commentId);
  if (error) throw error;
}

export async function deleteCommentById(id) {
  if (!client) await connect();
  // 收集该评论及其全部后代 id
  const { data: all, error: selErr } = await client
    .from("comments")
    .select("id, parent_id");
  if (selErr) throw selErr;
  const ids = new Set([Number(id)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of all || []) {
      if (ids.has(row.parent_id) && !ids.has(row.id)) {
        ids.add(row.id);
        changed = true;
      }
    }
  }
  const idList = [...ids];
  const { error: likeErr } = await client
    .from("comment_likes")
    .delete()
    .in("comment_id", idList);
  if (likeErr) throw likeErr;
  const { error } = await client.from("comments").delete().in("id", idList);
  if (error) throw error;
}

// ---------- 点赞 / 收藏 关系 ----------

export async function hasDocumentLike(documentId, userId) {
  if (!client) await connect();
  const { data, error } = await client
    .from("document_likes")
    .select("document_id")
    .eq("document_id", documentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function addDocumentLike(documentId, userId) {
  if (!client) await connect();
  const { error } = await client
    .from("document_likes")
    .upsert({ document_id: documentId, user_id: userId });
  if (error) throw error;
}

export async function removeDocumentLike(documentId, userId) {
  if (!client) await connect();
  const { error } = await client
    .from("document_likes")
    .delete()
    .eq("document_id", documentId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function hasDocumentFavorite(documentId, userId) {
  if (!client) await connect();
  const { data, error } = await client
    .from("document_favorites")
    .select("document_id")
    .eq("document_id", documentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function addDocumentFavorite(documentId, userId) {
  if (!client) await connect();
  const { error } = await client
    .from("document_favorites")
    .upsert({ document_id: documentId, user_id: userId });
  if (error) throw error;
}

export async function removeDocumentFavorite(documentId, userId) {
  if (!client) await connect();
  const { error } = await client
    .from("document_favorites")
    .delete()
    .eq("document_id", documentId)
    .eq("user_id", userId);
  if (error) throw error;
}

/** 返回某用户收藏的文档 id 列表 */
export async function listFavoriteDocumentIds(userId) {
  if (!client) await connect();
  const { data, error } = await client
    .from("document_favorites")
    .select("document_id")
    .eq("user_id", userId);
  if (error) throw error;
  return (data || []).map((r) => r.document_id);
}

export async function hasCommentLike(commentId, userId) {
  if (!client) await connect();
  const { data, error } = await client
    .from("comment_likes")
    .select("comment_id")
    .eq("comment_id", commentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function addCommentLike(commentId, userId) {
  if (!client) await connect();
  const { error } = await client
    .from("comment_likes")
    .upsert({ comment_id: commentId, user_id: userId });
  if (error) throw error;
}

// ---------- 积分 ----------

export async function insertPointsRecord(record) {
  if (!client) await connect();
  const { error } = await client
    .from("points_records")
    .insert(toPointsRow(record));
  if (error) throw error;
}

export async function listPointsByUser(userId, { page, pageSize } = {}) {
  if (!client) await connect();
  let query = client
    .from("points_records")
    .select("*", { count: "exact" })
    .eq("user_id", userId)
    .order("id", { ascending: false });
  if (Number.isInteger(page) && Number.isInteger(pageSize) && pageSize > 0) {
    const from = (page - 1) * pageSize;
    query = query.range(from, from + pageSize - 1);
  }
  const { data, error, count } = await query;
  if (error) throw error;
  return {
    list: (data || []).map(fromPointsRow),
    total: count ?? (data || []).length,
  };
}

// ---------- 搜索历史 ----------

export async function getSearchHistory(userId) {
  if (!client) await connect();
  const { data, error } = await client
    .from("search_history")
    .select("keywords")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.keywords || [];
}

export async function setSearchHistory(userId, keywords) {
  if (!client) await connect();
  const { error } = await client
    .from("search_history")
    .upsert({ user_id: userId, keywords: keywords || [] });
  if (error) throw error;
}

export async function deleteSearchHistory(userId) {
  if (!client) await connect();
  const { error } = await client
    .from("search_history")
    .delete()
    .eq("user_id", userId);
  if (error) throw error;
}

export default {
  connect,
  isConnected,
  findUserById,
  findUserByEmail,
  insertUser,
  updateUser,
  listUsersByPoints,
  findDocument,
  insertDocument,
  updateDocument,
  deleteDocumentById,
  listDocuments,
  listDocumentStats,
  insertDocumentVersion,
  listDocumentVersions,
  findDocumentVersion,
  listCommentsByDocument,
  findCommentById,
  insertComment,
  updateCommentLikes,
  deleteCommentById,
  hasDocumentLike,
  addDocumentLike,
  removeDocumentLike,
  hasDocumentFavorite,
  addDocumentFavorite,
  removeDocumentFavorite,
  listFavoriteDocumentIds,
  hasCommentLike,
  addCommentLike,
  insertPointsRecord,
  listPointsByUser,
  getSearchHistory,
  setSearchHistory,
  deleteSearchHistory,
};
