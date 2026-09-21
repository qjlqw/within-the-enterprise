/**
 * 模型实例与配置校验：
 * - assertModelConfigured：在调用前校验 agent 已启用且配置合法
 * - createModel：构造 LangChain ChatOpenAI 实例
 *
 * 安全约束：
 *   baseURL 必须使用 HTTPS，且不能带账号密码，
 *   防止密钥或中间人窃取。
 */
import { ChatOpenAI } from "@langchain/openai";
import { config } from "../config/index.js";
import { ApiError } from "../utils/response.js";

/**
 * 校验知识助手已正确配置，未启用或配置缺失/不合法时抛 503
 * 在每个 agent 路由入口调用，避免请求进入后才报错。
 */
export function assertModelConfigured(options = config.agent) {
  if (!options.enabled) throw new ApiError(503, "知识助手尚未启用");
  if (!options.apiKey || !options.model || !options.baseURL)
    throw new ApiError(503, "知识助手模型尚未配置");
  let url;
  try {
    url = new URL(options.baseURL);
  } catch {
    throw new ApiError(503, "模型地址配置无效");
  }
  // 强制 HTTPS 且禁止在 URL 中携带凭据
  if (url.protocol !== "https:" || url.username || url.password)
    throw new ApiError(503, "模型地址必须使用 HTTPS");
}

/**
 * 创建 ChatOpenAI 模型实例
 * - streaming + streamUsage：流式输出并附带 token 用量
 * - maxRetries: 0：禁用 SDK 内置重试（重试由 agent 中间件控制，避免重复计费）
 * - temperature: 0：尽量稳定输出，便于来源引用校验
 * - enable_thinking: false：兼容通义千问，关闭思考输出，避免泄露内部推理
 */
export function createModel(options = config.agent) {
  assertModelConfigured(options);
  return new ChatOpenAI({
    model: options.model,
    apiKey: options.apiKey,
    configuration: { baseURL: options.baseURL },
    streaming: true,
    streamUsage: true,
    maxTokens: options.maxOutputTokens,
    maxRetries: 0,
    timeout: options.timeoutMs,
    temperature: 0,
    modelKwargs: { enable_thinking: false },
  });
}
