# Agent 记忆体系（短期压缩 + 长期 QA 记忆）差距与方案

> 目标：给现有 Agent 加上「记忆」。短期记忆 = 上下文压缩 + 会话管理；长期记忆 = 高质量问答对的向量化存储与检索。让 Agent 能「记住之前聊过什么」「复用历史解答」，都记不住时才回退到 RAG 或结构化知识库（LLM Wiki）。

## 一、目标流程

```
用户提问
   │
   ▼
ReAct Agent 思考（Thought，见《ReAct 推理链路演进差距与方案》）
   │
   ├─ 涉及「之前聊过什么」      → searchSessionMemory（短期记忆检索）
   ├─ 可能有类似历史解答        → searchHistoricalQA（长期记忆检索）
   └─ 都不够                   → 回退 RAG（search_documents/read_document）
                                 ｜或 LLM Wiki（结构化层，见《结构化知识库演进差距与方案》）
   │
   ▼
生成回答
   │
   ▼
(异步) 质量过滤 → 高质量问答对向量化 → 写入长期记忆库（不阻塞响应）
```

## 二、现状盘点（代码事实）

| 能力 | 现状 | 位置 |
|---|---|---|
| 会话管理 | ✅ 已有（内存 SessionStore，20 会话/用户、24h 过期、单并发、限流） | `../server/src/agent/sessionStore.js` |
| 历史回放 | ⚠️ 只做「最近 10 轮 / 24000 字符」**截断**，无压缩 | `sessionStore.js:114` `history()` |
| 上下文压缩 | ❌ 无（截断会直接丢弃窗口外的早期关键信息） | — |
| 长期记忆（QA 向量化） | ❌ 无（向量库只服务于**文档**，不存 QA） | `../server/src/services/embeddingService.js` |
| 记忆检索工具 | ❌ 无（只有 `search_documents` / `read_document`） | `../server/src/agent/tools.js` |
| QA 质量过滤 | ❌ 无（没有任何「该不该存」的判定） | — |
| 异步写回队列 | ✅ 已有可复用模式（指数退避 + 串行 + 审计） | `../server/src/services/indexQueue.js` |

关键结论：**短期记忆只有「截断」没有「压缩」，长期记忆整体缺失**。现有 `indexQueue` 的异步队列模式可直接复用来做「QA 异步写回」。

## 三、差距分析

对照目标，缺口如下：

1. **上下文压缩缺失**：`history()` 粗暴截断到最近 10 轮，超过 `historyChars` 直接丢弃。用户早先确认过的事实、偏好、约束会在长会话中丢失，导致 Agent「失忆」。需要把窗口外的旧回合**压缩成摘要**回放，而不是丢弃。

2. **长期记忆整体缺失**：没有任何 QA 向量库。历史问答只在「当前会话」内存里（还只留 10 轮），跨会话、跨时间完全无法复用。需要独立的 QA 记忆向量库 + 检索。

3. **记忆检索工具缺失**：Agent 无法主动查记忆，只能被动接收注入的历史。需要 `searchSessionMemory` / `searchHistoricalQA` 两个工具。

4. **质量过滤缺失（关键约束）**：若不加过滤地向量化所有 QA，低质量/错误/被用户放弃的回答会污染检索结果。必须「只存被用户确认过、或经过验证的高质量问答对」。

5. **流程编排缺失**：当前是「直接 RAG」，没有「记忆优先 → 回退 RAG」的分层路由。

## 四、目标架构

```
┌────────────────────────────────────────────────────────┐
│ Agent（ReAct 循环 + 工具白名单）                         │
│   search_documents / read_document  (RAG)               │
│   searchSessionMemory  (短期记忆)          ← 新增        │
│   searchHistoricalQA   (长期记忆)          ← 新增        │
└───────────────┬────────────────────────────────────────┘
                │
   ┌────────────┴─────────────┐
   │                          │
   ▼ 短期记忆                  ▼ 长期记忆
SessionStore                QA Memory Store（新增）
 - turns(原文，近10轮)         - { question, answer, sources,
 - summary(压缩摘要) ←新增       userId, sessionId, status, embedding }
 - 会话管理(已有)               - 与文档向量库隔离
                                - 质量过滤后才入库
```

### 4.1 短期记忆：上下文压缩

在 `sessionStore.history()` 基础上扩展为「分层回放」：

- **近期 N 轮**（如 3 轮）：保留原文，保证上下文连贯
- **更早回合**：由 LLM 压缩为滚动摘要（`summary`），随会话存储
- **超长时**：对摘要做二级压缩，防止摘要无限膨胀

压缩**异步 + 惰性**执行（回合完成后后台触发），不阻塞问答；摘要缓存到 session 字段，随 24h TTL 过期。

### 4.2 长期记忆：QA 向量库

新增独立的 QA 记忆向量库，与文档向量库**隔离**（独立 index 文件 / 独立 collection）：

```js
qaMemory = [{
  id, question, answer,
  sources: [sourceId...],       // 溯源（复用来源校验）
  userId, sessionId,
  status,                        // pending / confirmed / rejected
  score,                         // 质量分（可选）
  embedding,                     // question+answer 的向量
  createdAt, updatedAt
}]
```

检索 `searchHistoricalQA(query)` 返回语义最相近的历史高质量问答对（带溯源），供 Agent 复用。

## 五、分阶段落地

### P0 —— 长期记忆最小闭环（验证价值）

- [ ] 新增 QA 记忆存储层（沿用 db 适配器模式：内存 + local/hosted/supabase）
- [ ] 新增 QA 向量库，与文档向量库隔离（独立 `qaVectors.json` / 独立 collection）
- [ ] 新增 `searchHistoricalQA` 工具，语义检索历史高质量 QA
- [ ] 新增「QA 写回」异步队列（复用 `indexQueue` 模式，指数退避）
- [ ] 回答完成后异步入队：向量化 → 写入长期记忆（不阻塞 SSE 响应）

**验收**：回答一次后，新会话问类似问题，Agent 能通过 `searchHistoricalQA` 命中历史解答并引用。

### P1 —— 质量过滤（关键约束落地）

- [ ] 定义 `status` 状态机：`pending`（自动验证通过）→ `confirmed`（用户显式确认）/ `rejected`
- [ ] 自动验证规则：回答 `completed` + 通过来源校验 + 非空 + 未触发 TOOL_LIMIT/MODEL_ERROR
- [ ] 用户确认信号：点赞 / 点「有帮助」/ 采纳，触发 `pending → confirmed`
- [ ] 检索默认**只召回 `confirmed`**（可选放宽到 `pending`）
- [ ] 相似问题去重（向量相似度阈值，避免同题反复入库）

**验收**：只有被确认/验证的高质量 QA 进入可召回集，低质量回答不污染检索。

### P2 —— 短期压缩 + 分层路由

- [ ] `sessionStore` 增加 `summary` 字段 + 滚动摘要压缩（异步、惰性）
- [ ] `history()` 升级为分层回放：近期原文 + 早期摘要
- [ ] 新增 `searchSessionMemory` 工具，检索当前会话完整历史 + 摘要
- [ ] 系统提示词升级：明确「记忆优先 → 回退 RAG」的决策顺序
- [ ] 记忆检索命中与 RAG 命中的来源合并/去重（复用 `SourceRegistry`）

**验收**：长会话中早期确定的事实仍能被召回；「之前聊过 X」类问题优先命中记忆。

## 六、关键设计决策

### 6.1 向量库隔离（QA 与文档必须分开）

现有 `embeddingService.js` 的向量条目以 `documentId/version/offset` 为 metadata，是文档专用。QA 记忆若混入，会破坏 `sourceIsValid` 校验、污染文档检索。必须：

- 复用 embedding 客户端（`embeddingModel` / API key）
- 但使用独立存储（独立 JSON 文件或独立 Upstash collection）
- QA 条目的 metadata 是 `question/answer/sources/status`，与文档 metadata 结构解耦

### 6.2 质量过滤触发（关键约束）

「只存高质量」落地为两层：

| 层级 | 触发 | 结果 |
|---|---|---|
| 自动验证 | 回答 completed + 来源校验通过 + 无异常 | `pending` |
| 用户确认 | 点赞/采纳/「有帮助」反馈 | `confirmed` |

- **失败/取消/无来源/空回答一律不存**
- 检索默认只召回 `confirmed`；`pending` 仅作为候选池，降低污染风险

### 6.3 异步写回（不阻塞响应）

在 `routes/agent.js` 的成功收尾（阶段 4a）之后、`finally` 之前，把「QA 向量化」入队，**绝不在 SSE 请求内同步 await**。复用 `indexQueue` 的「串行 + 指数退避 + 审计 + 失败标记」模式。

### 6.4 数据层适配

- 短期摘要：session 内存字段（随 24h TTL 过期，无需单独持久化，多实例时随 session 一起迁移）
- 长期 QA 记忆：需持久化，遵循 `db/index.js` 的 `local / hosted / supabase` 适配器模式
- QA 向量：遵循 `vectorStore` 的 `local / upstash` 适配器模式

### 6.5 与来源校验（[Sx]）的兼容

历史 QA 的 `answer` 里可能包含 `[Sx]` 引用。被 `searchHistoricalQA` 召回时，这些编号可能与当前 `SourceRegistry` 的编号冲突或失效。需在回放历史 QA 时**剥离或重新映射**来源编号，避免误引用（复用 `sourceIsValid` 判断来源是否仍有效）。

### 6.6 隐私与权限

- QA 记忆按 `userId` 隔离，`searchHistoricalQA` 只能检索本人记忆
- 不含提问正文的审计（沿用 `agent.run` 的 audit 字段设计）
- 敏感问答不落长期记忆（可加「不记忆」开关或分类过滤）

## 七、风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| 低质量 QA 污染检索 | 回答质量下降 | 质量过滤（pending/confirmed）+ 只召回 confirmed |
| QA 记忆与文档答案冲突 | 新旧答案打架 | 保留溯源 + 时间戳，提示以文档为准 |
| 记忆无限增长 | 成本/延迟 | 相似去重 + TTL + 容量上限 |
| 压缩摘要丢失细节 | 早期关键信息丢失 | 近期原文 + 早期摘要的分层策略 |
| 隐私泄露（跨用户召回） | 安全 | userId 隔离 + 审计 |
| 来源编号跨会话失效 | 误引用 | 回放时重映射/失效检测 |

## 八、落地检查清单

1. [ ] QA 记忆存储层（db 适配器）+ QA 向量库（与文档隔离）
2. [ ] `searchHistoricalQA` 工具 + 接入 Agent
3. [ ] QA 写回异步队列（复用 indexQueue 模式）
4. [ ] 质量过滤：status 状态机 + 自动验证 + 用户确认
5. [ ] 检索只召回 confirmed + 相似去重
6. [ ] `sessionStore` summary 压缩（异步、惰性）
7. [ ] `history()` 分层回放（近期原文 + 早期摘要）
8. [ ] `searchSessionMemory` 工具
9. [ ] 系统提示词升级为「记忆优先 → 回退 RAG」
10. [ ] 来源编号跨会话重映射 / 失效检测

> 结论：短期记忆目前只有「截断」、长期记忆完全缺失。核心动作是两条——① 把 `history()` 从截断升级为「分层压缩」；② 新增「QA 记忆向量库 + 质量过滤 + 异步写回」，并补上 `searchSessionMemory` / `searchHistoricalQA` 两个工具。三者共同构成「短期 + 长期」记忆体系，使 Agent 先查记忆、再回退 RAG / LLM Wiki。
