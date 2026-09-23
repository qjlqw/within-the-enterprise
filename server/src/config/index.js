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

export const config = {
  port: Number(process.env.PORT) || 8080,
  jwtSecret: process.env.JWT_SECRET || "enterprise-kb-secret-key-change-me", // 生产环境务必替换
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  uploadDir: path.resolve(
    __dirname,
    "..",
    "..",
    process.env.UPLOAD_DIR || "uploads",
  ),
  // 允许的 CORS 来源
  corsOrigin: process.env.CORS_ORIGIN || "*",
  agent: {
    // 知识助手总开关：必须在 server/.env 中显式 AGENT_ENABLED=true 才启用
    enabled: process.env.AGENT_ENABLED === "true",
    model: process.env.LLM_MODEL || "", // 模型名（如 qwen-plus）
    apiKey: process.env.LLM_API_KEY || "", // 模型 API Key
    baseURL: process.env.LLM_BASE_URL || "", // 模型服务地址，必须 HTTPS
    timeoutMs: positiveInt("AGENT_RUN_TIMEOUT_MS", 60000, 300000), // 单轮问答超时
    maxToolCalls: positiveInt("AGENT_MAX_TOOL_CALLS", 300, 400), // 单轮工具调用上限
    maxModelCalls: positiveInt("AGENT_MAX_MODEL_CALLS", 8, 20), // 单轮模型调用上限
    maxOutputTokens: positiveInt("AGENT_MAX_OUTPUT_TOKENS", 2000, 8000), // 模型单次输出 token 上限
    maxToolChars: 24000, // 单轮工具读取字符总量上限（防滥用）
    maxOutputChars: 16000, // 回答字符上限
    historyChars: 24000, // 历史会话回放字符上限
    maxSessions: positiveInt("AGENT_MAX_SESSIONS", 1000, 10000), // 全局会话上限
    sessionTtlMs: 86400000, // 会话空闲过期时间（24h）
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
    rerankTopN: positiveInt("RERANK_TOP_N", 5, 50), // 精排后保留条数
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
  // 向量存储驱动配置：local | upstash
  vector: {
    store: process.env.VECTOR_STORE || process.env.VECTOR_STORE || "local",
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
