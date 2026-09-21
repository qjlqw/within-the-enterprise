# Upstash Vector 集成计划（免费层）

目标：在不安装 Docker / 本地 DB 的情况下，把项目的向量存储切换到 Upstash Vector（或先作为可选驱动），保持本地 JSON 作为回退。文档包含安装、环境变量、示例 Node 适配器代码、以及需修改的关键函数点与测试步骤。

## 前提
- 拥有 Upstash 账号并创建 Vector 实例，获取 `UPSTASH_REST_URL` 和 `UPSTASH_REST_API_KEY`（免费层可用，注意配额和速率限制）。
- 项目已安装 Node.js/NPM，能在 `server` 目录执行 `npm install`。

## 环境变量（示例）
- `RAG_ENABLED=true`
- `EMBEDDING_API_KEY`（或复用 `LLM_API_KEY`）
- `VECTOR_STORE=upstash`    # 可选值：local|upstash
- `UPSTASH_REST_URL=https://<region>.api.upstash.com/vector/v1/<instance>`
- `UPSTASH_REST_API_KEY=<key>`

## 安装依赖（在 server 目录）
```bash
npm --prefix server install @upstash/vector
```

## 设计要点
- 新增一个“向量存储驱动层”（adapter），位于 `server/src/services/vectorStore/upstash.js`。
- `embeddingService` 仅负责切片与 embed；向量的持久化/检索委托给 `vectorStore`（通过 `VECTOR_STORE` env 选择具体实现）。
- 当 `VECTOR_STORE=local` 或 Upstash 不可用时回退到原本的本地 JSON 存储（`server/src/services/vectorStore/local.js`）。

## 示例：Upstash adapter（简化版）
创建 `server/src/services/vectorStore/upstash.js`：
```javascript
import { Vector } from "@upstash/vector";
import { config } from "../config/index.js";

let client = null;
export function initUpstash() {
  if (client) return client;
  client = new Vector({
    url: config.upstash.restUrl, // 从 config 中读取 UPSTASH_REST_URL
    token: config.upstash.apiKey, // UPSTASH_REST_API_KEY
  });
  return client;
}

export async function upsertVectors(items) {
  // items: [{ id, embedding, metadata, text }]
  const c = initUpstash();
  // Upstash Vector 支持 upsert 批量
  await c.upsert(items.map((it) => ({ id: it.id, vector: it.embedding, metadata: it.metadata })));
}

export async function deleteByDocumentId(documentId) {
  const c = initUpstash();
  // 假设 metadata.documentId 可用于过滤；Upstash 提供一些查询/删除 API，若不足可维护索引表
  // 这里为示例，实际需按 Upstash SDK 提供方法实现
}

export async function search(queryEmbedding, topK = 5) {
  const c = initUpstash();
  const resp = await c.search({ vector: queryEmbedding, topK });
  // resp.items -> map 回 fragment 结构
  return resp.items;
}
```

说明：上面为示意代码，实际实现需参考 `@upstash/vector` SDK 的 `upsert`/`search` 方法签名并对 metadata 与 id 的命名做兼容。

## 本地 driver（回退）
- 将当前 `embeddingService` 中的 `loadVectors`/`saveVectors`/`vectors` 读写逻辑抽成 `server/src/services/vectorStore/local.js`，并导出 `upsertVectors`/`deleteByDocumentId`/`search`。

## `embeddingService` 的修改点（关键函数）
- initVectorStore()
  - 原来直接调用 `loadVectors()` 与 `saveVectors()`；改为根据 `VECTOR_STORE` 选择 driver：
    - `const store = require('./vectorStore/'+config.vector.store)`
    - await store.init()；如果 store 已有数据则设置 `initialized=true`
- upsertDocument(doc)
  - 切片 + embeddings 后，不再直接 push 到 `vectors` 并 `saveVectors()`；而是调用 `vectorStore.upsertVectors(items)`。
- deleteDocument(docId)
  - 调用 `vectorStore.deleteByDocumentId(docId)`。
- semanticSearch({query})
  - 将原本在内存数组上做相似度计算的逻辑改为：
    - `queryEmbedding = await embeddings.embedQuery(query)`
    - `results = await vectorStore.search(queryEmbedding, limit)`
    - 将 `results` 映射成 fragment 结构返回。
- 保留本地 JSON 回退实现，当 Upstash 请求失败时捕获异常并回退到本地查询。

## 关键文件变更清单（候选）
- 新增：`server/src/services/vectorStore/upstash.js`
- 新增：`server/src/services/vectorStore/local.js`（抽离现有持久化逻辑）
- 修改：`server/src/services/embeddingService.js`（最小改动：调用 `vectorStore`，保留 chunk/embedding 逻辑）
- 修改：`server/src/config/index.js`（添加 `vector.store`, `upstash.restUrl`, `upstash.apiKey`）

## 示例 Node 使用（快速验证）
1. 设置环境变量：
```bash
export VECTOR_STORE=upstash
export UPSTASH_REST_URL=https://... 
export UPSTASH_REST_API_KEY=...
export RAG_ENABLED=true
export EMBEDDING_API_KEY=...
```
2. 安装依赖并启动：
```bash
npm --prefix server install
npm --prefix server run dev
```
3. 强制重建索引（可选）：
```bash
npm --prefix server run reindex
```
4. 在日志中检查 `向量库已就绪` 或监控 `indexQueue` 状态。

## 测试与回退策略
- 对每个向量驱动实现编写单元测试（模拟 Upstash 成功/失败）。
- 在 `semanticSearch` 中捕获 Upstash 错误并回退到 `local` store：
  - `try { return await store.search(...)} catch (err) { console.warn('upstash failed, fallback local'); return await localStore.search(...)} `

## 免费层注意事项
- Upstash 免费层有配额和速率限制（并发/每秒请求数与存储量），请参考 Upstash 控制台与文档，避免一次性大批量 upsert 导致配额耗尽。
- 推荐在 `reindex` 时分批上传（已有 `EMBED_BATCH_SIZE` 设计），并在 adapter 内实现指数退避重试。

## 我可以继续帮你做的事
- 实现 `server/src/services/vectorStore/upstash.js` 的完整代码并提交 PR（包含重试/错误处理）；
- 修改 `embeddingService` 以支持驱动切换并添加回退逻辑；
- 添加配置项到 `server/src/config/index.js` 并更新 `server/.env.example`。

---

文档生成于工作区，若需要我可以立即开始实现 adapter 并提交变更。