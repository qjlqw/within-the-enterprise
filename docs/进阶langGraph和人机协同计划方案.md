# AI Agent 与 RAG 能力升级方案

> 面向"AI 智能体研发工程师"岗位 JD 的能力补齐清单。每一项标注：技术栈、实现点、重点、难点、实现步骤。所有方案均基于现有 TS + Express 项目，不引入 Python / Docker / 本地数据库。

---

## 一、Rerank —— 接入 gte-rerank API 进 searchDocumentsHybrid

### 1.1 现状与目标

现有 [searchDocumentsHybrid](server/src/services/knowledgeService.js) 是"向量召回 + 关键词加权融合"，每篇文档独立打分，模型不看 query 与文档的交互。目标是补一步 **cross-encoder 精排**：召回 top-20 → rerank → 取 top-5 给 Agent。

### 1.2 技术栈

| 项          | 选型                      | 说明                                |
| ----------- | ------------------------- | ----------------------------------- |
| Rerank 模型 | DashScope `gte-rerank-v2` | OpenAI 兼容 HTTP API，纯 fetch 调用 |
| 文档        | 无新增依赖                | 复用现有 `fetch` / `node:https`     |

### 1.3 实现点

- 新增 `server/src/services/rerankService.js`
- 改造 `server/src/services/knowledgeService.js` 的 `searchDocumentsHybrid`：召回后增加 rerank 步骤
- 配置项加在 `server/src/config/index.js` 的 `rag` 块

### 1.4 重点

1. **召回与精排的分工**：召回阶段向量召回 topK 调大到 20（`RAG_TOP_K=20`），rerank 后才取最终 5 条。否则 rerank 输入太少没意义。
2. **降级链路**：rerank API 失败、超时、未配置时，回退到当前融合打分，不阻断主流程（与你现有 [embeddingService 降级策略](server/src/services/embeddingService.js) 一致）。
3. **分数归一化**：rerank 输出的是 `relevance_score`（0~1），直接作为 finalScore 替换融合分，简化排序逻辑。

### 1.5 难点

- **延迟预算**：rerank 是同步阻塞调用，top-20 rerank 约增加 200-500ms。需要把 `AGENT_RUN_TIMEOUT_MS` 考虑进去，或在 rerank 前后加耗时打点。
- **API 不兼容**：`gte-rerank` 不是 OpenAI Chat 格式，需要自己拼请求体（`{"model":"gte-rerank-v2","query":"...","documents":["..."]}`）。
- **文档长度限制**：单条 document 文本不能太长（通常 ≤ 2048 字符），需要在 chunk 阶段保证 chunkSize ≤ 500（已满足）。

### 1.6 实现步骤

1. 新建 `rerankService.js`：封装 `rerank({ query, documents, topN })`，返回 `[{ index, relevance_score }]`，内部处理超时与错误降级
2. `config/index.js` 加 `rag.rerankEnabled` / `rag.rerankModel` / `rag.rerankTopK`（默认 20→5）
3. `searchDocumentsHybrid` 召回后调 `rerank`，按 score 重排取 top-5；rerank 失败则用融合分兜底
4. 测试：在 [agent-evaluate.js](server/scripts/agent-evaluate.js) 的评估用例上加"rerank 后命中率"对比维度

---

## 二、LangGraph 重构 + Human-in-the-loop

### 2.1 现状与目标

现有 [buildAgent](server/src/agent/index.js) 用 LangChain v1 的 `createAgent` + middleware，是单 Agent ReAct 循环。目标是改为 **LangGraph.js StateGraph**，并加入 checkpointer（中断恢复）与 `interrupt()`（人机协同）。

### 2.2 技术栈

| 项         | 选型                                   | 说明                                        |
| ---------- | -------------------------------------- | ------------------------------------------- |
| 图框架     | `@langchain/langgraph`                 | 官方 JS 版，与 Python 版功能对齐            |
| 检查点存储 | `MemorySaver`（内存）/ `PostgresSaver` | MemorySaver 仅进程内有效，重启即丢、不支持多实例；需要重启/多实例恢复时换 PostgresSaver |
| 状态定义   | TypeScript 接口 + `Annotation`         | 描述 messages / sources / step 等           |

### 2.3 实现点

- 新增 `server/src/agent/graph.js`：定义 StateGraph、节点、边、checkpointer
- 改造 `server/src/agent/index.js`：`runAgent` 调用 graph 而非 createAgent
- 改造 `server/src/agent/sessionStore.js`：存 `thread_id`，复用 LangGraph checkpointer
- 路由 `server/src/routes/agent.js`：加 `POST /sessions/:id/resume` 端点用于恢复中断

### 2.4 重点

1. **State 设计**：把现有 `messages` / `sources` / `stats` 抽象为 `AgentState`，用 `Annotation.Root` 定义 reducer（messages 用 `messagesStateReducer` 做追加合并）
2. **节点拆分**：把 `wrapModelCall` / `wrapToolCall` 的限流逻辑从 middleware 搬到 `callModel` 节点前后的 guard 节点，逻辑更清晰
3. **checkpointer 配置（能力边界）**：`MemorySaver()` 只是**进程内存**检查点：同一进程存活期间，每次节点执行后写入内存 state，调用时传 `thread_id = sessionId`，可恢复同一线程被 `interrupt()` 挂起的运行（如用户刷新页面后接续审批）。它**不支持**服务重启恢复（进程退出内存即清空），也**不支持**多实例部署（不同实例内存互不可见）。需要重启/断线/多实例恢复时，必须换用 `PostgresSaver` 等持久化 checkpointer；当前项目暂无数据库条件，因此本阶段只能依赖内存检查点，重启后会话与中断状态都会丢失
4. **interrupt() 机制**：在工具调用节点后插入条件边，若工具返回 `needsApproval: true` 则 `interrupt()`，等待前端 `resume` 调用

### 2.5 难点

- **streamEvents 兼容**：LangGraph 的 `graph.streamEvents` 与 `createAgent` 的事件结构略有差异，现有 [runAgent](server/src/agent/index.js) 的 `on_chat_model_stream` 监听需要适配
- **SourceRegistry 跨节点（不可整体入 checkpoint）**：现有 SourceRegistry 内部持有 `Map` 及校验回调（闭包函数），这些都**不是可序列化的普通 JSON**，直接放进 LangGraph checkpoint state 会导致序列化失败或恢复后行为异常。正确做法是分层：state 中只保存**纯 JSON 来源记录**（如 `{ docId, chunkId, title, version, score }[]`），节点运行开始时根据这些记录**重建** SourceRegistry（重新绑定 Map 与校验回调）；回调依赖的服务（文档库、版本校验）通过节点上下文/依赖注入获取，不进入 state。换句话说：state 存"数据"，registry 作为"运行时对象"在每次节点执行时按数据重建
- **interrupt 状态暴露**：前端要感知"Agent 正在等人确认"，需要 SSE 推一个 `interrupted` 事件，并展示确认 UI
- **历史兼容**：现有会话历史是 `{ messages, sources }` 结构，迁移到 LangGraph state 需要适配器转换

### 2.6 实现步骤

1. `npm i @langchain/langgraph`
2. 定义 `AgentState = Annotation.Root({ messages, sources, stats, step, awaitingApproval })`
3. 建 `callModel` 节点（调模型）→ `shouldContinue` 条件边（检查是否有 tool_calls）→ `callTool` 节点（执行工具）→ 回 `callModel`；`END` 边判断无 tool_calls
4. 用 `MemorySaver` 编译 graph，`runAgent` 改为 `await graph.invoke({ messages }, { configurable: { thread_id: sessionId }, signal })`
5. human-in-the-loop：在 `callTool` 前插入 `interrupt({ toolCall, reason })`，前端 `POST /resume` 时调 `graph.invoke(null, { configurable: { thread_id }, command: { resume: { approved: true } } })`

---

## 三、MCP 协议接入

### 3.1 现状与目标

Agent 工具是项目内部 `tool()` 定义，硬编码在 [tools.js](server/src/agent/tools.js)。目标是引入 **MCP（Model Context Protocol）**，让 Agent 能消费外部 MCP Server 暴露的工具，或反向把自己的工具暴露为 MCP Server。

### 3.2 技术栈

| 项       | 选型                        | 说明                            |
| -------- | --------------------------- | ------------------------------- |
| SDK      | `@modelcontextprotocol/sdk` | 官方 TS SDK，MCP 协议发起方     |
| 传输     | stdio / SSE / WebSocket     | 本地工具用 stdio，跨服务用 SSE  |
| 工具适配 | LangChain 的 `loadMcpTools` | 把 MCP tool 转为 LangChain tool |

### 3.3 实现点

- 新增 `server/src/agent/mcpClient.js`：管理 MCP Server 连接
- 改造 `server/src/agent/tools.js`：合并本地工具与 MCP 工具
- 配置 `server/.env`：`MCP_SERVERS=stdio://./bin/search-server,https://mcp.example.com/sse`

### 3.4 重点

1. **工具白名单**：现有 [wrapToolCall](server/src/agent/index.js) 校验工具名在白名单内，MCP 工具动态加载时白名单也要动态更新
2. **来源注册兼容**：MCP 工具返回的内容如果是知识片段，也要走 `registry.register`，保证 [Sx] 引用制不破
3. **错误隔离**：单个 MCP Server 挂掉不能影响 Agent 主流程，要 try/catch 并降级为"工具不可用"

### 3.5 难点

- **生命周期管理**：MCP Server 是长连接，Express 进程退出时要优雅关闭，避免僵尸进程
- **权限边界**：MCP Server 暴露的工具可能是写入类（如发邮件），要加权限校验层，与现有"工具只读"约束冲突时优先拒绝
- **Schema 适配**：MCP 工具用 JSON Schema，LangChain 用 zod，需要双向转换

### 3.6 实现步骤

1. `npm i @modelcontextprotocol/sdk`
2. `mcpClient.js`：启动时读 `MCP_SERVERS` 配置，逐个连接，用 `loadMcpTools` 转为 LangChain tool 数组
3. `tools.js`：`createKnowledgeTools` 末尾 `return [...localTools, ...mcpTools]`
4. 加 `mcpServer.js`：把本地 `search_documents` / `read_document` 反向暴露为 MCP Server，供其他 Agent 系统调用（这是你的差异化亮点）

---

## 四、Plan-and-Execute

### 4.1 现状与目标

现有 Agent 是单步 ReAct：每步都调模型决策。目标是升级为 **Plan-and-Execute**：先用 Planner Agent 生成多步计划，再用 Executor Agent 逐步执行，最后 Re-ranker 决定是否需要重新规划。

### 4.2 技术栈

| 项       | 选型                   | 说明                                           |
| -------- | ---------------------- | ---------------------------------------------- |
| 框架     | `@langchain/langgraph` | 官方有 Plan-and-Execute 模板                   |
| Planner  | 独立 ChatModel 实例    | 用 `withStructuredOutput` 输出 `string[]` 步骤 |
| Executor | 复用现有 ReAct Agent   | 单步执行交给现有 createAgent                   |

### 4.3 实现点

- 新增 `server/src/agent/planExecute.js`：Planner / Executor / Replan 三个节点
- 路由 `server/src/routes/agent.js`：加 `mode=plan-execute` 参数切换运行模式

### 4.4 重点

1. **Planner Prompt**：让模型输出结构化步骤数组，每步是 `{ step, goal, tool_hint }`，避免自由文本难解析
2. **状态持久化**：Plan 是多步的，checkpointer 必须开，否则中途失败全丢
3. **Replan 触发**：每步执行后用 Re-ranker 判断"是否需要重新规划"，避免死磕错误计划

### 4.5 难点

- **延迟放大**：Planner 一次模型调用 + Executor N 次模型调用 + Re-ranker N 次，总耗时可能 3-5 倍于单步 ReAct，要做流式增量输出
- **步骤间状态传递**：上一步结果如何塞回下一步的 prompt，避免上下文溢出（与现有 `historyChars: 24000` 限制冲突）
- **与现有引用制兼容**：多步执行的来源要汇总到最终回答，SourceRegistry 要支持跨步骤合并

### 4.6 实现步骤

1. 定义 `PlanExecuteState = Annotation.Root({ input, plan, pastSteps, response })`
2. `planner` 节点：`model.withStructuredOutput(z.object({ steps: z.array(z.string()) })).invoke("...")`
3. `executor` 节点：调现有 `runAgent` 执行单步，结果记入 `pastSteps`
4. `replan` 节点：判断是否完成或需重规划，条件边回 `planner` 或进 `END`
5. 编译为 graph，`runAgent` 加 `mode` 参数分流到 planExecute 或原 ReAct

---

## 五、Supervisor Multi-Agent

### 5.1 现状与目标

现有是单 Agent + 2 个工具。目标是升级为 **Supervisor + 子 Agent**：Supervisor 决策"这一步交给哪个子 Agent"，子 Agent 独立完成任务后汇报。

### 5.2 技术栈

| 项       | 选型                                 | 说明                                              |
| -------- | ------------------------------------ | ------------------------------------------------- |
| 框架     | `@langchain/langgraph`               | `createSupervisor` helper                         |
| 子 Agent | 检索 Agent / 总结 Agent / 写入 Agent | 各自独立 prompt 与工具                            |
| 通信     | 共享 State                           | 子 Agent 输出写入 state，Supervisor 读 state 决策 |

### 5.3 实现点

- 新增 `server/src/agent/multiAgent.js`：Supervisor + 3 个子 Agent
- 复用 [tools.js](server/src/agent/tools.js) 的工具，按子 Agent 分组

### 5.4 重点

1. **子 Agent 划分**：检索 Agent（search/read）、总结 Agent（无工具，纯模型）、CV Agent（图片理解，对应 JD 多模态要求）
2. **Supervisor Prompt**：让模型输出 `{ next: "retriever" | "summarizer" | "cv" | "FINISH" }`，用结构化输出避免解析
3. **共享上下文**：子 Agent 间通过 state 传递中间结果，不要互相直接调

### 5.5 难点

- **Token 成本**：每个子 Agent 都是一次完整模型调用，Supervisor 又是额外调用，总成本 2-4 倍。需要明确"什么任务才走多 Agent"，简单问答仍走单 Agent
- **死循环防护**：Supervisor 可能在子 Agent 间来回切换，`recursionLimit` 要设小（如 10）
- **来源归属**：哪个子 Agent 产生的来源要标记，方便审计

### 5.6 实现步骤

1. 定义 `MultiAgentState = Annotation.Root({ messages, sources, next, intermediate })`
2. 建 `retrieverAgent` / `summarizerAgent` / `cvAgent` 三个节点，每个是一个完整的 ReAct Agent
3. `supervisor` 节点：读 state，`withStructuredOutput` 输出 next
4. 条件边：`supervisor → next 指向的子 Agent → supervisor`，直到 `next=FINISH`
5. 路由加 `mode=multi-agent` 参数切换

---

## 六、文档解析（PDF/Word/HTML）

### 6.1 现状与目标

现有 Agent 只能检索站内富文本文档（[documents 路由](server/src/routes/documents.js) 的 content 字段），无法处理用户上传的 PDF/Word/HTML 文件。目标是补全**文件解析 → 切分 → 入库**链路。

### 6.2 技术栈

| 格式         | 库          | 说明                             |
| ------------ | ----------- | -------------------------------- |
| PDF          | `pdf-parse` | 纯 JS，无 native 依赖            |
| Word         | `mammoth`   | 提取 .docx 为 HTML/纯文本        |
| HTML         | `cheerio`   | jQuery 风格解析，去 script/style |
| Markdown     | 原生        | 直接走 splitter                  |
| 图片（可选） | Qwen-VL API | 扫描件 PDF 走 OCR/VL             |

### 6.3 实现点

- 新增 `server/src/services/documentParser.js`：统一入口 `parseFile(buffer, mimeType)`
- 改造 `server/src/routes/documents.js`：上传时调 parser 提取文本
- 复用 [chunkDocument](server/src/services/embeddingService.js)（已升级为 RecursiveCharacterTextSplitter）切分入库

### 6.4 重点

1. **统一文本输出**：所有格式最终输出纯文本 + 结构标记（标题/段落），便于切分器按 `\n\n` 分段
2. **大文件流式**：PDF 可能 100MB+，不能用 `buffer.toString()` 一次性吃，要分页读
3. **图片处理**：扫描件 PDF 提取出来是空白，需要调 VL 模型 OCR，结果作为文本入库

### 6.5 难点

- **版面还原**：PDF 表格、多栏排版用 `pdf-parse` 会丢结构，需要 `pdfjs-dist` 或付费 OCR 服务
- **编码问题**：Word 旧 .doc 二进制格式 `mammoth` 不支持，需要 `libreoffice-convert` 或限制只收 .docx
- **安全**：上传文件要做 MIME 嗅探（不能只看扩展名）+ 大小限制 + 病毒扫描（与现有 multer 配置对齐）

### 6.6 实现步骤

1. `npm i pdf-parse mammoth cheerio`
2. `documentParser.js`：按 mimeType 分流，PDF 走 pdf-parse，Word 走 mammoth，HTML 走 cheerio（去 script/style 后 `.text()`），Markdown 直传
3. `routes/documents.js` 上传处理：`multer` 接收 → `parseFile` → 写入 doc.content → 调 `upsertDocument` 触发 RAG 索引
4. 测试：上传 3 种格式各一篇，验证 [agent-evaluate.js](server/scripts/agent-evaluate.js) 的来源命中率不下降

---

## 七、语义缓存（Semantic Cache）—— 减少 Token 消耗

### 7.1 现状与目标

现有 [runAgent](server/src/agent/index.js) 每次问答都调用大模型，即使问题与之前问过的完全相同。目标是引入 **语义缓存**：对"语义相近的问题"直接返回历史答案，跳过模型调用，大幅降低 Token 消耗与响应延迟。

### 7.2 技术栈

| 项        | 选型                                                             | 说明                                 |
| --------- | ---------------------------------------------------------------- | ------------------------------------ |
| Embedding | 复用 `text-embedding-v3`                                         | 不新增模型，问题向量与文档向量同空间 |
| 缓存存储  | `.runtime/cache.json`                                            | 与 `vectors.json` 同策略，纯文件     |
| 相似度    | 复用 [cosineSimilarity](server/src/services/embeddingService.js) | 不写新算法                           |
| 失效校验  | 复用 [sourceIsValid](server/src/services/knowledgeService.js)    | 文档改版自动失效                     |

**零新增 npm 依赖**。

### 7.3 实现点

1. 新增 `server/src/services/cacheService.js`：核心数据结构 `{ id, query, queryEmbedding, answer, sources, createdAt, sourceSnapshot }`，三个方法：
   - `getCache({ query, threshold = 0.92 })` → embed(query) → 全库余弦打分 → top1 ≥ threshold 且 sources 全部通过 `sourceIsValid` 则返回
   - `setCache(entry)` → 写入
   - `invalidateByDocument(docId)` → 文档删除/改版时清掉相关缓存
2. 改造 `server/src/agent/index.js` 的 `runAgent`：调模型前先查缓存，命中则模拟流式返回（分块 emit token），未命中则正常走 Agent 并在成功后写缓存
3. 改造 `server/src/services/embeddingService.js` 的 `upsertDocument` / `deleteDocument`：文档变更时同步调 `invalidateByDocument`
4. 配置项加在 `server/src/config/index.js` 的 `rag` 块：`cacheEnabled` / `cacheThreshold`（默认 0.92）/ `cacheTtlMs`

### 7.4 重点

1. **相似度阈值要高（默认 0.92）**：低于 0.92 的"相似问题"语义可能南辕北辙（"怎么请假" vs "怎么销假"差一个字但意思相反）
2. **来源必须校验**：命中缓存后用 `sourceIsValid` 复查每个 source，任一失效则 miss。这条复用现有链路，几乎免费拿到
3. **缓存全局共享，不按 userId 隔离**：当前项目是公共知识库 + 只读已发布文档，同一问题对不同用户答案一致。全局共享命中率最高（A 问过 B 再问直接命中），存储最省。隔离只在引入 RBAC/个性化/私有文档时才需要——届时加一个 `userId` 字段做前缀过滤即可
4. **流式输出兼容**：缓存命中时 [runAgent](server/src/agent/index.js) 当前是流式 SSE，命中缓存要模拟流式（分块 emit token），前端体验一致

### 7.5 难点

| 难点               | 影响                                                                       | 应对                                                                                                   |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **上下文依赖问题** | "继续说说第二点"这种追问，单独看 query 与缓存向量相似度低，但实际依赖上文  | 缓存 query 用"上文摘要 + 本轮问题"拼接后再 embed，避免裸追问误判                                       |
| **缓存污染**       | 错误答案被缓存后会反复返回                                                 | 只缓存"来源全部通过校验 + 无 EMPTY_RESPONSE"的成功回答，失败回答不入库                                 |
| **冷启动**         | 新用户首次问命中率 0                                                       | 监控 hit_rate，低于 5% 说明阈值太高或问题分散，需要调参                                                |
| **Token 监控口径** | 现有 [stats](server/src/agent/index.js) 统计的是模型 token，缓存命中时为 0 | 在 stats 加 `cacheHit: boolean` 字段，[agent-evaluate.js](server/scripts/agent-evaluate.js) 评估时区分 |

### 7.6 预期收益

- **Token 成本**：高频知识库场景（员工反复问请假/报销/入职），命中率可达 30-50%，token 直接降 1/3
- **响应延迟**：缓存命中从 2-5s 降到 50ms 以内（一次 embedding + 一次本地余弦遍历）
- **简历亮点**：面试能讲"语义缓存 + 来源失效联动 + 阈值调优"，这是 RAG 落地的高阶信号

### 7.7 为什么不按 userId 隔离（设计决策记录）

**结论**：当前项目"公共知识库 + 只读已发布文档"的场景下，语义缓存**全局共享**才是最优解。

**推理过程**：

- Agent 只读已发布文档（[tools.js](server/src/agent/tools.js) 注释明确"仅检索与读取已发布文档"）
- 无私有文档/按人可见的文档（[isPublished](server/src/services/knowledgeService.js) 只看 `status === 'published'`，无 userId 过滤）
- 无个性化回答（[SYSTEM_PROMPT](server/src/agent/prompts.js) 是通用知识助手）
- 因此：同一个问题，A 问和 B 问，检索到的文档集完全相同，模型给的答案也应当一致

按 userId 隔离反而会降低命中率、增加存储。隔离只有在引入以下能力时才需要：

- 文档按部门/角色 RBAC 可见
- 个性化偏好（A 喜欢表格、B 喜欢列表）
- 个人笔记/草稿纳入检索

届时加一个 `userId` 字段做前缀过滤即可，改动成本极低。

### 7.8 实现步骤

1. 新建 `cacheService.js`（仿 `embeddingService.js` 结构，复用 embedding 实例）
2. `runAgent` 入口加 `getCache` 查询 + 命中后流式模拟返回
3. `runAgent` 末尾成功路径加 `setCache`
4. `upsertDocument` / `deleteDocument` 加 `invalidateByDocument` 调用
5. `config.rag` 加 `cacheEnabled` / `cacheThreshold` / `cacheTtlMs`
6. [agent-evaluate.js](server/scripts/agent-evaluate.js) 加 `cacheHitRate` 维度

---

## 八、长期记忆（Long-term Memory）—— 跨会话用户偏好

### 8.1 现状与目标

现有 [sessionStore](server/src/agent/sessionStore.js) 只存短期会话内存（`Map` 实现，会话过期即丢）。目标是引入 **长期记忆**：记住用户偏好/历史摘要，跨会话生效，让 Agent 回答更贴合个人习惯。

### 8.2 技术栈

与语义缓存共用底座（零新增依赖）：

| 项        | 选型                                                             | 说明                             |
| --------- | ---------------------------------------------------------------- | -------------------------------- |
| Embedding | 复用 `text-embedding-v3`                                         | 与缓存/文档向量同空间            |
| 记忆存储  | `.runtime/memory.json`                                           | 纯文件，与 `vectors.json` 同策略 |
| 相似度    | 复用 [cosineSimilarity](server/src/services/embeddingService.js) | 不写新算法                       |

### 8.3 实现点

1. 新增 `server/src/services/memoryService.js`：核心数据结构 `{ id, userId, type: 'preference' | 'summary', content, embedding, createdAt, sessionId }`，两个方法：
   - `recall({ userId, query, limit = 3 })` → embed(query) → 按 userId 过滤 → 余弦打分 → topK
   - `remember({ userId, type, content, sessionId })` → embed(content) → 写入
2. 改造 `server/src/agent/index.js` 的 `buildAgent`：组装 prompt 时先 `memoryService.recall` → 把命中记忆塞进 system prompt 的"用户偏好"区
3. 会话结束时（或每 N 轮）调 `memoryService.remember` 写入摘要

### 8.4 重点

1. **记忆类型区分**：`preference`（"用户偏好用表格对比"）和 `summary`（"上次问了报销流程"）分开存，召回时偏好进 prompt 头部、摘要进上下文尾部
2. **写入时机**：preference 由模型主动提取（"用户似乎偏好…"），summary 在会话结束时自动生成
3. **与语义缓存的区别**：记忆进 prompt 影响模型输出，缓存直接替代答案；记忆是辅助，不是捷径

### 8.5 难点

| 难点                                             | 应对                                                         |
| ------------------------------------------------ | ------------------------------------------------------------ |
| **记忆污染**：错误偏好被反复召回会误导模型       | 只在模型明确输出 `<preference>` 标签时写入，人工审核或低权重 |
| **记忆过期**：用户偏好会变                       | 加 TTL 或"最近 N 条"策略，老记忆自然衰减                     |
| **隐私边界**：记忆跨会话，用户可能不希望被"记住" | 加 `memoryEnabled` 开关，前端可一键清除                      |

### 8.6 实现步骤

1. 新建 `memoryService.js`（与 `cacheService.js` 共用 embedding 实例，差异只在数据结构和召回用途）
2. `buildAgent` 的 prompt 组装区加 `recall` 调用，命中记忆以 `<user_memory>` 标签注入
3. `runAgent` 末尾加偏好提取逻辑（正则或模型结构化输出）
4. 会话结束路由（`DELETE /sessions/:id`）触发摘要写入
5. `config.rag` 加 `memoryEnabled` / `memoryRecallLimit`

---

## 落地优先级建议

| 优先级 | 功能                               | 理由                                                             |
| ------ | ---------------------------------- | ---------------------------------------------------------------- |
| P0     | Rerank                             | 改动最小（一个新服务 + 一个函数改造），RAG 质量立竿见影          |
| P0     | 语义缓存                           | 零新增依赖，降本最直接，改动局部（runAgent 入口 + 文档变更联动） |
| P0     | 文档解析                           | 补全 RAG 数据入口，无此则知识库只有站内文档                      |
| P1     | LangGraph 重构 + human-in-the-loop | 是 P4/P5 的底座，必须先做                                        |
| P1     | MCP 接入                           | 你的差异化亮点，TS 选手的反超点                                  |
| P1     | 长期记忆                           | 与语义缓存共用底座，一并实现成本最低                             |
| P2     | Plan-and-Execute                   | 依赖 LangGraph，长任务场景才用                                   |
| P2     | Supervisor Multi-Agent             | 依赖 LangGraph，复杂场景才用                                     |

## 受限环境说明

本方案所有依赖均为纯 JS npm 包，无需 Python / Docker / 本地数据库。受 HUES 终端安全软件限制：

- 向量库保持文件版 `vectors.json`（或换嵌入式 LanceDB）
- 检查点用 `MemorySaver`（单进程）或 SQLite adapter
- 队列用 SQLite 替代 Redis（如 `bullmq-sqlite-adapter`）
