-- 0008: 对象存储删除 outbox（可靠删除 + 指数退避重试）
--
-- 背景：
--   文档删除时直接调用 Backblaze 删除对象，失败仅写一条审计日志；
--   进程重启、对象存储临时故障都会让这次删除永久丢失，长期产生孤儿文件与额外费用。
--
-- 方案：
--   删除文档后先写一条 outbox 记录，由后台 worker 领取并重试，状态与错误可见；
--   多实例通过 CAS（status: pending -> processing）保证同一任务只会被处理一次。
--
-- 状态机：
--   pending    -> processing -> done        删除成功
--              -> pending（推迟 next_attempt_at） 失败未达上限
--              -> failed                     重试耗尽，等待人工重试

create table if not exists storage_deletion_outbox (
  id              uuid primary key default gen_random_uuid(),
  document_id     integer not null,          -- 仅用于追溯，不建外键：文档删除后任务仍需保留
  driver          text not null,             -- 对象存储驱动，目前仅 backblaze
  file_id         text not null,
  file_name       text not null,
  status          text not null default 'pending',
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at       timestamptz,               -- worker 领取时间，超时可回收
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint storage_deletion_outbox_status_check
    check (status in ('pending', 'processing', 'done', 'failed')),
  constraint storage_deletion_outbox_attempts_check check (attempts >= 0)
);

-- 按到期时间取任务
create index if not exists idx_storage_deletion_due
  on storage_deletion_outbox (status, next_attempt_at);

-- 按文档追溯
create index if not exists idx_storage_deletion_document
  on storage_deletion_outbox (document_id);

-- 同一对象只允许存在一条未完成任务，避免重复删除
create unique index if not exists uq_storage_deletion_active
  on storage_deletion_outbox (driver, file_id)
  where status in ('pending', 'processing');
