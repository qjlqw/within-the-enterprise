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
  token_version: u.tokenVersion || 0,
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
  tokenVersion: r.token_version ?? 0,
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
  storage: d.storage ?? null,
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
  extractedVersion: r.extracted_version ?? null,
  storage: r.storage ?? null,
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

/**
 * 递增用户 token 版本号并返回最新值。
 * 鉴权中间件会比对 JWT 中的 tv 与数据库版本，改密/禁用后旧 Token 立即失效。
 */
export async function bumpUserTokenVersion(id) {
  if (!client) await connect();
  const { data, error } = await client.rpc("bump_user_token_version", {
    p_user_id: id,
  });
  if (error) throw error;
  return Number(data) || 0;
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

/**
 * 写入文档的原始文件存储元数据（单次 UPDATE，原子覆盖）。
 * storage 为 null 表示清除记录。
 */
export async function setDocumentStorage(id, storage, updatedAt) {
  if (!client) await connect();
  const patch = { storage };
  if (updatedAt) patch.updated_at = updatedAt;
  const { error } = await client.from("documents").update(patch).eq("id", id);
  if (error) throw error;
}

/** 标记某文档已完成抽取的版本，用于抽取幂等（同一版本重复入队直接跳过） */
export async function setDocumentExtractedVersion(id, version) {
  if (!client) await connect();
  const { error } = await client
    .from("documents")
    .update({ extracted_version: version })
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

/** 清洗关键词，避免破坏 PostgREST 的 or/cs 过滤语法（含值内逗号、反斜杠、通配符等） */
function cleanKeyword(keyword) {
  return String(keyword || "")
    .replace(/[%_(),"'[\]*\\.]/g, "")
    .trim();
}

/** 单个关键词在 or 表达式中的最大长度，避免表达式超长 */
const MAX_KEYWORD_LENGTH = 40;
/** 多关键词检索允许的最大关键词个数 */
const MAX_KEYWORD_COUNT = 12;

/**
 * 把多个关键词合并成单个 or 过滤表达式：
 * title.ilike.%kw% OR content.ilike.%kw% OR tags.cs.["kw"]（每个关键词三路命中）
 * @param {string[]} keywords 已清洗的关键词列表
 */
function buildKeywordOrExpression(keywords) {
  const parts = keywords.flatMap((kw) => [
    `title.ilike.%${kw}%`,
    `content.ilike.%${kw}%`,
    `tags.cs.${JSON.stringify([kw])}`,
  ]);
  return parts.join(",");
}

/**
 * 列表查询文档，排序 / 筛选 / 分页全部下推到 SQL 层。
 * @param {Object} opts
 * @param {string} [opts.status]    draft | published
 * @param {string} [opts.category]
 * @param {string} [opts.keyword]   标题/内容 ilike 命中，标签 cs 精确命中
 * @param {string[]} [opts.keywords] 多关键词检索：任一关键词命中即返回（与 keyword 互不冲突，合并过滤）
 * @param {string} [opts.sortBy]    id/createdAt/updatedAt/views/likes/favorites
 * @param {string} [opts.order]     asc | desc
 * @param {number} [opts.page]
 * @param {number} [opts.pageSize]
 * @param {number} [opts.authorId]
 * @param {number[]} [opts.ids]     限定 id 集合（收藏列表反查）
 * @param {number} [opts.viewerId]  当前访问者 id（用于草稿可见性过滤）
 * @param {boolean} [opts.viewerIsAdmin] 当前访问者是否 admin（admin 可见全部草稿）
 * @returns {Promise<{ list: Object[], total: number }>}
 */
export async function listDocuments({
  status,
  category,
  keyword,
  keywords,
  sortBy = "updatedAt",
  order = "desc",
  page,
  pageSize,
  authorId,
  ids,
  viewerId,
  viewerIsAdmin = false,
} = {}) {
  if (!client) await connect();
  let query = client.from("documents").select("*", { count: "exact" });

  // 草稿可见性：显式 status 优先；否则按访问者身份过滤，避免把草稿读入内存再筛
  if (status) {
    query = query.eq("status", status);
  } else if (viewerIsAdmin) {
    // admin 可见全部（含所有草稿），不加状态过滤
  } else if (viewerId != null) {
    // 登录用户：已发布文档 + 本人名下（含草稿）
    query = query.or(`status.eq.published,author_id.eq.${viewerId}`);
  } else {
    // 匿名用户：仅已发布文档
    query = query.eq("status", "published");
  }
  if (category) query = query.eq("category", category);
  if (authorId != null) query = query.eq("author_id", authorId);
  if (ids && ids.length) query = query.in("id", ids);

  const kw = cleanKeyword(keyword);
  if (kw) {
    query = query.or(
      `title.ilike.%${kw}%,content.ilike.%${kw}%,tags.cs.${JSON.stringify([kw])}`,
    );
  }

  // 多关键词检索（检索下推用）：全部合并进同一个 or 表达式，任一命中即返回
  if (Array.isArray(keywords) && keywords.length) {
    const cleaned = [
      ...new Set(
        keywords
          .slice(0, MAX_KEYWORD_COUNT)
          .map(cleanKeyword)
          .filter(Boolean)
          .map((kw2) => kw2.slice(0, MAX_KEYWORD_LENGTH)),
      ),
    ];
    if (cleaned.length) {
      query = query.or(buildKeywordOrExpression(cleaned));
    }
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

/**
 * 设置点赞状态：关系写入与计数变更在同一数据库函数内原子完成。
 * @returns {Promise<boolean>} 是否真的发生了状态变更（重复请求返回 false）
 */
export async function setDocumentLike(documentId, userId, on) {
  if (!client) await connect();
  const { data, error } = await client.rpc("toggle_document_like", {
    p_document_id: documentId,
    p_user_id: userId,
    p_on: on,
  });
  if (error) throw error;
  return Boolean(data);
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

/** 设置收藏状态：关系与计数在同一数据库函数内原子完成 */
export async function setDocumentFavorite(documentId, userId, on) {
  if (!client) await connect();
  const { data, error } = await client.rpc("toggle_document_favorite", {
    p_document_id: documentId,
    p_user_id: userId,
    p_on: on,
  });
  if (error) throw error;
  return Boolean(data);
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

/**
 * 原子发放积分：写明细（按 businessKey 幂等）+ 累加用户总积分在同一函数内完成。
 * @returns {Promise<boolean>} 是否本次真正发放（业务键重复时返回 false）
 */
export async function awardUserPoints({
  userId,
  type,
  points,
  description,
  businessKey,
  createdAt,
}) {
  if (!client) await connect();
  const { data, error } = await client.rpc("award_user_points", {
    p_user_id: userId,
    p_type: type,
    p_points: points,
    p_description: description || "",
    p_business_key: businessKey || null,
    p_created_at: createdAt,
  });
  if (error) throw error;
  return Boolean(data);
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

// ---------- 对象存储删除 outbox ----------
// 文档删除时先落一条待执行任务，再由后台 worker 重试调用对象存储删除接口，
// 保证进程重启 / 对象存储临时故障后仍能清理原始文件（不产生孤儿文件）。

const STORAGE_DELETION_TABLE = "storage_deletion_outbox";

function fromStorageDeletionRow(r) {
  return {
    id: r.id,
    documentId: r.document_id,
    driver: r.driver,
    fileId: r.file_id,
    fileName: r.file_name,
    status: r.status,
    attempts: r.attempts ?? 0,
    nextAttemptAt: r.next_attempt_at,
    lockedAt: r.locked_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 写入一条待执行的删除任务（status=pending，立即可被 worker 领取） */
export async function enqueueStorageDeletionJob({
  documentId,
  driver,
  fileId,
  fileName,
  now,
}) {
  if (!client) await connect();
  const { data, error } = await client
    .from(STORAGE_DELETION_TABLE)
    .insert({
      document_id: documentId,
      driver,
      file_id: fileId,
      file_name: fileName,
      status: "pending",
      attempts: 0,
      next_attempt_at: now,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();
  if (error) throw error;
  return fromStorageDeletionRow(data);
}

/**
 * 领取到期任务（最多 limit 条）：
 * 1. 回收锁超时的 processing（进程崩溃遗留），避免任务永久卡死
 * 2. 查询 next_attempt_at 已到的 pending
 * 3. 逐条 CAS 置为 processing，多实例下同一条任务只会被一个进程领取
 */
export async function claimDueStorageDeletionJobs({
  limit,
  now,
  staleBefore,
}) {
  if (!client) await connect();
  const { error: staleError } = await client
    .from(STORAGE_DELETION_TABLE)
    .update({ status: "pending", locked_at: null, updated_at: now })
    .eq("status", "processing")
    .lt("locked_at", staleBefore);
  if (staleError) throw staleError;

  const { data: candidates, error } = await client
    .from(STORAGE_DELETION_TABLE)
    .select("*")
    .eq("status", "pending")
    .lte("next_attempt_at", now)
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  const claimed = [];
  for (const row of candidates || []) {
    const { data, error: claimError } = await client
      .from(STORAGE_DELETION_TABLE)
      .update({ status: "processing", locked_at: now, updated_at: now })
      .eq("id", row.id)
      .eq("status", "pending")
      .select();
    if (claimError) throw claimError;
    if (data?.length) claimed.push(fromStorageDeletionRow(data[0]));
  }
  return claimed;
}

/** 删除成功：标记 done */
export async function completeStorageDeletionJob(id, { attempts, now }) {
  if (!client) await connect();
  const { error } = await client
    .from(STORAGE_DELETION_TABLE)
    .update({
      status: "done",
      attempts,
      locked_at: null,
      last_error: null,
      updated_at: now,
    })
    .eq("id", id);
  if (error) throw error;
}

/** 删除失败但还未到上限：回到 pending 并推迟到 nextAttemptAt */
export async function rescheduleStorageDeletionJob(
  id,
  { attempts, nextAttemptAt, lastError, now },
) {
  if (!client) await connect();
  const { error } = await client
    .from(STORAGE_DELETION_TABLE)
    .update({
      status: "pending",
      attempts,
      next_attempt_at: nextAttemptAt,
      locked_at: null,
      last_error: lastError,
      updated_at: now,
    })
    .eq("id", id);
  if (error) throw error;
}

/** 重试次数耗尽：标记 failed，等待人工处理 / 手动重试 */
export async function failStorageDeletionJob(
  id,
  { attempts, lastError, now },
) {
  if (!client) await connect();
  const { error } = await client
    .from(STORAGE_DELETION_TABLE)
    .update({
      status: "failed",
      attempts,
      locked_at: null,
      last_error: lastError,
      updated_at: now,
    })
    .eq("id", id);
  if (error) throw error;
}

/** 手动重试：重置 attempts 并立即到期 */
export async function requeueStorageDeletionJob(id, { now }) {
  if (!client) await connect();
  const { data, error } = await client
    .from(STORAGE_DELETION_TABLE)
    .update({
      status: "pending",
      attempts: 0,
      next_attempt_at: now,
      locked_at: null,
      last_error: null,
      updated_at: now,
    })
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data ? fromStorageDeletionRow(data) : null;
}

/** 最近的任务列表（按创建时间倒序），用于可观测性排查 */
export async function listStorageDeletionJobs({ status, limit = 20 } = {}) {
  if (!client) await connect();
  let query = client
    .from(STORAGE_DELETION_TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(fromStorageDeletionRow);
}

/** 各状态任务数量（可观测性 /metrics 使用） */
export async function getStorageDeletionStats() {
  if (!client) await connect();
  const statuses = ["pending", "processing", "done", "failed"];
  const counts = await Promise.all(
    statuses.map(async (status) => {
      const { count, error } = await client
        .from(STORAGE_DELETION_TABLE)
        .select("id", { count: "exact", head: true })
        .eq("status", status);
      if (error) throw error;
      return [status, count ?? 0];
    }),
  );
  const stats = Object.fromEntries(counts);
  return {
    ...stats,
    total: statuses.reduce((sum, status) => sum + stats[status], 0),
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

// ---------- 实体 / 关系（LLM Wiki） ----------

const toEntityRow = (e) => ({
  name: e.name,
  type: e.type || "",
  aliases: e.aliases || [],
  summary: e.summary || "",
  sources: e.sources || [],
  status: e.status || "pending",
  summary_by_source: e.summaryBySource || {},
  needs_review: e.needsReview === true,
  updated_at: e.updatedAt || null,
});

const fromEntityRow = (r) => ({
  id: r.id,
  name: r.name,
  type: r.type || "",
  aliases: r.aliases || [],
  summary: r.summary || "",
  sources: r.sources || [],
  status: r.status || "pending",
  // 各来源文档给出的摘要口径，供审核时对比（迁移 0006 前为 {}）
  summaryBySource: r.summary_by_source || {},
  // 摘要口径冲突、需人工复检
  needsReview: r.needs_review === true,
  updatedAt: r.updated_at || null,
});

const toRelationRow = (rel) => ({
  subject_id: rel.subjectId,
  predicate: rel.predicate,
  object_id: rel.objectId,
  sources: rel.sources || [],
  status: rel.status || "pending",
  updated_at: rel.updatedAt || null,
});

const fromRelationRow = (r) => ({
  id: r.id,
  subjectId: r.subject_id,
  predicate: r.predicate,
  objectId: r.object_id,
  sources: r.sources || [],
  status: r.status || "pending",
  updatedAt: r.updated_at || null,
});

export async function insertEntity(entity) {
  if (!client) await connect();
  const { data, error } = await client
    .from("entities")
    .insert(toEntityRow(entity))
    .select()
    .single();
  if (error) throw error;
  return fromEntityRow(data);
}

/** 更新实体：仅写入 patch 中出现的字段（避免未传字段被覆盖为默认值） */
export async function updateEntity(id, patch) {
  if (!client) await connect();
  const row = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.type !== undefined) row.type = patch.type;
  if (patch.aliases !== undefined) row.aliases = patch.aliases;
  if (patch.summary !== undefined) row.summary = patch.summary;
  if (patch.sources !== undefined) row.sources = patch.sources;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.summaryBySource !== undefined) row.summary_by_source = patch.summaryBySource;
  if (patch.needsReview !== undefined) row.needs_review = patch.needsReview === true;
  if (patch.updatedAt !== undefined) row.updated_at = patch.updatedAt;
  if (Object.keys(row).length === 0) return;
  const { error } = await client.from("entities").update(row).eq("id", id);
  if (error) throw error;
}

/**
 * 条件更新实体：仅当当前状态等于 expectedStatus 时才写入。
 * 用于 confirm/reject 的并发保护，避免两个审核人同时操作时相互覆盖。
 * @returns {Promise<object|null>} 更新后的实体；条件不满足（已被他人改变）返回 null
 */
export async function updateEntityIfStatus(id, expectedStatus, patch) {
  if (!client) await connect();
  const row = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.summaryBySource !== undefined) row.summary_by_source = patch.summaryBySource;
  if (patch.needsReview !== undefined) row.needs_review = patch.needsReview === true;
  if (patch.updatedAt !== undefined) row.updated_at = patch.updatedAt;
  if (Object.keys(row).length === 0) return null;
  const { data, error } = await client
    .from("entities")
    .update(row)
    .eq("id", id)
    .eq("status", expectedStatus)
    .select();
  if (error) throw error;
  return data && data.length ? fromEntityRow(data[0]) : null;
}

/** 查询 sources 中包含指定文档的实体（文档下线/删除后清理引用用） */
export async function listEntitiesBySource(docId) {
  if (!client) await connect();
  const { data, error } = await client
    .from("entities")
    .select("*")
    .contains("sources", [docId]);
  if (error) throw error;
  return (data || []).map(fromEntityRow);
}

export async function findEntity(id) {
  if (!client) await connect();
  const { data, error } = await client
    .from("entities")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? fromEntityRow(data) : null;
}

/** 按名称（大小写不敏感）查实体，供去重使用 */
export async function findEntityByName(name) {
  if (!client) await connect();
  // 迁移 0006 之前可能存在同名重复行，这里取最早一条，避免 maybeSingle 多行报错
  const { data, error } = await client
    .from("entities")
    .select("*")
    .ilike("name", name)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? fromEntityRow(data) : null;
}

export async function listEntities({ status, page, pageSize } = {}) {
  if (!client) await connect();
  let query = client
    .from("entities")
    .select("*", { count: "exact" })
    .order("id", { ascending: false });
  if (status) query = query.eq("status", status);
  if (Number.isInteger(page) && Number.isInteger(pageSize) && pageSize > 0) {
    const from = (page - 1) * pageSize;
    query = query.range(from, from + pageSize - 1);
  }
  const { data, error, count } = await query;
  if (error) throw error;
  return {
    list: (data || []).map(fromEntityRow),
    total: count ?? (data || []).length,
  };
}

/** 删除实体并清理引用该实体的关系 */
export async function deleteEntityById(id) {
  if (!client) await connect();
  const { error: relErr } = await client
    .from("relations")
    .delete()
    .or(`subject_id.eq.${id},object_id.eq.${id}`);
  if (relErr) throw relErr;
  const { error } = await client.from("entities").delete().eq("id", id);
  if (error) throw error;
}

export async function insertRelation(relation) {
  if (!client) await connect();
  const { data, error } = await client
    .from("relations")
    .insert(toRelationRow(relation))
    .select()
    .single();
  if (error) throw error;
  return fromRelationRow(data);
}

/** 更新关系：仅写入 patch 中出现的字段 */
export async function updateRelation(id, patch) {
  if (!client) await connect();
  const { error } = await client
    .from("relations")
    .update({
      sources: patch.sources,
      status: patch.status,
      updated_at: patch.updatedAt,
    })
    .eq("id", id);
  if (error) throw error;
}

/**
 * 条件更新关系：仅当当前状态等于 expectedStatus 时才写入。
 * 用于 confirm/reject 的并发保护，避免两个审核人同时操作时相互覆盖。
 * @returns {Promise<object|null>} 更新后的关系；条件不满足（已被他人改变）返回 null
 */
export async function updateRelationIfStatus(id, expectedStatus, patch) {
  if (!client) await connect();
  const row = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.sources !== undefined) row.sources = patch.sources;
  if (patch.updatedAt !== undefined) row.updated_at = patch.updatedAt;
  if (Object.keys(row).length === 0) return null;
  const { data, error } = await client
    .from("relations")
    .update(row)
    .eq("id", id)
    .eq("status", expectedStatus)
    .select();
  if (error) throw error;
  return data && data.length ? fromRelationRow(data[0]) : null;
}

export async function deleteRelationById(id) {
  if (!client) await connect();
  const { error } = await client.from("relations").delete().eq("id", id);
  if (error) throw error;
}

/** 查询 sources 中包含指定文档的关系（文档下线/删除后清理引用用） */
export async function listRelationsBySource(docId) {
  if (!client) await connect();
  const { data, error } = await client
    .from("relations")
    .select("*")
    .contains("sources", [docId]);
  if (error) throw error;
  return (data || []).map(fromRelationRow);
}

export async function listRelations({ status, subjectId, objectId } = {}) {
  if (!client) await connect();
  let query = client.from("relations").select("*").order("id", { ascending: false });
  if (status) query = query.eq("status", status);
  if (subjectId != null) query = query.eq("subject_id", subjectId);
  if (objectId != null) query = query.eq("object_id", objectId);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(fromRelationRow);
}

// ---------- 用量计量（成本治理 B7） ----------

/**
 * 写入一条用量事件。
 * @param {Object} event
 * @param {number} event.userId
 * @param {string} event.kind          agent_run | embedding | rerank | extraction
 * @param {number|null} [event.tokensIn]  上游未返回时不计（null）
 * @param {number|null} [event.tokensOut]
 * @param {number|null} [event.chars]     输入字符量（字符口径兜底计量）
 * @param {Object} [event.meta]
 */
export async function insertUsageEvent({
  userId,
  kind,
  tokensIn,
  tokensOut,
  chars,
  meta,
} = {}) {
  if (!client) await connect();
  const { data, error } = await client
    .from("usage_events")
    .insert({
      user_id: userId,
      kind,
      tokens_in: tokensIn ?? null,
      tokens_out: tokensOut ?? null,
      chars: chars ?? null,
      meta: meta || {},
    })
    .select()
    .single();
  if (error) throw error;
  return {
    id: data.id,
    userId: data.user_id,
    kind: data.kind,
    tokensIn: data.tokens_in,
    tokensOut: data.tokens_out,
    chars: data.chars,
    meta: data.meta || {},
    createdAt: data.created_at,
  };
}

/**
 * 拉取 since（ISO 时间）之后的原始用量行，由 service 层做 JS 聚合。
 * @param {string} sinceIso
 * @returns {Promise<Array<{ userId, kind, tokensIn, tokensOut, chars, createdAt }>>}
 */
export async function sumUsageSince(sinceIso) {
  if (!client) await connect();
  const { data, error } = await client
    .from("usage_events")
    .select("user_id, kind, tokens_in, tokens_out, chars, created_at")
    .gte("created_at", sinceIso)
    .limit(50000);
  if (error) throw error;
  return (data || []).map((r) => ({
    userId: r.user_id,
    kind: r.kind,
    tokensIn: r.tokens_in ?? 0,
    tokensOut: r.tokens_out ?? 0,
    chars: r.chars ?? 0,
    createdAt: r.created_at,
  }));
}

// ---------- 历史问答（QA 长期记忆） ----------

const toQaRow = (qa) => ({
  question: qa.question,
  answer: qa.answer,
  sources: qa.sources || [],
  user_id: qa.userId,
  session_id: qa.sessionId || "",
  message_id: qa.messageId,
  status: qa.status || "pending",
  score: qa.score ?? 0,
  embedding: qa.embedding || [],
  created_at: qa.createdAt || null,
  updated_at: qa.updatedAt || null,
});

const fromQaRow = (r) => ({
  id: r.id,
  question: r.question,
  answer: r.answer,
  sources: r.sources || [],
  userId: r.user_id,
  sessionId: r.session_id || "",
  messageId: r.message_id,
  status: r.status || "pending",
  score: r.score ?? 0,
  embedding: r.embedding || [],
  createdAt: r.created_at || null,
  updatedAt: r.updated_at || null,
});

export async function insertQa(qa) {
  if (!client) await connect();
  const { data, error } = await client
    .from("qa_memory")
    .insert(toQaRow(qa))
    .select()
    .single();
  if (error) throw error;
  return fromQaRow(data);
}

/** 更新 QA：仅写入 patch 中出现的字段 */
export async function updateQa(id, patch) {
  if (!client) await connect();
  const row = {};
  if (patch.question !== undefined) row.question = patch.question;
  if (patch.answer !== undefined) row.answer = patch.answer;
  if (patch.sources !== undefined) row.sources = patch.sources;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.score !== undefined) row.score = patch.score;
  if (patch.embedding !== undefined) row.embedding = patch.embedding;
  if (patch.updatedAt !== undefined) row.updated_at = patch.updatedAt;
  if (Object.keys(row).length === 0) return;
  const { error } = await client.from("qa_memory").update(row).eq("id", id);
  if (error) throw error;
}

export async function findQa(id) {
  if (!client) await connect();
  const { data, error } = await client
    .from("qa_memory")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? fromQaRow(data) : null;
}

/** 按 assistant 消息 UUID 查 QA（feedback 链接键） */
export async function findQaByMessageId(messageId) {
  if (!client) await connect();
  const { data, error } = await client
    .from("qa_memory")
    .select("*")
    .eq("message_id", messageId)
    .maybeSingle();
  if (error) throw error;
  return data ? fromQaRow(data) : null;
}

export async function listQa({ status, userId, page, pageSize } = {}) {
  if (!client) await connect();
  let query = client
    .from("qa_memory")
    .select("*", { count: "exact" })
    .order("id", { ascending: false });
  if (status) query = query.eq("status", status);
  if (userId != null) query = query.eq("user_id", userId);
  if (Number.isInteger(page) && Number.isInteger(pageSize) && pageSize > 0) {
    const from = (page - 1) * pageSize;
    query = query.range(from, from + pageSize - 1);
  }
  const { data, error, count } = await query;
  if (error) throw error;
  return {
    list: (data || []).map(fromQaRow),
    total: count ?? (data || []).length,
  };
}

export async function deleteQaById(id) {
  if (!client) await connect();
  const { error } = await client.from("qa_memory").delete().eq("id", id);
  if (error) throw error;
}

// ---------- Agent 会话 ----------

const toAgentSessionRow = (s) => ({
  session_id: s.sessionId,
  user_id: s.userId,
  title: s.title,
  turns: s.turns || [],
  created_at: s.createdAt ?? 0,
  updated_at: s.updatedAt ?? 0,
  touched_at: s.touchedAt ?? 0,
});

const fromAgentSessionRow = (r) => ({
  sessionId: r.session_id,
  userId: r.user_id,
  title: r.title,
  turns: r.turns || [],
  createdAt: Number(r.created_at) || 0,
  updatedAt: Number(r.updated_at) || 0,
  touchedAt: Number(r.touched_at) || 0,
});

export async function upsertAgentSession(session) {
  if (!client) await connect();
  const { error } = await client
    .from("agent_sessions")
    .upsert(toAgentSessionRow(session));
  if (error) throw error;
}

export async function findAgentSession(sessionId) {
  if (!client) await connect();
  const { data, error } = await client
    .from("agent_sessions")
    .select("*")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) throw error;
  return data ? fromAgentSessionRow(data) : null;
}

/** 列出某用户未过期的会话（按更新时间倒序），过期过滤在 SQL 层完成 */
export async function listAgentSessionsByUser(userId, minTouchedAt) {
  if (!client) await connect();
  const { data, error } = await client
    .from("agent_sessions")
    .select("*")
    .eq("user_id", userId)
    .gte("touched_at", minTouchedAt)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(fromAgentSessionRow);
}

/** 统计未过期会话总数（全局容量限制用） */
export async function countAgentSessions(minTouchedAt) {
  if (!client) await connect();
  const { data, error, count } = await client
    .from("agent_sessions")
    .select("session_id", { count: "exact", head: true })
    .gte("touched_at", minTouchedAt);
  if (error) throw error;
  return count ?? (data || []).length;
}

export async function deleteAgentSessionById(sessionId) {
  if (!client) await connect();
  const { error } = await client
    .from("agent_sessions")
    .delete()
    .eq("session_id", sessionId);
  if (error) throw error;
}

/** 轻量数据库探活：健康检查使用，不做全表统计 */
export async function pingDatabase() {
  if (!client) await connect();
  const { error } = await client
    .from("users")
    .select("id", { head: true, count: "exact" })
    .limit(1);
  if (error) throw error;
  return true;
}

/** 浏览量原子自增（避免“读-改-写”丢失并发更新） */
export async function incrementDocumentViews(documentId) {
  if (!client) await connect();
  const { data, error } = await client.rpc("increment_document_views", {
    p_document_id: documentId,
  });
  if (error) throw error;
  return Number(data) || 0;
}

export default {
  connect,
  isConnected,
  pingDatabase,
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
  setDocumentLike,
  hasDocumentFavorite,
  setDocumentFavorite,
  listFavoriteDocumentIds,
  hasCommentLike,
  addCommentLike,
  awardUserPoints,
  incrementDocumentViews,
  listPointsByUser,
  getSearchHistory,
  setSearchHistory,
  deleteSearchHistory,
  insertEntity,
  updateEntity,
  findEntity,
  findEntityByName,
  listEntities,
  deleteEntityById,
  insertRelation,
  listRelations,
  insertQa,
  updateQa,
  findQa,
  findQaByMessageId,
  listQa,
  deleteQaById,
  upsertAgentSession,
  findAgentSession,
  listAgentSessionsByUser,
  countAgentSessions,
  deleteAgentSessionById,
  insertUsageEvent,
  sumUsageSince,
};
