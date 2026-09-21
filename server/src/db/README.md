# 托管数据库适配器说明

本目录提供托管数据库（hosted DB）的适配器说明与存根实现。

如何使用

- 默认项目使用内存实现（`server/src/db/index.js` 中的实现）。
- 如果需要切换到托管 DB：在 `server/.env` 中设置 `DB_DRIVER=hosted` 并填写 `DB_URL`（可选），然后在应用启动时调用 `server/src/db/hosted.js` 中的 `connect()`。
- `server/src/db/hosted.js` 当前为存根实现，仅用于开发和逐步替换；真实生产环境请用 PostgreSQL / Supabase / MySQL 等驱动替换或扩展。

注意事项

- 切换到真实 DB 时请保持接口一致：`connect()`, `close()`, `insertDocument(doc)`, `deleteDocumentById(id)`。
- 不要在仓库中提交包含真实凭证的 `.env` 文件。
