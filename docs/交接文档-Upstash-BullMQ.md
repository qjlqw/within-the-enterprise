# Upstash + BullMQ + Backblaze B2 集成交接文档

> 生成自与开发者的对话纪录（截止：2026-09-18）。本文件记录：架构目标、已完成事项、未完成事项、下一步建议、踩坑点，以及适合新 AI 接手的交接 Prompt。

## 精简版

- **背景与目标**：将现有本地 RAG 方案迁移/验证为托管架构：使用 `Backblaze B2` 作为文件存储、`Upstash Vector` 作为向量索引、`Upstash Redis` 作为缓存/队列后端、`bullmq` 作为索引任务队列，目标是让文档上传、索引、语义检索和删除具备可扩展、可持久化、可恢复的能力。
- **已完成**：实现 Upstash Vector adapter（`server/src/services/vectorStore/upstash.js`），并在 `embeddingService` 中接入 `VECTOR_STORE=upstash` 路径；实现 E2E 测试脚本 `server/scripts/test-upstash.js`，已验证成功：upsert / query / delete 都通过；将 `indexQueue` 改成支持 `bullmq` + Redis 连接，并在缺少依赖/未配置时回退到内存实现；更新 `.env.example` / 文档说明，明确 Upstash Vector、Upstash Redis、BullMQ、R2 的环境变量约定。
- **当前结论**：A 级任务“Upstash Vector adapter + embeddingService 接入”已完成并已通过端到端测试；B 级任务“Redis-backed 队列（BullMQ）”已完成代码层接入（Queue/Worker/退避/审计/手动重试均已实现），Upstash Vector / Redis 已配置并连接，仅缺 namespace 隔离；C 级任务“Backblaze B2 + 托管 DB”已**部分落地**：Backblaze B2 的 upload/deleteFileVersion 已实现并接入 `routes/documents.js` 上传/删除流程，DB 已切换为纯 Supabase 直查，仍缺 B2 的 list/download 接口与真实凭证验证。
- **未做/未验证**：没有迁移现有已发布文档，也没有把本地现有文档重新上传到 Upstash；Backblaze B2 尚未实现 list/download 接口，也未用真实凭证跑通完整上传-下载闭环；Upstash Vector / Redis 已配置并连接，但尚未做 namespace 隔离。

## 详细版

**1. 架构目标**

- 项目目标：构建更稳定的企业知识库 RAG 架构：
  - `Backblaze B2`: 存储上传文件、文档二进制文件与对象缓存；
  - `Upstash Vector`: 存储 embedding 向量与 metadata；
  - `Upstash Redis`: 保存 doc -> vector id 映射、队列 backend、短期缓存；
  - `bullmq`: 持久化索引队列，保证文档发布/更新时索引任务可恢复、可重试、可回调。
- 约束：当前要求“不迁移现有已发布文档、不重建本地数据、不强制上传现存文档”，也就是先确保新架构可用，并且对 current local data 不做破坏性改动。

**2. 已完成的各项工作（按任务 A / B / C 分列）**

### A. Upstash Vector adapter + embeddingService 接入（已完成）

- **实现文件**：`server/src/services/vectorStore/upstash.js`
  - 已实现 `init()`、`upsertVectors(items)`、`deleteByDocumentId(documentId)`、`search(queryEmbedding, topK)`、`getInfo()`。
  - 维护 Redis 中的 `doc:vectors:<documentId>` 映射，用于按文档删除已索引向量。
  - `search()` 采用 SDK 的 `query()`，并标准化返回结构为 `{ id, score, metadata }`。
  - 通过 `redisClient` 控制文档级删除，避免只删除一部分向量造成脏数据。

- **Embedding 服务接入**：`server/src/services/embeddingService.js`
  - 当 `config.vector.store === "upstash"` 时，`upsertDocument()`、`deleteDocument()`、`semanticSearch()` 自动路由到 `vectorStore` adapter。
  - 这样 `knowledgeService` 不需要感知底层存储实现，调用链保持一致。
  - `RAG_ENABLED` 与 `vector store` 的初始化仍保持原有降级策略：如果初始化失败，回退到关键词检索。

- **验证结果**：
  - 已运行 `node server/scripts/test-upstash.js`，并拿到真实的 index metadata：
    - `dimension: 1536`
    - `similarityFunction: 'COSINE'`
    - `embeddingModel: 'text-embedding-3-small'`
  - 结果为：`upsert` 成功、`query` 成功并返回 topK 命中、`delete` 成功，脚本正常退出。

### B. `indexQueue` 改成 Redis-backed + BullMQ（已连接）

- **实现文件**：`server/src/services/indexQueue.js`
  - 新增 `bullmq` / `ioredis` 动态 import 的实现。
  - 当 `INDEX_QUEUE_DRIVER=bullmq` 且 `UPSTASH_REDIS_URL` 已配置时，改用 Redis-backed queue；否则回退到原内存实现。
  - 维持了原本的接口：`enqueue()`、`getByDoc()`、`list()`、`stats()`、`retry()` 等。
  - 通过 `jobId = doc:${id}` 的方式保证对同一文档的去重。

- **当前状态**：
  - 代码层已接通，Upstash Vector / Redis 已配置并连接。
  - 尚未做 namespace 隔离（按知识库/租户区分索引与缓存 key）。

### C. Backblaze B2 + 托管 DB 接口（已部分落地）

- **当前状态**：
  - Backblaze B2 对象存储已实现 `upload` / `deleteFileVersion`（`server/src/services/storage/backblaze.js`），并已接入 `routes/documents.js` 的上传/删除流程；
  - 尚未实现 B2 的 `list` / `download` 接口，也未用真实凭证跑通完整上传-下载闭环；
  - 数据库已切换为纯 Supabase 直查（`db/supabase.js` 为真实实现），不再是本地内存/静态数据。
  - 剩余工作需真实域名 / token / bucket 方案与凭证来验证。

**3. 关键结论 / 决策 / 踩坑**

- **关键决策**：
  - 优先完成 `A`，即 Upstash Vector + embeddingService 接入，并确保端到端检索可用；
  - 其次完成 `B`，接入 `bullmq` 与 `Upstash Redis`；
  - 最后才做 `C`，结合 R2 文件存储和托管 DB。这个顺序是合理的，因为先保证向量能力可用，再保证异步任务可靠性，最后再把对象存储和元数据存储做成持久化基础。

- **踩坑记录**：
  1. **维度不匹配**：最早代码里随机生成的向量维度与 Upstash index 期望维度不一致（例如 1024 vs 1536）。已通过 `index.info()` 获取真实 `dimension` 后修正，正确使用 `dimension` 维度生成向量。
  2. **SDK API 错误**：原实现错误地调用了 `vectorClient.search()`，而 Upstash Vector SDK 实际应调用 `index.query()`。已修正。
  3. **Node 版本不一致**：项目 `package.json` 声明 `engines.node >=20.12.0 <23`，早期在 `v20.18.0` 环境安装/解析 `bullmq` / `ioredis` 时出现 `EBADENGINE` 警告和可解析问题（现已修正 engines 声明）。
  4. **optionalDependencies 语义问题**：把 `bullmq`/`ioredis` 放在 `optionalDependencies` 后，某些部署环境不会安装进去，导致运行时 `Cannot find package 'bullmq'`。代码已改成动态 import + fallback，但生产环境仍建议按最终部署策略移到正常依赖中。
  5. **不迁移本地数据**：当前明确不重新导入已发布文档/本地文档，这避免了不必要的数据变更和风险，但也意味着这不是“全量生产迁移”，只是架构验证与新文档写入的较安全路径。

**4. 产出物清单：文件、代码、命令、参数**

- 主要代码文件：
  - [server/src/services/vectorStore/upstash.js](server/src/services/vectorStore/upstash.js)
  - [server/src/services/embeddingService.js](server/src/services/embeddingService.js)
  - [server/src/services/indexQueue.js](server/src/services/indexQueue.js)
  - [server/scripts/test-upstash.js](server/scripts/test-upstash.js)
  - [server/.env.example](server/.env.example)

- 关键命令：

```bash
cd server
node scripts/test-upstash.js
# 生产环境 BullMQ 验证：
# 1) 安装运行时依赖： npm install bullmq ioredis
# 2) 配置 .env：
#    VECTOR_STORE=upstash
#    INDEX_QUEUE_DRIVER=bullmq
#    UPSTASH_VECTOR_URL=...
#    UPSTASH_VECTOR_API_KEY=...
#    UPSTASH_REDIS_URL=...
#    UPSTASH_REDIS_TOKEN=...
```

- 关键参数与版本：
  - `VECTOR_STORE=upstash`
  - `INDEX_QUEUE_DRIVER=bullmq`
  - `UPSTASH_VECTOR_URL` / `UPSTASH_VECTOR_API_KEY`
  - `UPSTASH_REDIS_URL` / `UPSTASH_REDIS_TOKEN`
  - `bullmq` 6.x（`^6.3.8`）
  - `ioredis` 5.x（`^5.11.1`）
  - Node 需 >=20.12（推荐），否则安装/运行更容易出现兼容问题。

**5. 已完成 / 未完成 / TODO 清单**

### 已完成

- [x] Upstash Vector 适配器实现并接入 `embeddingService`
- [x] `search()` 与 `deleteByDocumentId()` 修正为正确 SDK 使用方式
- [x] E2E `test-upstash.js` 验证成功（upsert/query/delete）
- [x] `indexQueue` 代码层已支持 `bullmq` / Redis（fallback to memory）
- [x] Backblaze B2 `upload` / `deleteFileVersion` 实现并接入 `routes/documents.js`
- [x] `db` 切换为纯 Supabase 直查
- [x] 文档 / 配置说明更新

### 未完成

- [ ] Upstash Vector / Redis namespace 隔离（按知识库/租户区分索引与缓存 key）
- [ ] Backblaze B2 的 `list` / `download` 接口接入（upload / delete 已实现）
- [ ] 迁移已有文档索引 / 数据迁移
- [ ] 真实 document upload flow + source registry 同步（B2 上传已接入，待真实凭证验证）

### 下一步（按优先级）

1. **修正运行环境**：升级 Node 至 `>=20.12`，并在 `server` 下正式安装 `bullmq` / `ioredis`。
2. **配置真实 env**：
   - `VECTOR_STORE=upstash`
   - `INDEX_QUEUE_DRIVER=bullmq`
   - `UPSTASH_VECTOR_URL` / `UPSTASH_VECTOR_API_KEY`
   - `UPSTASH_REDIS_URL` / `UPSTASH_REDIS_TOKEN`
3. **补 namespace 隔离**：为 Upstash Vector / Redis 引入 namespace 隔离（按知识库/租户区分索引与缓存 key），并在真实服务重启后调用 `enqueueIndexJob`，确认 BullMQ worker 从 Upstash Redis 拉取 job 并处理成功。
4. **Backblaze B2 补齐 + 凭证验证**：DB 已切换为纯 Supabase 直查；剩余工作为补齐 B2 的 `list` / `download` 接口，并在拿到 R2 bucket / token 后用真实凭证跑通上传-下载闭环。
5. **明确迁移边界**：当前要求仅新上传文档写入新架构，不处理历史已发布文档；历史文档可以留在本地或后续单独迁移脚本执行。

**6. 风险 / 注意事项**

- **Node 版本风险**：当前本地 runtime 为 `v20.18.0`，项目要求 `>=20.12`。在此版本上运行可能影响依赖安装与生产兼容性，建议升级到 Node 20.12+ 或 22 LTS。
- **依赖解析风险**：`bullmq` / `ioredis` 若只放在 `optionalDependencies`，部署环境可能不安装，导致 `Cannot find package 'bullmq'`。
- **R2 凭证风险**：Backblaze B2 的 upload/delete 已实现，但 list/download 接口及真实闭环验证需 R2 bucket/token 凭证。不要在公共仓库里直接放 token / password。
- **数据一致性风险**：不迁移历史文档是有意为之，但需要确认新上传文档可写入 Upstash Vector + BullMQ 的完整链路，避免新加文档出现未索引状态。
- **权限风险**：Upstash 账号需要有 vector index 读写权限，且需要允许 index 的创建/更新/删除操作；否则需手动在控制台创建 index。

**7. 下一步建议（按优先级）**

1. 切到 Node 20.12+ 环境，安装 `bullmq` 与 `ioredis`。
2. 真实配置 Upstash Vector + Upstash Redis 凭证，并设置：
   ```bash
   VECTOR_STORE=upstash
   INDEX_QUEUE_DRIVER=bullmq
   UPSTASH_VECTOR_URL=...
   UPSTASH_VECTOR_API_KEY=...
   UPSTASH_REDIS_URL=...
   UPSTASH_REDIS_TOKEN=...
   ```
3. 启动服务并做一个真实 `enqueueIndexJob` smoke test，确认 `BullMQ` 从 Redis 读出任务并执行成功。
4. 在拿到 Backblaze B2 bucket 及 DB 凭证后，补齐 `document upload` / `db` 接口。
5. 只针对新上传的文档做迁移和索引，保留历史 local docs 不动，按“按需迁移”策略处理。

---

## 可直接复制给新 AI 的交接 Prompt

```
你现在继承一个 Node.js ESM 项目（workspace 根路径已加载）。目标：完成并验证 Backblaze B2 + Upstash Vector + Upstash Redis + BullMQ 的企业知识库 RAG 架构。

已知事实：
- Upstash Vector adapter 已实现于 server/src/services/vectorStore/upstash.js，并和 server/src/services/embeddingService.js 连通；query/upsert/delete 端到端已验证。
- indexQueue 已支持 Redis-backed BullMQ 路径（server/src/services/indexQueue.js），Upstash Vector / Redis 已配置并连接，尚未做 namespace 隔离。
- 当前明确要求：不迁移现有已发布文档，不重建当前的本地文档，不强制把历史数据重新上传至新架构；优先保证新文档写入新架构链路可用。
- 仍未完成：Backblaze B2 的 list/download 接口接入；DB 已切换为纯 Supabase 直查，B2 上传/删除已实现。

关键任务：
1. 在 Node >=20.12 环境中安装 `bullmq` 与 `ioredis`。
2. 配置 `.env`：`VECTOR_STORE=upstash`, `INDEX_QUEUE_DRIVER=bullmq`, `UPSTASH_VECTOR_URL`, `UPSTASH_VECTOR_API_KEY`, `UPSTASH_REDIS_URL`, `UPSTASH_REDIS_TOKEN`。
3. 为 Upstash Vector / Redis 补 namespace 隔离后，启动服务执行 `enqueueIndexJob`，确认 `BullMQ` 从 Upstash Redis 拉取 job 并处理成功。
4. 收到 Backblaze B2 凭证后，补齐 `list` / `download` 接口并跑通真实上传-下载闭环（`db` 已 Supabase 直查，B2 上传/删除已实现）。
5. 继续保持历史本地文档不动，不做全量迁移；后续再按需单独重建/迁移。

请输出：
- Node 版本；
- Upstash Redis 和 Vector 配置是否可用；
- BullMQ worker 是否成功消费 job；
- R2/DB 凭证是否已拿到；
- 当前是 “新文档链路正常” 还是 “全量迁移/历史数据处理” 阶段。
```

---

文件已保存到： [docs/交接文档-Upstash-BullMQ.md](docs/交接文档-Upstash-BullMQ.md)
