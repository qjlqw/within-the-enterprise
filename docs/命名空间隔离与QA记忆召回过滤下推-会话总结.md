# 命名空间隔离与 QA 记忆召回过滤下推 - 会话总结

> **生成时间**：2026-11-05（Asia/Shanghai）
> **最近更新**：2026-11-05（Asia/Shanghai）——追加"LLM Wiki 多人并发一致性加固（P0/P1/P2）"及迁移 0006 执行说明
> **文档目的**：记录本次会话中关于向量库命名空间隔离的排查结论、问题定位与方案取舍，归档"QA 记忆召回过滤下推"的实现细节，并记录 LLM Wiki 实体抽取在多人并发场景下的风险分级与加固方案，供后续维护与同类改造参考。
> **适用前提**：单个企业内部部署，不区分部门；已发布文档对全员可见。

---

## 一、结论速览

| 议题 | 结论 |
|---|---|
| 为什么 Upstash 里只有一个 `doc` 空间 | 设计上就有 3 个（doc / entity / qa），但 wiki、memory 开关默认关闭，后两个没有数据 |
| 是否需要拆更多命名空间 | 不需要。保持"数据类型 × 知识库"的粗粒度，用户/分类等条件用 metadata 过滤 |
| 用户隔离 | 当前无必要。向量库只索引已发布文档，而已发布文档在 DB 层对全员可见 |
| 公司隔离 | 当前无必要。单企业内部部署，且系统没有 tenant/company 概念 |
| 本次实际改动 | QA 记忆的 `userId` / `status` 过滤从"召回后应用层筛"改为"下推到向量库"；文档检索 `category` 同样下推 |
| 多人并发下的实体抽取 | 存在重复实体、状态被打回、摘要互相覆盖、重复抽取等问题，已按 P0/P1/P2 加固（见第八节） |

---

## 二、会话中发现的问题

### 问题 1：命名空间只有 `doc`，看起来"隔离没生效"

代码里已实现三个命名空间：

| namespace | 内容 | 写入位置 |
|---|---|---|
| `doc` | 已发布文档切片 | [embeddingService.js](../server/src/services/embeddingService.js) |
| `entity` | 知识图谱实体摘要 | [extractionService.js](../server/src/services/extractionService.js) |
| `qa` | 用户确认过的历史问答 | [qaMemoryService.js](../server/src/services/qaMemoryService.js) |

但 `WIKI_ENABLED`、`MEMORY_ENABLED` 在 [config/index.js](../server/src/config/index.js) 中默认 `false`，因此 `entity` / `qa` 从未写入，属于预期行为而非缺陷。

### 问题 2：namespace 粒度与检索成本

- **Upstash 驱动**：每个 namespace 是独立索引，`index.namespace(name).query()` 是一次独立请求，查询 N 个空间就是 N 次往返。
- **本地驱动**：每个 namespace 是一份 `vectors.${namespace}.json` + 全量驻留内存的数组，检索是 O(n×维度) 的暴力余弦。

因此命名空间数量直接等于召回成本倍数，绝不能按"每篇文档"或"每个用户"切分，应控制在 `数据类型 × 知识库` 这一层（总量 100 以内）。

### 问题 3（核心）：过滤后置导致召回缺失

改动前的 QA 召回逻辑：

```js
const candidates = await searchNamespace(NS, vector, candidatePool()); // 仅 10 条
for (const c of candidates) {
  if (String(c.metadata?.userId) !== String(userId)) continue; // 取回后才过滤
  if (c.metadata?.status !== "confirmed") continue;
}
```

`candidatePool()` = `max(10, qaTopK * 3)` = 10。当其他用户的问答向量占据 top10 时，当前用户会召回 **0 条**——不是变慢，而是功能失效。文档检索的 `category` 过滤（[embeddingService.js](../server/src/services/embeddingService.js) `semanticSearch`）存在同样问题：先取 topK 再过滤，被过滤掉的名额不会补位。

### 问题 4：用户隔离的现状与误解

"不同文档上传不同 id"不等于隔离。`documentId` 只用于删除映射与引用校验，不参与查询过滤。此外：

- 只有已发布文档会建向量，草稿不建向量；
- 已发布文档在 DB 层对全员可见（`canViewDocument`）；
- 检索工具拿到了 `userId` 但未使用，注释明确写着"保留扩展：未来可按用户过滤可见文档"。

所以此时做用户级向量隔离没有可观测效果，必须先有"私有/部门可见"的权限模型。

### 问题 5：公司级隔离是否需要

判断标准是"同一套部署里是否承载多个互不信任的数据主体"。本项目为单企业内部部署，用户表只有 `department` 字段，无 tenant/company，因此不需要。若未来可能转 SaaS，只需预留 `tenant_id` 字段并写入向量 metadata，不必现在就拆 namespace。

---

## 三、方案取舍

| 方案 | 隔离强度 | 索引数 | 查询成本 | 采用 |
|---|---|---|---|---|
| metadata filter 下推（共享 namespace） | 逻辑隔离 | 1 | 1 次请求 | ✅ 本次采用 |
| `doc:<tenantId>` 分片 namespace | 较强 | = 租户数 | N 次请求 | 租户 < 50 且需独立运维时再考虑 |
| 独立索引/实例 | 物理隔离 | = 租户数 | 按实例 | 强合规场景 |
| `doc:<userId>` | 最强 | = 用户数 | 成本爆炸 | ❌ 不采用 |

核心原则：**过滤条件下推后，`topK` 的语义从"全库前 K 条再筛"变为"满足条件的前 K 条"**，召回率不再被无关数据稀释；本地驱动同时把计算量从 O(全量) 降到 O(子集)。

---

## 四、本次改动明细

### 1. `server/src/services/vectorStore/upstash.js`

- 新增 `toLiteral`：数字/布尔原样输出，字符串单引号包裹并转义。
- 新增 `toFilterExpression`：把 `{ key: value }` 序列化为 Upstash filter 表达式，多条件用 `AND` 连接；数组值生成 `IN (...)`；空对象返回空串表示不过滤。
- `search(queryEmbedding, topK, namespace, opts)` 新增 `opts.filter`，有值时写入 `index.query({ ..., filter })`。

### 2. `server/src/services/vectorStore/index.js`

- `search` 增加第四个参数 `opts`，原样透传给 adapter，保持向后兼容。

### 3. `server/src/services/embeddingService.js`

- 新增 `matchMetadata`：本地驱动的等值/IN 匹配，统一转字符串比较，兼容 `userId` 数字与字符串两种写法。
- `searchNamespace(namespace, queryEmbedding, topK, opts)` 新增 `opts`：
  - Upstash 分支原样透传；
  - 本地分支在计算余弦**之前**执行 `filter`，实现语义一致的过滤下推。

### 4. `server/src/services/qaMemoryService.js`

- `searchHistoricalQA`：召回时传 `filter: { userId, status: "confirmed" }`，保证候选池全部是"本人 + 已确认"。
- `runQaWrite` 去重：传 `filter: { userId }`，避免他人高相似问答导致误判为重复。
- 原有的应用层 `userId` / `status` 校验保留，作为兜底（防止向量层过滤失效导致越权）。

---

## 五、效果与验证

### 预期效果

| | 改动前 | 改动后 |
|---|---|---|
| QA 候选池 | 10 条全局 topN，可能全是他人数据 | 10 条全部为本人已确认问答 |
| 召回结果 | 用户一多即退化为空 | 与用户数据量无关，稳定召回 |
| 本地计算量 | 全量向量参与余弦计算 | 仅参与过滤后的子集 |

### 验证方式

1. 设置 `MEMORY_ENABLED=true` 后启动服务。
2. 用两个账号分别提问并点击"有帮助"，使各自产生 `confirmed` 问答。
3. 账号 A 再次提出相似问题，检查日志与引用：应只召回 A 自己的历史问答，且条数不因 B 的数据量增加而减少。
4. 本地驱动（`VECTOR_STORE=local`）重复上述步骤，确认与 Upstash 驱动结果一致。

### 回归验证

```bash
cd server
node --check src/services/vectorStore/upstash.js
node --check src/services/vectorStore/index.js
node --check src/services/embeddingService.js
node --check src/services/qaMemoryService.js
```

---

## 六、风险与回滚

| 风险 | 说明 | 处理方式 |
|---|---|---|
| 历史向量缺少 `userId` / `status` 字段 | 过滤会把这些向量排除，表现为召回变少 | 本次字段在写入时即存在，无需重建；若曾手工写入过缺失字段的数据，需重新 upsert |
| 本地与 Upstash 行为不一致 | 两边过滤语义不同会导致环境差异 | 已用 `matchMetadata` 对齐等值/IN 语义；新增过滤能力时需同步两边 |
| filter 表达式中字符串转义 | 元数据含单引号可能破坏表达式 | `toLiteral` 已对 `\` 与 `'` 转义；新增字段时避免把自由文本作为过滤键 |
| 回滚 | —— | 移除 `qaMemoryService` 中传入的 `opts` 即可回到原行为，其余改动均为可选参数、向后兼容 |

---

## 七、后续建议

1. **不要急于做用户/公司级隔离**：需先引入"私有 / 部门可见 / 公开"的权限模型，再改 metadata 与检索链路，否则没有可观测效果。
2. **若确定要做多租户**：给 `documents` 增加 `tenant_id` 默认值，并在建索引时写入 metadata，查询侧加 filter 即可，不要开 namespace。
3. **`entity` 空间验证**：开启 `WIKI_ENABLED` + `WIKI_EXTRACT_ENABLED`，发布文档后确认 `entity` namespace 产生数据，并验证实体摘要检索效果。
4. **删除能力补全**：Upstash 驱动目前仅支持按 `documentId` 删除向量（依赖 Redis 映射），新增其它业务 namespace 时需自行维护 `业务 id → vectorId` 映射。
5. **文档侧同类优化**：`semanticSearch` 的 `category` 过滤仍为"召回后过滤"，可按同样方式下推，减少分类检索时返回条数不足的问题。（✅ 已完成，见第八节 P2-3）

---

## 八、LLM Wiki 多人并发一致性加固（2026-11-05 追加）

### 8.1 场景与风险分级

场景：单个企业内多人同时发布/编辑文档，`WIKI_ENABLED` 开启后抽取任务共用同一个实体库（`entities` / `relations`）。

先说结论：**不会出现死循环或无休止重试**（抽取任务有 `maxAttempts` + 指数退避，写入失败不会再次触发抽取）。真正的风险是**数据层面的一致性事故**，按严重程度分级如下：

| 级别 | 问题 | 触发方式 | 后果 |
|---|---|---|---|
| 🔴 P0-1 | 已确认实体被抽取任务"重置" | 更新文档触发重抽，旧代码无条件写 `status: "pending"` | 人工审核结论丢失，实体从可检索状态变回待审，需反复审核 |
| 🔴 P0-2 | 同名实体重复行 | 两个任务同时 `findEntityByName` 未命中，各自 `insert` | `maybeSingle()` 遇多行报错 → 该名称后续**所有**抽取任务永久失败 |
| 🟠 P1-1 | 同一版本重复抽取 | 发布 + 更新 + 手动重试多次入队 | 重复调用 LLM（成本/延迟），并对同一实体反复写库 |
| 🟠 P1-2 | 摘要/类型被"最后写入者"覆盖 | 两篇文档对同一实体给出不同口径 | 审核人看不到冲突来源，无法判断哪个正确 |
| 🟡 P1-3 | 关闭开关后 worker 停滞 | BullMQ 侧 `while (!isReady()) await sleep(2000)` | `concurrency: 1` 的执行位被永久占住，队列整体不前进 |
| 🟠 P2-1 | 文档删除/下线后 sources 不清理 | 只删了文档与向量，实体 `sources` 仍指向它 | 知识图谱长期保留"来源不存在"的实体/关系 |
| 🟠 P2-2 | 审核并发覆盖 | 两个管理员同时确认/驳回同一实体 | 后写覆盖先写，审核记录不可信 |
| 🟢 P2-3 | 文档检索分类过滤后置 | `semanticSearch` 先取 topK 再筛分类 | 目标分类可能被热门分类挤出，返回条数不足 |

### 8.2 改造方案与落点

#### P0-1 实体状态机保护

- [knowledgeGraph.js](../server/src/db/knowledgeGraph.js) `mergeIntoEntity`：合并时 `status: existing.status`，抽取不再把 `confirmed` / `rejected` 打回 `pending`。
- `confirmed` / `rejected` 的实体同时保留原 `summary` 与 `type`，抽取只做 `aliases` / `sources` 并集与逐来源摘要记录。
- 新实体仍一律 `pending`，保持"仅人工确认后才参与检索"的硬约束。

#### P0-2 唯一约束 + 原子写

- 迁移 [0006_wiki_consistency.sql](../server/migrations/0006_wiki_consistency.sql)：
  - `entities.name_key`（generated `lower(btrim(name))`）+ 唯一索引 `uq_entities_name_key`；
  - `relations` 唯一索引 `uq_relations_triple(subject_id, predicate, object_id)`；
  - 执行前先合并历史重复数据：关系先改指向保留实体（`min(id)`），再删除重复实体、去重重复关系。
- [knowledgeGraph.js](../server/src/db/knowledgeGraph.js) `upsertEntity` / `upsertRelation`：插入捕获 `23505`（唯一冲突）后重新查询并转为合并，把"先查后插"的 TOCTOU 收敛成"插入失败即合并"。
- [supabase.js](../server/src/db/supabase.js) `findEntityByName` 增加 `order("id").limit(1)`，避免迁移前残留重复行时 `maybeSingle` 直接报错。

#### P1-1 抽取幂等（版本守卫）

- 迁移新增 `documents.extracted_version`，`fromDocumentRow` 映射为 `extractedVersion`。
- [extractionService.js](../server/src/services/extractionService.js) `runExtraction`：
  1. 入口：`extractedVersion === version` 直接跳过并审计 `extract_job.skipped(reason=already_extracted)`；
  2. LLM 抽取完成、写库之前**重新读取文档**：若已下线或 `version` 变化，丢弃结果并审计 `reason=document_changed`（避免旧内容覆盖新内容）；
  3. 写库成功后 `setDocumentExtractedVersion(doc.id, doc.version)`。
- 保留"全部分片失败则抛错重试"的既有语义，幂等只消除"成功后的重复执行"。

#### P1-2 摘要冲突可见化

- 迁移新增 `entities.summary_by_source jsonb`（每个来源文档的摘要口径）与 `needs_review boolean`。
- 合并规则：首个摘要生效；后续来源口径不同时**不覆盖**，改为 `needsReview = true` 并在 `summaryBySource` 中保留各自版本；审核人可对比后手工修改。
- `confirmEntity` / `rejectEntity` 在通过审核后清除 `needsReview`。

#### P1-3 去除 worker 忙等

- [indexQueue.js](../server/src/services/indexQueue.js) BullMQ worker：`while (!isReady()) await sleep(2000)` 改为 `if (!isReady()) return { skipped: true, reason: "not_ready" }` + 审计 `*_job.skipped`。
- 语义变化：开关关闭期间任务不再挂起等待，而是记为完成（`skipped`）；重新开启后由文档变更/手动重试重新入队。内存驱动保持原有 `waiting` 语义不变。

#### P2-1 sources 清理

- 新增 [knowledgeGraph.js](../server/src/db/knowledgeGraph.js) `detachDocumentSources(documentId)`：
  - 实体：从 `sources` 移除该文档、删除 `summaryBySource` 对应键；来源清空时 `needsReview = true`（交人工决定是否保留）；
  - 关系：来源清空则删除关系，否则更新来源。
- 调用点：[routes/documents.js](../server/src/routes/documents.js) 的 `DELETE /:id`，以及 `PUT /:id` 中"发布 → 非发布"的状态转换；均为 best-effort（失败只审计，不影响主流程）。
- 支撑查询：`listEntitiesBySource` / `listRelationsBySource`（`sources` 上的 GIN 索引），`updateRelation` / `deleteRelationById`。

#### P2-2 审核并发保护

- `updateEntityIfStatus(id, expectedStatus, patch)`：`UPDATE ... WHERE id = ? AND status = 'pending' RETURNING *`。
- `confirmEntity` / `rejectEntity` 改用条件更新，后到的审核人得到 `实体状态已变更，请刷新后重试`，而不是静默覆盖。

#### P2-3 文档分类过滤下推

- [embeddingService.js](../server/src/services/embeddingService.js) `semanticSearch`：构造 `filter = category ? { category } : undefined`，Upstash 分支透传给 `vectorStore.search`，本地分支用 `matchMetadata` 在算余弦之前过滤。
- 效果：`topK` 变为"该分类下的前 K 条"，不再被其它分类稀释。

### 8.3 改动文件清单

| 文件 | 改动 |
|---|---|
| `server/migrations/0006_wiki_consistency.sql` | 新增：唯一索引、`summary_by_source`、`needs_review`、`extracted_version`、重复数据合并、GIN 索引 |
| `server/src/db/supabase.js` | 行映射扩展、`updateEntityIfStatus`、`listEntitiesBySource`、`listRelationsBySource`、`updateRelation`、`deleteRelationById`、`setDocumentExtractedVersion`、`findEntityByName` 容错 |
| `server/src/db/index.js` | 导出 `setDocumentExtractedVersion` |
| `server/src/db/knowledgeGraph.js` | 状态机保护、摘要冲突记录、23505 转合并、关系 sources 合并、条件确认/驳回、`detachDocumentSources` |
| `server/src/services/extractionService.js` | 版本幂等、写库前版本守卫、`sourceId` 传入、抽取成功后记录版本 |
| `server/src/services/indexQueue.js` | BullMQ worker 去掉忙等，改为跳过返回 |
| `server/src/services/embeddingService.js` | `semanticSearch` 的 `category` 过滤下推 |
| `server/src/routes/documents.js` | 删除 / 下线文档后调用 `detachDocumentSources`（best-effort + 审计） |

---

## 九、迁移执行与验证（2026-11-05 追加）

### 9.1 执行迁移

迁移脚本会**合并重复数据**，务必先备份：

1. 在 Supabase 控制台备份 `entities`、`relations`（或整库快照）。
2. 在 SQL Editor 依次执行 [0006_wiki_consistency.sql](../server/migrations/0006_wiki_consistency.sql)。
3. 校验：

```sql
select count(*) from (
  select lower(btrim(name)) from entities group by 1 having count(*) > 1
) t;                                                        -- 应为 0
select count(*) from (
  select subject_id, predicate, object_id from relations
  group by 1,2,3 having count(*) > 1
) t;                                                        -- 应为 0
```

> 若暂不执行迁移：代码仍可运行（插入冲突不会出现，`extracted_version` 更新失败只记审计），但 P0-2 的语义保证与 P1-1 的版本幂等不会生效。

### 9.2 验证清单

| 场景 | 预期 |
|---|---|
| 同一文档重复入队抽取 | 第二次日志出现 `extract_job.skipped reason=already_extracted`，无 LLM 调用 |
| 抽取过程中编辑文档 | 日志出现 `extract_job.skipped reason=document_changed`，实体库不被旧内容覆盖 |
| 两文档对同一实体给出不同摘要 | 实体 `needsReview = true`，`summaryBySource` 含两个来源的口径，摘要保持首个 |
| 已确认实体所在文档被再次发布 | 实体仍为 `confirmed`，不会回到 `pending` |
| 两个管理员同时确认同一实体 | 后到者收到"实体状态已变更，请刷新后重试" |
| 删除文档 | 关系来源清空被删除；实体来源清空后 `needsReview = true` |
| 关闭 `WIKI_ENABLED` 后入队 | BullMQ worker 记录 `*_job.skipped`，队列继续处理后续任务 |
| 分类检索 | 返回条数稳定为 `limit`（该分类数据足够时），不再被其它分类挤出 |

### 9.3 回归校验

```bash
cd server
node --check src/services/extractionService.js
node --check src/services/indexQueue.js
node --check src/services/embeddingService.js
node --check src/db/supabase.js
node --check src/db/knowledgeGraph.js
node --check src/db/index.js
node --check src/routes/documents.js
```

---

## 十、遗留说明（2026-11-05 追加）

1. **实体/关系均为 `pending` 时不可检索**：多人并发不会造成"前后矛盾的自问自答"，因为未确认实体不参与 `lookup_entity`，真正的一致性风险集中在审核人操作与重复抽取上，已由 P0/P1 覆盖。
2. **关系没有独立的审核结论保护**：目前只在三元组层面去重并合并来源，尚无 `confirmed/rejected` 状态机；若后续关系也参与检索，需要照搬实体的条件更新方案。
3. **`detachDocumentSources` 为同步逐条更新**：单文档影响的实体/关系数量通常有限；若单文档关联实体达数百条，建议改为批量 `update ... where id = any(...)`。
4. **幂等依赖 `documents.version`**：只在"更新文档即递增版本"的现有约定下成立；若将来出现不递增版本的原地修改，需要额外的内容哈希。

