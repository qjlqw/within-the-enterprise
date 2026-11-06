-- 0009: 原子计数、幂等积分与 Token 版本
--
-- 背景：
--   1) 点赞/收藏/浏览/积分此前是“先查询、再插入、再读计数、再写回”的多步流程，
--      并发请求下会丢更新、重复加分。
--   2) JWT 无状态且有效期较长，改密或禁用账号后旧 Token 仍然有效。
--
-- 方案：
--   - 用数据库函数把“关系写入 + 计数变更”合并为单条原子语句；
--   - 积分写入增加业务幂等键，重复调用不会重复发放；
--   - users 增加 token_version，签发 JWT 时写入 tv，鉴权时比对，改密后递增即可撤销旧会话。
--
-- 执行顺序：在 0008 之后运行本文件。

-- ---------- 1. Token 版本 ----------
alter table users
  add column if not exists token_version integer not null default 0;

create or replace function bump_user_token_version(p_user_id integer)
returns integer
language sql
as $$
  update users
     set token_version = token_version + 1
   where id = p_user_id
  returning token_version;
$$;

-- ---------- 2. 积分幂等键 ----------
alter table points_records
  add column if not exists business_key text;

create unique index if not exists uq_points_records_business_key
  on points_records (business_key)
  where business_key is not null;

-- ---------- 3. 点赞 / 收藏（关系 + 计数原子化） ----------
create or replace function toggle_document_like(
  p_document_id integer,
  p_user_id integer,
  p_on boolean
)
returns boolean
language plpgsql
as $$
declare
  affected integer := 0;
begin
  if p_on then
    insert into document_likes (document_id, user_id)
    values (p_document_id, p_user_id)
    on conflict (document_id, user_id) do nothing;
    get diagnostics affected = row_count;
    if affected > 0 then
      update documents
         set likes = likes + 1
       where id = p_document_id;
      return true;
    end if;
    return false;
  end if;

  delete from document_likes
   where document_id = p_document_id
     and user_id = p_user_id;
  get diagnostics affected = row_count;
  if affected > 0 then
    update documents
       set likes = greatest(likes - 1, 0)
     where id = p_document_id;
    return true;
  end if;
  return false;
end;
$$;

create or replace function toggle_document_favorite(
  p_document_id integer,
  p_user_id integer,
  p_on boolean
)
returns boolean
language plpgsql
as $$
declare
  affected integer := 0;
begin
  if p_on then
    insert into document_favorites (document_id, user_id)
    values (p_document_id, p_user_id)
    on conflict (document_id, user_id) do nothing;
    get diagnostics affected = row_count;
    if affected > 0 then
      update documents
         set favorites = favorites + 1
       where id = p_document_id;
      return true;
    end if;
    return false;
  end if;

  delete from document_favorites
   where document_id = p_document_id
     and user_id = p_user_id;
  get diagnostics affected = row_count;
  if affected > 0 then
    update documents
       set favorites = greatest(favorites - 1, 0)
     where id = p_document_id;
    return true;
  end if;
  return false;
end;
$$;

-- ---------- 4. 浏览量原子递增 ----------
create or replace function increment_document_views(p_document_id integer)
returns integer
language sql
as $$
  update documents
     set views = views + 1
   where id = p_document_id
  returning views;
$$;

-- ---------- 5. 积分写入（业务键幂等 + 原子加分） ----------
create or replace function award_user_points(
  p_user_id integer,
  p_type text,
  p_points integer,
  p_description text,
  p_business_key text,
  p_created_at text
)
returns boolean
language plpgsql
as $$
declare
  affected integer := 0;
begin
  insert into points_records (
    user_id, type, points, description, created_at, business_key
  )
  values (
    p_user_id, p_type, p_points, coalesce(p_description, ''),
    p_created_at, p_business_key
  )
  on conflict (business_key) where business_key is not null do nothing;
  get diagnostics affected = row_count;

  -- 幂等键已存在：说明该业务动作已发放过积分，直接返回
  if p_business_key is not null and affected = 0 then
    return false;
  end if;

  update users
     set points = greatest(points + p_points, 0)
   where id = p_user_id;

  return true;
end;
$$;

-- 说明：
--   - 函数使用 security invoker（默认），需确保 Supabase service_role key
--     具有对上述表的读写权限；本项目服务端即使用 service_role。
--   - 回滚：删除本文件创建的函数与索引即可；token_version 列可保留（默认 0）。
