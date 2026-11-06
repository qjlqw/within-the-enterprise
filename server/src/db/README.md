# 数据层说明

本目录的数据层**仅支持 Supabase**

- 连接配置：在 `server/.env` 中设置 `SUPABASE_URL` 与 `SUPABASE_SERVICE_KEY`。
  未配置时 `initDb()` 会直接抛错并阻止服务启动，不会静默回退到内存数据。
- 建表脚本：按编号依次执行 `server/migrations/*.sql`（当前最新为 `0008_storage_deletion_outbox.sql`）。
- `index.js` 是路由层使用的唯一入口，`supabase.js` 负责具体读写与字段映射。
- 文档删除时原始文件的清理任务写入 `storage_deletion_outbox`，由
  `services/storageDeletionOutbox.js` 的后台 worker 领取并重试。

不要在仓库中提交包含真实凭证的 `.env` 文件。
