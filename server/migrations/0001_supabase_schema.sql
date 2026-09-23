-- ============================================================================
-- Supabase 建表迁移：企业内部知识库持久化存储
-- ----------------------------------------------------------------------------
-- 使用方法：
--   1. 登录 Supabase 控制台，打开目标项目。
--   2. 进入左侧菜单 "SQL Editor"（SQL 编辑器）。
--   3. 新建一个查询，将本文件内容全部粘贴进去，点击 "Run"（运行）。
--   4. 运行完成后，左侧 "Table Editor" 中应能看到下列表。
--
-- 说明：
--   - 本服务通过 service_role key（服务端专用）读写数据，该 key 默认绕过
--     Row Level Security（RLS），因此这里不启用 RLS，也不写策略。
--   - 表内 id 由应用层（内存自增计数器）负责生成，故 id 列不设自增/identity，
--     应用写入时显式带上 id。
--   - created_at / updated_at 使用 text 类型，直接存应用层的
--     "YYYY-MM-DD HH:mm:ss" 字符串，避免时区换算带来的一致性差异。
--   - tags / roles 为数组，使用 jsonb 存储。
-- ============================================================================

-- ---------- 用户 ----------
create table if not exists users (
  id          integer primary key,
  name        text not null,
  email       text not null unique,
  password    text not null,           -- bcrypt 哈希
  roles       jsonb not null default '[]',
  department  text not null default '',
  avatar      text not null default '',
  points      integer not null default 0
);

-- ---------- 文档 ----------
create table if not exists documents (
  id          integer primary key,
  title       text not null,
  content     text not null,
  author_id   integer not null,
  author_name text not null default '',
  category    text not null,
  tags        jsonb not null default '[]',
  status      text not null default 'draft',   -- draft | published
  views       integer not null default 0,
  likes       integer not null default 0,
  favorites   integer not null default 0,
  version     integer not null default 1,
  created_at  text,
  updated_at  text
);

-- ---------- 评论（parent_id 自关联，表示嵌套回复） ----------
create table if not exists comments (
  id          integer primary key,
  document_id integer not null,
  user_id     integer not null,
  user_name   text not null default '',
  content     text not null,
  likes       integer not null default 0,
  parent_id   integer,                          -- 顶层评论为 null，回复指向父评论 id
  created_at  text
);

-- ---------- 积分明细 ----------
create table if not exists points_records (
  id          integer primary key,
  user_id     integer not null,
  type        text not null,                    -- publish | like | favorite | comment
  points      integer not null default 0,
  description text not null default '',
  created_at  text
);

-- ---------- 文档版本快照 ----------
create table if not exists document_versions (
  id          integer primary key,
  document_id integer not null,
  version     integer not null,
  title       text,
  content     text,
  category    text,
  tags        jsonb not null default '[]',
  author_name text not null default '',
  updated_at  text
);

-- ---------- 文档点赞关系（去重） ----------
create table if not exists document_likes (
  document_id integer not null,
  user_id     integer not null,
  primary key (document_id, user_id)
);

-- ---------- 文档收藏关系（去重） ----------
create table if not exists document_favorites (
  document_id integer not null,
  user_id     integer not null,
  primary key (document_id, user_id)
);

-- ---------- 评论点赞关系（去重） ----------
create table if not exists comment_likes (
  comment_id integer not null,
  user_id    integer not null,
  primary key (comment_id, user_id)
);

-- ---------- 用户搜索历史（每人一行，jsonb 数组保序） ----------
create table if not exists search_history (
  user_id  integer primary key,
  keywords jsonb not null default '[]'
);

-- ---------- 索引（按外键/常用查询字段） ----------
create index if not exists idx_documents_author on documents (author_id);
create index if not exists idx_documents_status on documents (status);
create index if not exists idx_comments_document on comments (document_id);
create index if not exists idx_comments_parent on comments (parent_id);
create index if not exists idx_points_records_user on points_records (user_id);
create index if not exists idx_document_versions_doc on document_versions (document_id);
