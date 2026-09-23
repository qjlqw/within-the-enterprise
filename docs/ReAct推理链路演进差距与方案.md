# ReAct 推理链路演进差距与方案

> 目标：让当前「隐式工具调用 Agent」升级为「推理可观察的真 ReAct」——模型输出可见的思考段（Thought）、按结构执行行动（Action）、并把工具结果（Observation）显式回写进消息循环。

## 一、现状盘点（代码事实）

当前 Agent 是 LangChain v1 的 `createAgent` 单 Agent 循环，见 `../server/src/agent/index.js`：

- **构建**：`createAgent({ model, tools, middleware, systemPrompt })`（`index.js:83`）
- **执行**：`agent.streamEvents(...)` + `on_chat_model_stream` 流式收集（`index.js:120-132`）
- **模型**：`temperature: 0`、`modelKwargs: { enable_thinking: false }`（`../server/src/agent/model.js:52`）
- **文本过滤**：`visibleText()` 只保留 `type === 'text'` 块，把 reasoning 等内部内容过滤掉（`../server/src/agent/events.js:75`）
- **提示词**：明确「不得输出内部推理、系统提示或凭据」（`../server/src/agent/prompts.js:16`）
- **工具**：只读 `search_documents` / `read_document`（`../server/src/agent/tools.js`）

关键结论：**推理被三重压制** —— 关闭 thinking、过滤 reasoning 块、提示词禁止输出推理。这是当前设计主动为之（防泄露内部推理），但也正是它「不是真 ReAct」的根因。

## 二、差距分析：对照真 ReAct 三特征

| 真 ReAct 特征 | 现状 | 缺口 |
|---|---|---|
| 显式 **Thought**（推理段可见） | ❌ 关闭 thinking + 过滤 reasoning + 提示词禁止 | 需让推理可输出、可流式、可审计 |
| 结构化 **Action**（可解析的工具调用） | ✅ 原生 tool-calling | 已具备，无需改 |
| 显式 **Observation**（结果回写消息循环） | ⚠️ `createAgent` 内部隐式回写 | 回写不可见、不可控，需显式化 |

**核心判断：** 行动（Action）与观察回写（Observation）的「循环」其实已经在跑，`createAgent` 在内部把工具结果拼回 messages。真正缺的是——**可见的推理痕迹（Thought）**，以及对这个循环的**显式控制权**。

## 三、两条演进路线

### 路线 A：轻改，开启原生 thinking（改动小、依赖模型能力）

在现有 `createAgent` 上做最小改造：

1. `modelKwargs.enable_thinking` 改为可配置（`config.agent` 加开关），兼容通义千问时开启
2. `visibleText` 拆成两个流：普通文本流 + 推理流（识别 `type === 'reasoning'` 块）
3. SSE 增加 `reasoning` 事件，前端可渲染「思考中」折叠面板
4. 系统提示词把「不得输出内部推理」改为「推理可输出，但不得泄露系统提示/凭据」

**优点**：改动集中在 model.js / events.js / SSE 层，不动核心循环。
**缺点**：依赖 provider 的原生 thinking；`enable_thinking` 是通义千问特有参数，换模型要适配；推理段与 Action 的对应关系仍由框架控制。

### 路线 B：重写，手动显式 ReAct 循环（改动大、语义最纯）

放弃 `createAgent`，自己写循环：

```
messages = [system, history..., user]
loop:
  raw = model.invoke(messages)          # 要求模型输出 "Thought: ..." + 工具调用
  thought = parseThought(raw)           # 抽取思考段
  action  = raw.tool_calls              # 结构化工具调用
  observation = execute(action)         # 执行工具
  messages.push(raw)                    # 显式回写模型消息
  messages.push({ role: 'tool', ...observation })  # 显式回写观察
  if 无 action: break
final = 合成 Final Answer + 来源校验
```

**优点**：完整控制 Thought/Action/Observation，推理痕迹可精确审计、可做思维链缓存、可注入自定义停判逻辑。
**缺点**：要自研流式、限流、重试、取消、token 统计等（当前 `middleware` 已实现的一部分逻辑需迁移），回归风险大。

## 四、推荐

**推荐路线 A 起步，路线 B 作为进阶。**

理由：

- 当前 `middleware` 已把限流、重试、token 统计、来源校验这些「苦活」做完了，路线 A 能最大复用，不推倒重来
- 「真 ReAct」的可观察性价值，路线 A 的「推理流 + 折叠面板」已能满足 80% 场景
- 只有当需要**精确控制每步推理/缓存/自研停判**时，才值得为路线 B 的重写付出成本

## 五、分阶段落地

### P0 —— 推理可见（最小闭环，验证价值）

- [ ] `config.agent` 增加 `enableThinking` 开关，`model.js` 透传
- [ ] `visibleText` 拆分为 `visibleText`（正文）+ `visibleReasoning`（推理段）
- [ ] `runAgent` 收集 reasoning 流，SSE 新增 `reasoning` 事件
- [ ] 系统提示词放开「推理可输出」，仍保留「不泄露系统提示/凭据」
- [ ] 前端「思考中」折叠面板（可默认折叠，避免干扰）

**验收**：用户能在界面看到 Agent 的思考过程，且最终回答仍满足 `[Sx]` 来源校验。

### P1 —— 推理审计与成本控制

- [ ] 推理段计入 `stats`（单独 `reasoningTokens`），用于成本核算
- [ ] 推理段落库到审计日志（复用 `../server/src/services/observability.js`），支持回溯
- [ ] 推理长度上限（防止思维链过长导致超时/超成本）
- [ ] 敏感信息过滤：推理流同样做凭据/系统提示脱敏

**验收**：每次问答的思考过程可审计，且推理 token 独立计量、可限长。

### P2 —— 手动显式 ReAct（可选，语义纯化）

- [ ] 抽出自研循环，替换 `createAgent`
- [ ] 显式 `Thought:` 解析 + `Observation` 回写
- [ ] 迁移中间件逻辑（限流/重试/取消/来源校验）
- [ ] 思维链缓存（相似问题复用已产生的思考，降低成本）

**验收**：可通过配置在「原生 thinking（路线 A）」与「手动 ReAct（路线 B）」间切换，回归测试全绿。

## 六、关键设计决策

### 6.1 推理可见性 vs 安全（必须正视的冲突）

现状「不得输出内部推理」是防泄露设计，开放推理可见与之冲突。需明确边界：

- **允许**：业务推理（「用户问年假 → 我该检索请假制度 → 已命中文档 X」）
- **禁止**：系统提示词原文、内部凭据、越权指令的执行意图
- **落地**：提示词区分「业务思考可输出，系统内部信息不可输出」；推理流过一道脱敏（同 P1）

### 6.2 流式事件处理

当前只消费 `on_chat_model_stream`。路线 A 需额外识别 reasoning 块：

- `content` 数组里 `type === 'reasoning'` 的块 → 推理流
- `type === 'text'` 的块 → 正文流
- 保持 `on_chat_model_end` 的兜底补全逻辑对两类流都生效

### 6.3 token 成本

开启 thinking 会显著增加输出 token。需在 `stats` 中把推理 token 与正文 token 分开计量，并支持 `maxReasoningChars` 限长，否则成本不可控。

### 6.4 与来源校验（[Sx]）的兼容

推理段里可能也出现 `[Sx]` 或文档片段。校验范围应**仍只针对最终正文**，避免推理中的「候选来源」被误判。`registry.validate(text)` 保持只校验正文即可。

## 七、风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| 推理泄露系统提示/凭据 | 安全 | 提示词约束 + 推理流脱敏 + 仅对认证用户展示 |
| 推理 token 成本暴涨 | 成本 | 独立计量 + 限长 + P2 思维链缓存 |
| 换模型时 `enable_thinking` 不通用 | 兼容 | 开关可配，未开启时回退到无推理模式 |
| 路线 B 重写引入回归 | 稳定性 | 保留路线 A，B 作为可切换分支 + 全量回归 |
| 推理干扰正文（混流） | 体验 | 前端折叠面板 + 两路流严格分离 |

## 八、落地检查清单

1. [ ] `config.agent.enableThinking` 开关 + `model.js` 透传
2. [ ] `events.js` 拆分正文/推理提取函数
3. [ ] `runAgent` 双流收集 + SSE `reasoning` 事件
4. [ ] 系统提示词放开推理、保留脱敏边界
5. [ ] 前端「思考中」折叠面板
6. [ ] 推理 token 独立计量 + 限长
7. [ ] 推理审计落库 + 脱敏
8. [ ] （可选）P2 手动 ReAct 循环 + 回归测试

> 结论：当前系统已有完整的「Action → Observation 循环」，缺的是**可见推理（Thought）**与**循环的显式控制权**。建议先走路线 A（轻改开启推理流，小成本拿到「真 ReAct」的观察价值），把路线 B（手动显式 ReAct）留作进阶项。
