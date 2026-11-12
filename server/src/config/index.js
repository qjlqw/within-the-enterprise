/**
 * 服务端配置中心：
 * - 通过 dotenv 读取 server/.env 环境变量
 * - 暴露统一的 config 对象，供各模块引用
 *
 * 注意：模型密钥等敏感信息只放在 server/.env，
 * 不要放到前端可访问的 VITE_* 变量中。
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM 下获取当前文件目录，用于定位 ../../.env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

/**
 * 解析正整数环境变量：非法值或超出范围则使用 fallback
 * @param {string} name 环境变量名
 * @param {number} fallback 默认值
 * @param {number} max 上限（含）
 */
const positiveInt = (name, fallback, max = 1000000) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 && value <= max
    ? value
    : fallback;
};

/**
 * 解析非负浮点环境变量（0 表示关闭对应阈值过滤）：非法值或超出范围则使用 fallback
 * @param {string} name 环境变量名
 * @param {number} fallback 默认值
 * @param {number} max 上限（含）
 */
const nonNegativeFloat = (name, fallback, max = 1) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : fallback;
};

// 生产环境 fail-fast：JWT 密钥与 CORS 来源不达标直接拒绝启动，避免带弱配置上线
const isProduction = process.env.NODE_ENV === "production";
// node --test 会设置 NODE_TEST_CONTEXT；测试环境允许使用固定密钥便于断言
const isTest =
  process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);

const rawJwtSecret = process.env.JWT_SECRET || "";
// 除测试环境外一律要求显式强密钥，避免开发/预发使用可预测的默认值
if (!isTest && rawJwtSecret.length < 32) {
  throw new Error(
    "必须设置强随机 JWT_SECRET（至少 32 字符），请勿使用默认弱密钥；测试环境请设置 NODE_ENV=test",
  );
}
const jwtSecret =
  rawJwtSecret || "test-only-enterprise-kb-secret-key-000000000000";

const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (isProduction && (!corsOrigins.length || corsOrigins.includes("*"))) {
  throw new Error(
    "生产环境必须设置 CORS_ORIGIN 为允许的前端来源（逗号分隔），禁止使用 *",
  );
}
const corsOrigin = corsOrigins.length ? corsOrigins : "*";

// 单轮问答超时：运行锁租约在此基础上留出缓冲，避免锁先于任务过期
const agentTimeoutMs = positiveInt("AGENT_RUN_TIMEOUT_MS", 60000, 300000);

export const config = {
  port: Number(process.env.PORT) || 8080,
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "1d",
  uploadDir: path.resolve(
    __dirname,
    "..",
    "..",
    process.env.UPLOAD_DIR || "uploads",
  ),
  // 允许的 CORS 来源（数组，来自 CORS_ORIGIN 逗号分隔；非生产回退 "*"）
  corsOrigin,
  // Redis（可选）：配置后限流与 Agent 运行锁在多个实例间共享
  redis: {
    // 仅认 REDIS_URL：队列用的 Upstash REST 地址不参与，避免意外连接外部实例
    url: process.env.REDIS_URL || "",
    keyPrefix: process.env.REDIS_KEY_PREFIX || "ekb", // 键前缀，避免多环境互相干扰
    connectTimeoutMs: positiveInt("REDIS_CONNECT_TIMEOUT_MS", 3000, 30000),
  },
  agent: {
    // 知识助手总开关：必须在 server/.env 中显式 AGENT_ENABLED=true 才启用
    enabled: process.env.AGENT_ENABLED === "true",
    model: process.env.LLM_MODEL || "", // 模型名（如 qwen-plus）
    apiKey: process.env.LLM_API_KEY || "", // 模型 API Key
    baseURL: process.env.LLM_BASE_URL || "", // 模型服务地址，必须 HTTPS
    timeoutMs: agentTimeoutMs, // 单轮问答超时
    // 分布式运行锁租约：超时后再留 30s 缓冲，进程崩溃时靠租约自动释放
    runLockTtlMs: positiveInt(
      "AGENT_RUN_LOCK_TTL_MS",
      agentTimeoutMs + 30000,
      600000,
    ),
    maxToolCalls: positiveInt("AGENT_MAX_TOOL_CALLS", 300, 400), // 单轮工具调用上限
    maxModelCalls: positiveInt("AGENT_MAX_MODEL_CALLS", 8, 20), // 单轮模型调用上限
    maxOutputTokens: positiveInt("AGENT_MAX_OUTPUT_TOKENS", 2000, 8000), // 模型单次输出 token 上限
    maxToolChars: 60000, // 单轮工具读取字符总量软预算：超限时截断后续片段而非整轮失败（防滥用）
    maxOutputChars: 16000, // 回答字符上限
    historyChars: 24000, // 历史会话回放字符上限
    maxSessions: positiveInt("AGENT_MAX_SESSIONS", 1000, 10000), // 全局会话上限
    sessionTtlMs: 86400000, // 会话空闲过期时间（24h）
    // ReAct 推理流可见：开启后在 Qwen 模型上产出 reasoning 流（DeepSeek 不生效）
    enableThinking: process.env.AGENT_ENABLE_THINKING === "true",
    // 推理段字符上限（超出截断，不影响正文）
    maxReasoningChars: positiveInt("AGENT_MAX_REASONING_CHARS", 4000, 50000),
    // ===== P0-2 强制引用 + 工具联合判定（出口防绕过）=====
    // ENFORCE_CITATION：enforce=拦截并降级为「资料不足」话术 / warn=放行但落审计
    // （先 warn 收集误杀率，误杀率 ≤5% 再切 enforce，见排期 P0-2）/ off=关闭
    enforceCitation: ["enforce", "warn", "off"].includes(process.env.ENFORCE_CITATION)
      ? process.env.ENFORCE_CITATION
      : "warn",
    // ENFORCE_TOOL_CHECK：on=要求本轮至少一次有效工具结果（status=found 且非空）/
    // off=不要求；仅在 ENFORCE_CITATION=enforce 时参与拦截，warn 下仅审计
    enforceToolCheck: process.env.ENFORCE_TOOL_CHECK === "on" ? "on" : "off",
  },
  // LLM Wiki：结构化知识库（实体/关系），默认关闭
  wiki: {
    enabled: process.env.WIKI_ENABLED === "true", // LLM Wiki 总开关
    extractEnabled: process.env.WIKI_EXTRACT_ENABLED === "true", // 文档发布后自动抽取
    // 知识抽取 LLM 调用超时：后台任务与前端问答解耦，可放得比 AGENT_RUN_TIMEOUT_MS 更长
    extractionTimeoutMs: positiveInt("EXTRACTION_TIMEOUT_MS", 180000, 600000),
  },
  // Agent 长期记忆，默认关闭
  memory: {
    enabled: process.env.MEMORY_ENABLED === "true", // 长期记忆总开关
    qaTopK: positiveInt("QA_MEMORY_TOP_K", 3, 20), // 历史 QA 召回条数
    qaMinSim: Number(process.env.QA_MEMORY_MIN_SIM) || 0.9, // QA 去重相似度阈值
  },
  // RAG 向量检索配置：未启用或向量库不可用时，agent 自动回退到关键词加权检索
  rag: {
    // 总开关：必须显式 RAG_ENABLED=true 才启用
    enabled: process.env.RAG_ENABLED === "true",
    // Embedding 模型与密钥：需要单独配置 DashScope 的 EMBEDDING_API_KEY
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-v3",
    embeddingApiKey: process.env.EMBEDDING_API_KEY || "",
    embeddingBaseURL:
      process.env.EMBEDDING_BASE_URL ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    chunkSize: positiveInt("RAG_CHUNK_SIZE", 500, 2000), // 切片字符数
    chunkOverlap: positiveInt("RAG_CHUNK_OVERLAP", 50, 500), // 切片重叠
    // 最终返回给 agent 的条数（工具默认 limit，工具层硬上限仍为 10）
    topK: positiveInt("RAG_TOP_K", 5, 10),
    // 召回候选池大小：融合/精排前的候选数量，与最终返回条数独立配置
    recallTopK: positiveInt("RAG_RECALL_TOP_K", 20, 100),
    // 向量召回相似度下限（0~1 余弦）：低于该值的候选不进入融合/精排，0 表示关闭
    // 目的：避免「强制凑满 topK」把跨域无关文档塞进 agent 上下文造成检索噪声
    scoreFloor: nonNegativeFloat("RAG_SCORE_FLOOR", 0.3),
    keywordWeight: 0.4, // 混合融合权重（关键词）
    vectorWeight: 0.6, // 混合融合权重（向量）
    // Rerank 精排（默认关闭；失败/超时自动回退到融合排序）
    rerankEnabled: process.env.RERANK_ENABLED === "true",
    rerankModel: process.env.RERANK_MODEL || "gte-rerank-v2",
    // 优先独立配置，未配置时依次回退 EMBEDDING_API_KEY / LLM_API_KEY
    rerankApiKey:
      process.env.RERANK_API_KEY ||
      process.env.EMBEDDING_API_KEY ||
      process.env.LLM_API_KEY ||
      "",
    rerankBaseURL:
      process.env.RERANK_BASE_URL || "https://dashscope.aliyuncs.com",
    // 接口风格：dashscope（gte-rerank 系列）/ compatible（qwen3-rerank）；留空按模型名自动判断
    rerankApiStyle: process.env.RERANK_API_STYLE || "",
    rerankTopN: positiveInt("RERANK_TOP_N", 10, 50), // 精排送入/保留条数（需大于 limit 才有淘汰空间）
    // 精排相关性下限（0~1）：rerank 的 relevance_score 低于该值的结果被淘汰，0 表示关闭
    rerankScoreFloor: nonNegativeFloat("RERANK_SCORE_FLOOR", 0.5),
    rerankTimeoutMs: positiveInt("RERANK_TIMEOUT_MS", 8000, 30000),
  },
  // 文档文件上传配置（P1：先支持 Markdown / TXT / DOCX，PDF 后置）
  document: {
    // 单文件大小上限，默认 10MB（DOCX 解析在内存中完成，不宜过大）
    uploadMaxBytes: positiveInt("DOC_UPLOAD_MAX_MB", 10, 100) * 1024 * 1024,
    // 扩展名白名单（同时做 MIME / 文件头嗅探，不能只看扩展名）
    allowedExtensions: [".md", ".markdown", ".txt", ".docx"],
  },
  // 异步索引任务队列：失败指数退避重试，超过上限标记 failed
  indexQueue: {
    maxAttempts: positiveInt("INDEX_MAX_ATTEMPTS", 3, 10),
    retryBaseDelayMs: positiveInt("INDEX_RETRY_BASE_DELAY_MS", 2000, 60000),
  },
  // 对象存储删除 outbox：文档删除后异步清理原始文件，失败指数退避重试
  storageDeletion: {
    maxAttempts: positiveInt("STORAGE_DELETION_MAX_ATTEMPTS", 5, 20),
    retryBaseDelayMs: positiveInt(
      "STORAGE_DELETION_RETRY_BASE_DELAY_MS",
      5000,
      600000,
    ),
    retryMaxDelayMs: positiveInt(
      "STORAGE_DELETION_RETRY_MAX_DELAY_MS",
      3600000,
      86400000,
    ),
    // 后台轮询间隔 / 单批领取条数
    intervalMs: positiveInt("STORAGE_DELETION_INTERVAL_MS", 30000, 3600000),
    batchSize: positiveInt("STORAGE_DELETION_BATCH_SIZE", 20, 200),
    // processing 锁超时：超过该时长未完成视为进程崩溃，回收为 pending
    lockTimeoutMs: positiveInt(
      "STORAGE_DELETION_LOCK_TIMEOUT_MS",
      300000,
      3600000,
    ),
  },
  // 安全与注册策略（11-06 报告 C9）：注册默认开放，生产可关闭改走内部开通
  security: {
    registerEnabled: process.env.REGISTER_ENABLED !== "false",
    // 密码强度：至少 8 位且须同时包含字母与数字
    passwordMinLength: positiveInt("PASSWORD_MIN_LENGTH", 8, 128),
    passwordRequireAlnum: process.env.PASSWORD_REQUIRE_ALNUM !== "false",
  },
  // 成本治理（11-06 报告 B7）：用户级配额与用量计量，0/关闭为不限
  cost: {
    // 单用户每日问答次数上限（0 表示不限制）
    dailyAgentRunLimit: positiveInt("DAILY_AGENT_RUN_LIMIT", 0, 100000),
    // 单用户每日模型输入字符预算（0 表示不限制）
    dailyCharBudget: positiveInt("DAILY_CHAR_BUDGET", 0, 100000000),
    // 用量明细保留天数（超出由聚合接口忽略，表内数据可定期清理）
    usageRetentionDays: positiveInt("USAGE_RETENTION_DAYS", 90, 3650),
  },
  // 图谱多跳检索（结构化知识库方案 P1）：search_graph 工具
  graph: {
    enabled: process.env.GRAPH_SEARCH_ENABLED !== "false",
    // 单次 search_graph 允许的最大跳数（1~2）
    maxHops: positiveInt("GRAPH_MAX_HOPS", 2, 2),
    // 每轮问答允许调用 search_graph 的次数上限
    maxCallsPerRun: positiveInt("GRAPH_MAX_CALLS_PER_RUN", 2, 10),
    // 语义兜底：名称未命中时用实体 summary 向量召回
    semanticFallback: process.env.GRAPH_SEMANTIC_FALLBACK !== "false",
  },
  // 向量存储驱动配置：local | upstash（默认 local，避免默认配置就依赖外部凭证）
  vector: {
    store: process.env.VECTOR_STORE || "local",
    upstash: {
      // Upstash Vector REST URL 与 Token
      restUrl: process.env.UPSTASH_VECTOR_URL || "",
      restApiKey: process.env.UPSTASH_VECTOR_API_KEY || "",
      // Upstash Redis 连接串（rediss://，供 ioredis/BullMQ 使用）
      redisUrl: process.env.UPSTASH_REDIS_URL || "",
      // Upstash Redis REST URL（https://，供 @upstash/redis REST 客户端使用）
      redisRestUrl: process.env.UPSTASH_REDIS_REST_URL || "",
      redisToken: process.env.UPSTASH_REDIS_TOKEN || "",
    },
  },
};
