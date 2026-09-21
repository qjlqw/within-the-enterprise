/**
 * Rerank 精排服务（DashScope 文本排序）
 *
 * 在向量召回 + 关键词融合得到候选池后，用 cross-encoder 对
 * query 与每个候选片段做交互式相关性打分，重排后取最终 topN。
 *
 * 支持两种接口风格（按模型名自动判断，也可用 RERANK_API_STYLE 强制）：
 * - dashscope：gte-rerank-v2 / qwen3.7-text-rerank 等
 *     POST {baseURL}/api/v1/services/rerank/text-rerank/text-rerank
 *     body: { model, input: { query, documents }, parameters: { top_n, return_documents: false } }
 * - compatible：qwen3-rerank（OpenAI 兼容 /reranks）
 *     POST {baseURL}/compatible-api/v1/reranks
 *     body: { model, query, documents, top_n }
 *
 * 两种响应均归一化为 output.results / results：
 *   [{ index, relevance_score }]，index 对应入参 documents 下标
 *
 * 降级原则：未启用 / 缺密钥 / 超时 / 非 2xx / 响应非法时抛出异常，
 *          由调用方（knowledgeService）回退到融合排序，绝不阻断问答主流程。
 */
import { config } from "../config/index.js";
import { recordError } from "./observability.js";

/** 判断模型对应的接口风格 */
function resolveApiStyle(rag) {
  const forced = rag.rerankApiStyle;
  if (forced === "dashscope" || forced === "compatible") return forced;
  // gte-rerank 系列仅支持 DashScope 原生接口；qwen3-rerank 走兼容接口
  return /^gte-rerank/i.test(rag.rerankModel) ? "dashscope" : "compatible";
}

/** Rerank 是否具备调用条件（开关 + 密钥） */
export function isRerankReady() {
  return Boolean(config.rag.rerankEnabled && config.rag.rerankApiKey);
}

/**
 * 构造请求 URL 与请求体
 */
function buildRequest(rag, { query, documents, topN }) {
  const style = resolveApiStyle(rag);
  if (style === "dashscope") {
    return {
      style,
      url: `${rag.rerankBaseURL.replace(/\/$/, "")}/api/v1/services/rerank/text-rerank/text-rerank`,
      body: {
        model: rag.rerankModel,
        input: { query, documents },
        parameters: { top_n: topN, return_documents: false },
      },
    };
  }
  return {
    style,
    url: `${rag.rerankBaseURL.replace(/\/$/, "")}/compatible-api/v1/reranks`,
    body: {
      model: rag.rerankModel,
      query,
      documents,
      top_n: topN,
    },
  };
}

/**
 * 对候选文档精排
 *
 * @param {Object} params
 * @param {string} params.query       用户问题
 * @param {string[]} params.documents 候选文本（顺序即 index）
 * @param {number} [params.topN]      返回条数（默认取 config.rag.rerankTopN）
 * @param {AbortSignal} [params.signal] 外部取消信号
 * @returns {Promise<Array<{ index: number, score: number }>>}
 *          按相关性降序，index 为入参数组下标；不满足调用条件时返回 null
 * @throws 网络/超时/接口错误（调用方负责降级）
 */
export async function rerank({ query, documents, topN, signal }) {
  // [rerank-diag] 入口诊断：开关/密钥/入参规模
  console.log(
    `[rerank-diag] enter ready=${isRerankReady()} docs=${documents?.length} topN=${topN} cfgTopN=${config.rag.rerankTopN} model=${config.rag.rerankModel} style=${config.rag.rerankApiStyle || "auto"}`,
  );
  if (!isRerankReady() || !Array.isArray(documents) || documents.length === 0) {
    console.log(
      `[rerank-diag] skip: ready=${isRerankReady()} isArray=${Array.isArray(documents)} len=${documents?.length}`,
    );
    return null;
  }
  const rag = config.rag;
  const limit = Math.min(
    documents.length,
    topN || rag.rerankTopN || documents.length,
  );
  if (limit <= 0) {
    console.log(
      `[rerank-diag] skip: limit<=0 (docs=${documents.length} topN=${topN} cfg=${rag.rerankTopN})`,
    );
    return null;
  }

  const { url, body } = buildRequest(rag, { query, documents, topN: limit });
  // [rerank-diag] 请求诊断：解析出的风格 + 最终 URL（路径重叠会在这里暴露）
  console.log(
    `[rerank-diag] request style=${resolveApiStyle(rag)} url=${url} limit=${limit} docs=${documents.length}`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("rerank timeout")),
    rag.rerankTimeoutMs,
  );
  // 外部取消时联动中止请求
  signal?.addEventListener?.("abort", () => controller.abort(signal.reason), {
    once: true,
  });

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rag.rerankApiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    recordError("rerank.request", err, { model: rag.rerankModel });
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // [rerank-diag] HTTP 错误：状态码 + 响应体片段（路径错误/模型名错误会在这里出现）
    console.log(
      `[rerank-diag] http-fail status=${response.status} body=${detail.slice(0, 300)}`,
    );
    const err = new Error(`rerank ${response.status}: ${detail.slice(0, 200)}`);
    err.status = response.status;
    recordError("rerank.status", err, { model: rag.rerankModel });
    throw err;
  }

  const data = await response.json().catch((err) => {
    console.log(`[rerank-diag] parse-fail: ${err.message}`);
    recordError("rerank.parse", err);
    throw err;
  });

  // 两种响应风格归一化：DashScope 原生包一层 output，兼容接口在顶层
  const results = data?.output?.results ?? data?.results;
  // [rerank-diag] 响应诊断：哪个分支命中 + results 数量 + 前 3 条 score
  console.log(
    `[rerank-diag] response via=${data?.output ? "output.results" : "results"} count=${results?.length} top3=${JSON.stringify(results?.slice(0, 3)?.map((r) => ({ i: r.index, s: r.relevance_score ?? r.relevanceScore })))}`,
  );
  if (!Array.isArray(results) || results.length === 0) {
    const err = new Error("rerank 响应缺少 results");
    recordError("rerank.invalid", err);
    throw err;
  }

  return results
    .filter((item) => Number.isInteger(item.index))
    .map((item) => ({
      index: item.index,
      score:
        typeof item.relevance_score === "number"
          ? item.relevance_score
          : typeof item.relevanceScore === "number"
            ? item.relevanceScore
            : 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
