import bcrypt from "bcryptjs";
import { formatDateTime } from "../utils/date.js";
import hosted from "./hosted.js";
import supabaseAdapter from "./supabase.js";

const DB_DRIVER = process.env.DB_DRIVER || "local";

if (DB_DRIVER === "hosted") {
  hosted.connect().catch((e) => {
    console.warn(
      "Hosted DB connect failed, will operate in local mode:",
      e?.message || e,
    );
  });
} else if (DB_DRIVER === "supabase") {
  supabaseAdapter.connect().catch((e) => {
    console.warn(
      "Supabase connect failed, will operate in local mode:",
      e?.message || e,
    );
  });
}

/**
 * 内存数据库（与前端 mock 数据一致）
 * 真实项目可替换为 MySQL / MongoDB；此处用内存实现以便直接运行。
 */

// 自增 ID 计数器：每张"表"维护一个
let nextUserId = 1;
let nextDocumentId = 1;
let nextCommentId = 1;
let nextPointsRecordId = 1;
let nextVersionId = 1;

// 用户（password 字段已用 bcrypt 哈希）
const users = [];

// 文档
const documents = [];

// 评论
const comments = [];

// 积分记录
const pointsRecords = [];

// 文档版本快照（用于版本历史与回滚）
const documentVersions = [];

// 点赞 / 收藏 / 评论点赞 关系（避免重复操作）
const documentLikes = new Map(); // documentId -> Set<userId>
const documentFavorites = new Map(); // documentId -> Set<userId>
const commentLikes = new Map(); // commentId -> Set<userId>

// 搜索历史（按 userId）
const searchHistory = new Map(); // userId -> string[]

// 热门搜索词（前端首页展示）
const hotSearches = [
  "React",
  "Elasticsearch",
  "项目规范",
  "API 文档",
  "入职指南",
];

// 积分规则：发布 / 被点赞 / 被收藏 / 评论，每种行为单独计分与每日上限
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

/** 初始化种子数据 */
export function initDb() {
  users.length = 0;
  documents.length = 0;
  comments.length = 0;
  pointsRecords.length = 0;
  documentVersions.length = 0;
  documentLikes.clear();
  documentFavorites.clear();
  commentLikes.clear();
  searchHistory.clear();

  nextUserId = 1;
  nextDocumentId = 1;
  nextCommentId = 1;
  nextPointsRecordId = 1;
  nextVersionId = 1;

  const seedUsers = [
    {
      name: "张三",
      email: "zhangsan@company.com",
      password: "123456",
      roles: ["admin"],
      department: "技术部",
      points: 2580,
    },
    {
      name: "李四",
      email: "lisi@company.com",
      password: "123456",
      roles: ["user"],
      department: "产品部",
      points: 2180,
    },
    {
      name: "王五",
      email: "wangwu@company.com",
      password: "123456",
      roles: ["user"],
      department: "技术部",
      points: 1950,
    },
    {
      name: "赵六",
      email: "zhaoliu@company.com",
      password: "123456",
      roles: ["editor"],
      department: "运营部",
      points: 1680,
    },
  ];
  seedUsers.forEach((u) =>
    users.push({
      id: nextUserId++,
      name: u.name,
      email: u.email,
      password: hash(u.password),
      roles: u.roles,
      department: u.department,
      avatar: "",
      points: u.points,
    }),
  );

  // 通过 authorId 反查 authorName，避免冗余存储
  const authorName = (id) => users.find((u) => u.id === id)?.name || "";
  // 种子文档：覆盖技术/规范/培训等典型分类，便于演示
  const seedDocs = [
    {
      title: "React 入门教程",
      content:
        "# React 入门教程\n\n## 一、React 简介\n\nReact 是一个用于构建用户界面的 JavaScript 库。\n\n## 二、核心概念\n\n### 1. 组件\n\n组件是 React 的基本构建单元。\n\n### 2. Props\n\nProps 是组件之间传递数据的方式。\n\n### 3. State\n\nState 是组件内部的状态管理。",
      authorId: 1,
      category: "技术文档",
      tags: ["React", "前端", "教程"],
      status: "published",
      views: 128,
      likes: 23,
      favorites: 15,
      createdAt: "2025-02-15 10:00:00",
      updatedAt: "2025-03-01 14:30:00",
    },
    {
      title: "项目规范文档",
      content:
        "# 项目规范文档\n\n## 一、代码规范\n\n### 1. 命名规范\n- 变量使用小驼峰\n- 组件使用大驼峰\n- 常量使用大写 + 下划线\n\n## 二、Git 规范\n\n- feat: 新功能\n- fix: 修复 bug\n- docs: 文档更新",
      authorId: 2,
      category: "规范",
      tags: ["规范", "团队"],
      status: "published",
      views: 89,
      likes: 12,
      favorites: 8,
      createdAt: "2025-02-20 09:00:00",
      updatedAt: "2025-02-28 16:00:00",
    },
    {
      title: "API 接口文档",
      content:
        "# API 接口文档\n\n## 接口列表\n\n### 1. 用户认证\n- POST /api/auth/login\n- POST /api/auth/register\n- POST /api/auth/logout\n\n### 2. 文档管理\n- GET /api/documents\n- POST /api/documents\n- PUT /api/documents/:id\n- DELETE /api/documents/:id",
      authorId: 3,
      category: "技术文档",
      tags: ["API", "后端"],
      status: "draft",
      views: 56,
      likes: 8,
      favorites: 3,
      createdAt: "2025-02-25 14:00:00",
      updatedAt: "2025-02-27 11:00:00",
    },
    {
      title: "新员工入职指南",
      content:
        "# 新员工入职指南\n\n## 一、入职准备\n\n1. 准备入职材料\n2. 领取办公设备\n3. 开通系统账号\n\n## 二、熟悉环境\n\n1. 了解公司文化\n2. 熟悉团队成员\n3. 了解工作流程\n\n## 三、培训内容\n\n1. 产品培训\n2. 技术培训\n3. 安全培训",
      authorId: 4,
      category: "培训",
      tags: ["入职", "培训"],
      status: "published",
      views: 234,
      likes: 45,
      favorites: 28,
      createdAt: "2025-01-10 08:00:00",
      updatedAt: "2025-02-26 10:00:00",
    },
    {
      title: "Elasticsearch 实战指南",
      content:
        "# Elasticsearch 实战指南\n\n## 一、Elasticsearch 简介\n\nElasticsearch 是一个分布式搜索和分析引擎。\n\n## 二、核心概念\n\n### 1. 索引 (Index)\n\n索引是具有相似特征的文档集合。\n\n### 2. 文档 (Document)\n\n文档是 Elasticsearch 中的基本信息单位。\n\n### 3. 映射 (Mapping)\n\n映射定义了索引中字段的数据类型。",
      authorId: 1,
      category: "技术文档",
      tags: ["Elasticsearch", "搜索", "后端"],
      status: "published",
      views: 176,
      likes: 32,
      favorites: 21,
      createdAt: "2025-02-10 11:00:00",
      updatedAt: "2025-02-25 15:30:00",
    },
  ];
  // 写入文档并同时存一份初始版本快照
  seedDocs.forEach((d) => {
    const doc = {
      id: nextDocumentId++,
      title: d.title,
      content: d.content,
      authorId: d.authorId,
      authorName: authorName(d.authorId),
      category: d.category,
      tags: d.tags,
      status: d.status,
      views: d.views,
      likes: d.likes,
      favorites: d.favorites,
      version: 1, // 初始版本号
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
    documents.push(doc);
    // 同步登记一个版本快照，保证文档一创建就有版本历史
    documentVersions.push({
      id: nextVersionId++,
      documentId: doc.id,
      version: 1,
      title: doc.title,
      content: doc.content,
      category: doc.category,
      tags: [...doc.tags],
      authorName: doc.authorName,
      updatedAt: doc.updatedAt,
    });
  });

  const seedComments = [
    {
      id: 1,
      documentId: 1,
      userId: 2,
      userName: "李四",
      content: "很详细的教程，学习了！",
      likes: 5,
      replies: [],
      createdAt: "2025-02-16 10:00:00",
    },
    {
      id: 2,
      documentId: 1,
      userId: 3,
      userName: "王五",
      content: "对新手很友好，赞！",
      likes: 3,
      replies: [
        {
          id: 3,
          documentId: 1,
          userId: 1,
          userName: "张三",
          content: "谢谢支持！",
          likes: 0,
          replies: [],
          createdAt: "2025-02-16 11:00:00",
        },
      ],
      createdAt: "2025-02-17 14:00:00",
    },
    {
      id: 4,
      documentId: 1,
      userId: 4,
      userName: "赵六",
      content: "希望能出更多 React 相关的教程",
      likes: 8,
      replies: [],
      createdAt: "2025-02-18 09:00:00",
    },
  ];
  seedComments.forEach((c) => comments.push(c));
  nextCommentId = 5;

  const seedPoints = [
    {
      id: 1,
      userId: 1,
      type: "publish",
      points: 10,
      description: "发布文档《React 入门教程》",
      createdAt: "2025-02-15 10:00:00",
    },
    {
      id: 2,
      userId: 1,
      type: "like",
      points: 1,
      description: "文档被点赞",
      createdAt: "2025-02-16 10:00:00",
    },
    {
      id: 3,
      userId: 2,
      type: "publish",
      points: 10,
      description: "发布文档《项目规范文档》",
      createdAt: "2025-02-20 09:00:00",
    },
    {
      id: 4,
      userId: 1,
      type: "favorite",
      points: 2,
      description: "文档被收藏",
      createdAt: "2025-02-21 14:00:00",
    },
  ];
  seedPoints.forEach((r) => pointsRecords.push(r));
  nextPointsRecordId = 5;
}

// ---------- 工具函数 ----------

/** 字符串 / 数字 id 统一转数字（路由参数都是字符串） */
export const toNumberId = (id) => parseInt(String(id), 10);

/** 返回不含 password 字段的用户副本，避免敏感信息外泄 */
export const stripPassword = (user) => {
  if (!user) return null;
  const { password: _pw, ...rest } = user;
  return rest;
};

// 用户查询
export const findUserById = (id) => users.find((u) => u.id === toNumberId(id));
export const findUserByEmail = (email) => users.find((u) => u.email === email);
export const getUserPassword = (user) => user?.password;

// 整表读取（直接返回内部数组引用，调用方不应修改）
export const allUsers = () => users;
export const allDocuments = () => documents;
export const allComments = () => comments;
export const allPointsRecords = () => pointsRecords;
export const allDocumentVersions = () => documentVersions;
export const getHotSearches = () => [...hotSearches];

/** 注册新用户：默认 user 角色，初始积分 0，密码哈希后存储 */
export function createUser({ name, email, password, department }) {
  const user = {
    id: nextUserId++,
    name,
    email,
    password: hash(password),
    roles: ["user"],
    department: department || "",
    avatar: "",
    points: 0,
  };
  users.push(user);
  return user;
}

/** 修改密码：原密码校验由路由层完成，这里直接覆盖哈希 */
export function updateUserPassword(userId, newPassword) {
  const user = findUserById(userId);
  if (!user) return false;
  user.password = hash(newPassword);
  return true;
}

/** 更新个人资料：仅修改传入字段，未传的字段保持不变 */
export function updateUserProfile(userId, { name, department, avatar }) {
  const user = findUserById(userId);
  if (!user) return null;
  if (name !== undefined) user.name = name;
  if (department !== undefined) user.department = department;
  if (avatar !== undefined) user.avatar = avatar;
  return user;
}

export function findDocument(id) {
  return documents.find((d) => d.id === toNumberId(id));
}

/** 创建文档并写入第一个版本快照 */
export function createDocument(data, author) {
  const now = formatDateTime();
  const doc = {
    id: nextDocumentId++,
    title: data.title,
    content: data.content,
    authorId: author.id,
    authorName: author.name,
    category: data.category,
    tags: data.tags ?? [],
    status: data.status || "draft", // 默认草稿，需手动发布
    views: 0,
    likes: 0,
    favorites: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  documents.push(doc);
  pushVersion(doc, true);
  // 如果配置为托管 DB 或 Supabase，异步把元数据写入托管 DB（不阻塞请求流程）
  if (DB_DRIVER === "hosted" || DB_DRIVER === "supabase") {
    (async () => {
      try {
        if (DB_DRIVER === "hosted") {
          if (!hosted.isConnected()) await hosted.connect();
          await hosted.insertDocument(doc);
        } else if (DB_DRIVER === "supabase") {
          if (!supabaseAdapter.isConnected()) await supabaseAdapter.connect();
          await supabaseAdapter.insertDocument(doc);
        }
      } catch (e) {
        console.error(`${DB_DRIVER}.insertDocument failed:`, e?.message || e);
      }
    })();
  }
  return doc;
}

/**
 * 从内存中删除文档（路由层应调用此方法而不是直接操作数组），
 * 并在托管 DB 模式下异步删除托管端的元数据。
 */
export function removeDocument(documentId) {
  const id = toNumberId(documentId);
  const idx = documents.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  const [doc] = documents.splice(idx, 1);
  // 异步通知托管 DB / Supabase 删除
  if (DB_DRIVER === "hosted" || DB_DRIVER === "supabase") {
    (async () => {
      try {
        if (DB_DRIVER === "hosted") {
          if (!hosted.isConnected()) await hosted.connect();
          await hosted.deleteDocumentById(id);
        } else if (DB_DRIVER === "supabase") {
          if (!supabaseAdapter.isConnected()) await supabaseAdapter.connect();
          await supabaseAdapter.deleteDocumentById(id);
        }
      } catch (e) {
        console.error(
          `${DB_DRIVER}.deleteDocumentById failed:`,
          e?.message || e,
        );
      }
    })();
  }
  return doc;
}

/**
 * 更新文档：版本号 +1 并写入新的版本快照
 * 注意：调用方需先做权限校验（作者本人或 admin）
 */
export function updateDocument(id, data) {
  const doc = findDocument(id);
  if (!doc) return null;
  // 保存更新前快照（用于回滚到当前版本）
  Object.assign(doc, {
    title: data.title,
    content: data.content,
    category: data.category,
    tags: data.tags ?? doc.tags,
    status: data.status || doc.status,
    version: doc.version + 1,
    updatedAt: formatDateTime(),
  });
  pushVersion(doc, false);
  return doc;
}

/** 写入版本快照：isFirst 区分"创建初始版本"与"更新后版本" */
function pushVersion(doc, isFirst) {
  documentVersions.push({
    id: nextVersionId++,
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
export function getDocumentVersions(documentId) {
  return documentVersions
    .filter((v) => v.documentId === toNumberId(documentId))
    .map((v) => ({
      id: v.id,
      version: v.version,
      updatedAt: v.updatedAt,
      authorName: v.authorName,
    }));
}

/**
 * 回滚到指定版本：用目标版本覆盖当前文档字段，
 * 版本号继续 +1（不是回到旧版本号），并写入新快照，
 * 这样回滚本身也是可追溯的一次版本变更。
 */
export function rollbackDocument(documentId, versionId) {
  const doc = findDocument(documentId);
  if (!doc) return null;
  const target = documentVersions.find(
    (v) => v.documentId === doc.id && v.id === toNumberId(versionId),
  );
  if (!target) return null;
  Object.assign(doc, {
    title: target.title,
    content: target.content,
    category: target.category,
    tags: [...target.tags],
    version: doc.version + 1,
    updatedAt: formatDateTime(),
  });
  pushVersion(doc, false);
  return doc;
}

// ---------- 点赞 / 收藏 ----------

/** 取 Map 中的 Set，不存在则先建空 Set */
const setGet = (map, key) => {
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key);
};

/** 点赞文档：幂等，重复点赞返回 toggled:false；首次点赞给作者加积分 */
export function likeDocument(documentId, userId) {
  const doc = findDocument(documentId);
  if (!doc) return null;
  const set = setGet(documentLikes, doc.id);
  if (set.has(userId)) return { toggled: false };
  set.add(userId);
  doc.likes += 1;
  awardPoints(doc.authorId, "like", "文档被点赞");
  return { toggled: true };
}

/** 取消点赞：幂等，未点过赞返回 toggled:false；不会扣回积分 */
export function unlikeDocument(documentId, userId) {
  const doc = findDocument(documentId);
  if (!doc) return null;
  const set = setGet(documentLikes, doc.id);
  if (!set.has(userId)) return { toggled: false };
  set.delete(userId);
  doc.likes = Math.max(0, doc.likes - 1);
  return { toggled: true };
}

/** 收藏文档：幂等，首次收藏给作者加积分 */
export function favoriteDocument(documentId, userId) {
  const doc = findDocument(documentId);
  if (!doc) return null;
  const set = setGet(documentFavorites, doc.id);
  if (set.has(userId)) return { toggled: false };
  set.add(userId);
  doc.favorites += 1;
  awardPoints(doc.authorId, "favorite", "文档被收藏");
  return { toggled: true };
}

/** 取消收藏：幂等，不会扣回积分 */
export function unfavoriteDocument(documentId, userId) {
  const doc = findDocument(documentId);
  if (!doc) return null;
  const set = setGet(documentFavorites, doc.id);
  if (!set.has(userId)) return { toggled: false };
  set.delete(userId);
  doc.favorites = Math.max(0, doc.favorites - 1);
  return { toggled: true };
}

/** 获取某用户收藏的文档（按 documentFavorites 反查文档表） */
export function getFavoriteDocuments(userId) {
  return documents.filter((d) => setGet(documentFavorites, d.id).has(userId));
}

// ---------- 评论 ----------

/**
 * 在评论树中查找评论：顶层 + replies 递归
 * 同时校验 documentId，避免跨文档误删
 */
export function findComment(documentId, commentId) {
  const did = toNumberId(documentId);
  // 顶层评论 + 回复递归查找
  function walk(list) {
    for (const c of list) {
      if (c.id === toNumberId(commentId) && c.documentId === did) return c;
      if (c.replies?.length) {
        const found = walk(c.replies);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(comments);
}

/** 取某文档下的顶层评论（不含 replies 的扁平化，返回原数组引用含 replies） */
export function getComments(documentId) {
  return comments.filter((c) => c.documentId === toNumberId(documentId));
}

/** 创建评论：顶层评论，奖励积分 */
export function createComment(documentId, content, user) {
  const comment = {
    id: nextCommentId++,
    documentId: toNumberId(documentId),
    userId: user.id,
    userName: user.name,
    content,
    likes: 0,
    replies: [],
    createdAt: formatDateTime(),
  };
  comments.push(comment);
  awardPoints(user.id, "comment", "发布评论");
  return comment;
}

/** 回复评论：在 parent.replies 中追加，回复不奖励积分 */
export function replyComment(documentId, commentId, content, user) {
  const parent = findComment(documentId, commentId);
  if (!parent) return null;
  const reply = {
    id: nextCommentId++,
    documentId: toNumberId(documentId),
    userId: user.id,
    userName: user.name,
    content,
    likes: 0,
    replies: [],
    createdAt: formatDateTime(),
  };
  parent.replies.push(reply);
  return reply;
}

/** 删除评论：递归在 replies 中查找并删除，删除后 replies 一并消失 */
export function deleteComment(documentId, commentId) {
  const did = toNumberId(documentId);
  const cid = toNumberId(commentId);
  function walk(list) {
    const idx = list.findIndex((c) => c.id === cid && c.documentId === did);
    if (idx !== -1) {
      list.splice(idx, 1);
      return true;
    }
    for (const c of list) {
      if (c.replies?.length && walk(c.replies)) return true;
    }
    return false;
  }
  return walk(comments);
}

/** 点赞评论：幂等 */
export function likeComment(documentId, commentId, userId) {
  const comment = findComment(documentId, commentId);
  if (!comment) return null;
  const set = setGet(commentLikes, comment.id);
  if (set.has(userId)) return { toggled: false };
  set.add(userId);
  comment.likes += 1;
  return { toggled: true };
}

// ---------- 积分 ----------

/**
 * 发放积分：根据 type 在 pointsRules 中查规则
 * - 累加到用户总积分
 * - 写一条积分明细记录，供明细页展示
 * 注：当前未实现每日上限校验，dailyLimit 字段仅作展示
 */
export function awardPoints(userId, type, description) {
  const rule = pointsRules.find((r) => r.type === type);
  if (!rule) return;
  const user = findUserById(userId);
  if (!user) return;
  user.points = (user.points || 0) + rule.points;
  pointsRecords.push({
    id: nextPointsRecordId++,
    userId,
    type,
    points: rule.points,
    description,
    createdAt: formatDateTime(),
  });
}

/** 积分排行榜：按积分倒序取前 limit 名，附 rank 序号 */
export function getPointsRanking(limit = 10) {
  return [...users]
    .sort((a, b) => (b.points || 0) - (a.points || 0))
    .slice(0, limit)
    .map((u, i) => ({ ...stripPassword(u), rank: i + 1 }));
}

/** 用户积分明细：返回 list 与 total，路由层做分页 */
export function getPointsDetail(userId) {
  const list = pointsRecords.filter((r) => r.userId === toNumberId(userId));
  return { list, total: list.length };
}

/** 积分规则列表（前端积分页展示） */
export function getPointsRules() {
  return [...pointsRules];
}

// ---------- 搜索历史 ----------

/**
 * 记录搜索历史：去重后插入到最前，仅保留最近 10 条
 */
export function addSearchHistory(userId, keyword) {
  if (!keyword) return;
  const list = setGet(searchHistory, userId);
  const idx = list.indexOf(keyword);
  if (idx !== -1) list.splice(idx, 1); // 已存在则先移除，保证最近搜索在最前
  list.unshift(keyword);
  searchHistory.set(userId, list.slice(0, 10));
}

/** 读取用户搜索历史（返回副本，避免外部修改） */
export function getSearchHistory(userId) {
  return [...(searchHistory.get(userId) || [])];
}

/** 清除用户搜索历史 */
export function clearSearchHistory(userId) {
  searchHistory.delete(userId);
}

// ---------- 用户统计 ----------

/** 用户统计：聚合其名下文档的点赞 / 收藏 / 浏览总数 */
export function getUserStats(userId) {
  const userDocs = documents.filter((d) => d.authorId === toNumberId(userId));
  return {
    documents: userDocs.length,
    likes: userDocs.reduce((s, d) => s + d.likes, 0),
    favorites: userDocs.reduce((s, d) => s + d.favorites, 0),
    views: userDocs.reduce((s, d) => s + d.views, 0),
  };
}
