# 接入向量库与 RAG 增强检索 — 实施方案（已实现）

## 已完成实现概览

按方案完成全部代码改动。实际落地时向量存储从最初的 Chroma(Docker) 方案演变为「本地 JSON（`.runtime/vectors.json`）+ 可选 Upstash Vector」双驱动（`config.vector.store = local | upstash`），embedding 使用 DashScope/OpenAI 兼容端点，检索为混合检索（向量 + 关键词 + 可选 Rerank 精排）。`docker-compose.yml`（Chroma）已不存在。

## 文件清单

### 新增文件

- [server/src/services/embeddingService.js](file:///c:/Users/30565/Desktop/worker/within-the-enterprise/server/src/services/embeddingService.js) — 向量库服务（切片/upsert/delete/semanticSearch/initVectorStore，本地 JSON + Upstash 分支）
- [server/src/services/vectorStore/index.js](file:///c:/Users/30565/Desktop/worker/within-the-enterprise/server/src/services/vectorStore/index.js) — 向量存储驱动分派（路由 `upstash`）
- [server/src/services/vectorStore/upstash.js](file:///c:/Users/30565/Desktop/worker/within-the-enterprise/server/src/services/vectorStore/upstash.js) — Upstash Vector 适配器
- [server/scripts/reindex.js](file:///c:/Users/30565/Desktop/worker/within-the-enterprise/server/scripts/reindex.js) — 批量重建脚本

### 修改文件

- [server/package.json](file:///c:/Users/30565/Desktop/worker/within-the-enterprise/server/package.json) — 加 `reindex` script（不再引入 `chromadb`）
- [server/.env.example](file:///c:/Users/30565/Desktop/worker/within-the-enterprise/server/.env.example) — 加 RAG\_\* 环境变量段
- [server/src/config/index.js](file:///c:/Users/30565/Desktop/worker/within-the-enterprise/server/src/config/index.js) — 加 `config.rag` 段
- [server/src/server.js](file:///c:/Users/30565/Desktop/worker/within-the-enterprise/server/src/server.js) — 启动钩子 `initVectorStore()`
- [server/src/routes/documents.js](file:///c:/Users/30565/Desktop/worker/within-the-enterprise/server/src/routes/documents.js) — 4 处写入钩子（创建/更新/删除/回滚）
- [server/src/services/knowledgeService.js](file:///c:/Users/30565/Desktop/worker/within-the-enterprise/server/src/services/knowledgeService.js) — 新增 `searchDocumentsHybrid` 混合检索
- [server/src/agent/tools.js](file:///c:/Users/30565/Desktop/worker/within-the-enterprise/server/src/agent/tools.js) — `search_documents` 切到 hybrid + 兜底回退
- [server/src/agent/prompts.js](file:///c:/Users/30565/Desktop/worker/within-the-enterprise/server/src/agent/prompts.js) — 描述更新为语义检索

## 启用步骤（用户执行）

```sh
# 1. 安装依赖
npm --prefix server install

# 2. 配置 server/.env（参考 .env.example，密钥复用 LLM_API_KEY）
#    RAG_ENABLED=true
#    EMBEDDING_API_KEY=<或复用 LLM_API_KEY>
#    EMBEDDING_BASE_URL=<DashScope / OpenAI 兼容端点，可选>
#    VECTOR_STORE=local    # 默认本地 JSON；可选 upstash（需 UPSTASH_* 凭证）

# 3. 启动后端（自动初始化向量库 + 灌种子数据）
npm --prefix server run dev
# 日志应出现：[RAG] 向量库已就绪，已索引 N 篇文档 / M 个切片

# 4. 启动前端
npm run dev
# 访问 /agent 提问验证语义召回

# 可选：手动批量重建
npm --prefix server run reindex
```

## 降级保护

- RAG_ENABLED=false → 服务正常启动，search_documents 走纯关键词检索
- 向量库初始化失败（本地 JSON 不可写 / Upstash 连接失败）→ initVectorStore 失败仅记日志，不阻断服务；semanticSearch 返回空，searchDocumentsHybrid 自动回退关键词
- embedding API 失败 → 单条 upsert/semanticSearch 失败仅记日志，不阻断 HTTP 响应

## 校验链路保留

向量召回的 fragment 结构与 `knowledgeService.fragment()` 完全对齐（`documentId/title/category/version/offset/text/nextOffset`），`SourceRegistry.register()` 与 `sourceIsValid()` 链路零改动，回答中 `[Sx]` 引用校验和「资料已变更」失败机制完整保留。

## 待用户验证项

1. 既有 17 项 agent 兼容协议测试通过（`npm --prefix server test`）
2. `npm --prefix server run test:live` 与 `eval:agent` 冒烟通过
3. 端到端：登录 → `/agent` → 提问「新员工第一天该做什么」→ 验证语义召回入职文档
4. 编辑已发布文档 → 提问原内容 → 应触发 `SOURCES_CHANGED`（验证版本失效链路）
5. 删除文档 → 提问该文档 → 不应召回
6. 停用向量库（如 VECTOR_STORE=upstash 未配置凭证或断网）再提问 → 应回退关键词检索

## 本地无数据库 / 无 Docker 运行说明

- **概要**：仓库内已实现一个轻量本地向量存储（内存 + `.runtime/vectors.json`），可在无法安装 Docker 或本地数据库的环境下直接启用 RAG 功能（适合 PoC / 小规模使用）。
- **必需环境变量**：
  - `RAG_ENABLED=true`
  - `EMBEDDING_API_KEY`（或复用 `LLM_API_KEY`）
  - 可选：`EMBEDDING_BASE_URL`（指向 DashScope / OpenAI 兼容的 embeddings endpoint）
  - 若使用精排：配置 `RERANK_API_KEY` / `RERANK_BASE_URL` / `RERANK_MODEL`
- **启动（Windows 示例）**：

```powershell
npm --prefix server install
set RAG_ENABLED=true
set EMBEDDING_API_KEY=your_key_here
set EMBEDDING_BASE_URL=https://api.example.com
npm --prefix server run dev
```

- **数据位置与行为**：
  - 向量持久化文件：`.runtime/vectors.json`（由 `server/src/services/embeddingService.js` 管理）
  - 启动时会调用 `initVectorStore()`，若索引为空会为所有已发布文档生成向量；文档创建/更新/删除事件通过 `indexQueue` 异步入队并处理。

- **局限性与建议**：
  - 适用场景：PoC、小规模知识库（数百篇文档，数千切片）和本地测试。
  - 不适用：大规模（数万+ 文档）、多实例/分布式部署或高并发检索场景。此实现为单进程内存索引，持久化为 JSON 文件。
  - 推荐方案：若生产化，请迁移到托管向量服务（Pinecone、Chroma Cloud、Weaviate Cloud、Hosted PGVector、Redis Cloud 等）或接入本地 FAISS（需编译原生依赖）。
  - 可扩展性：已实现“驱动层”（`vectorStore/index.js` 按 `config.vector.store` 分派，`upstash.js` 为托管驱动，本地 JSON 逻辑内联在 `embeddingService.js`），可通过 env 切换本地/托管向量 DB。

- **快速验证**：启动服务后在日志中查找 `[RAG] 向量库已就绪`，或运行

```sh
npm --prefix server run reindex
```

    强制重建索引并观察 `.runtime/vectors.json` 文件变化。
