-- 0007: 持久化文档原始文件的存储元数据
--
-- 背景：
--   上传接口此前只把 Backblaze B2 的 fileId / fileName / url 写到内存对象，
--   数据库中没有对应字段；进程重启或重新读取文档后无法再定位原始文件，
--   删除文档时会遗漏对象存储中的文件，长期产生孤儿文件与额外费用。
--
-- 内容：
--   1) documents.storage：JSONB，保存原始文件存储元数据
--   2) 形状约束：只允许已知驱动，且 fileId / fileName 必须为字符串
--   3) 历史数据保持 NULL（表示没有原始文件记录）

-- ---------- 1. 新增字段 ----------

alter table documents add column if not exists storage jsonb;

-- ---------- 2. 形状约束 ----------

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'documents_storage_shape'
  ) then
    alter table documents
      add constraint documents_storage_shape check (
        storage is null
        or (
          jsonb_typeof(storage) = 'object'
          and storage->>'driver' in ('backblaze')
          and jsonb_typeof(storage->'fileId') = 'string'
          and jsonb_typeof(storage->'fileName') = 'string'
        )
      );
  end if;
end
$$;
