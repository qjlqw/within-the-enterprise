#!/usr/bin/env node
/**
 * 检索层评估脚本（不调用大模型，可离线反复运行）
 *
 * 指标：
 * - Recall@K：期望文档出现在前 K 个召回结果中的比例
 *   多期望文档用例按 (命中期望数 / 期望总数) 计
 * - MRR：第一个期望文档所在排名的倒数（越靠前越好）
 * - 负向用例（documents 为空）：统计误召回率 falseHitRate
 *   （知识库本无答案，检索应返回空）
 * - 延迟：每次检索耗时（avg / p95）
 *
 * 用法：
 *   npm --prefix server run eval:retrieval                 # 按当前配置（RAG/rerank 开关）
 *   npm --prefix server run eval:retrieval -- --mode=keyword
 *   npm --prefix server run eval:retrieval -- --topk=5 --rerank
 *
 * 报告写入 .artifacts/retrieval-<timestamp>.json
 */
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "../src/config/index.js";
import { initDb } from "../src/db/index.js";
import {
  initVectorStore,
  isRagReady,
} from "../src/services/embeddingService.js";
import {
  searchDocuments,
  searchDocumentsHybrid,
} from "../src/services/knowledgeService.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
/**
 * - `"hybrid"` （默认）— 跑完整评估：先跑关键词基线，再跑向量混合检索（RAG 就绪时还会对比 rerank 开/关两轮）
 * - `"keyword"` — 只跑关键词检索基线，不初始化向量库，纯离线可跑
 * */
const mode = flag("mode", "hybrid"); // hybrid | keyword
const topK = Number(flag("topk", "2"));
const forceRerank = args.includes("--rerank");

initDb();

/**
 * 执行一轮评估
 * @param {Array} cases 评估用例
 * @param {(q: string) => Promise<Array>} retrieve 检索函数，返回有序片段
 */
async function runPass(cases, retrieve) {
  const results = [];
  const durations = [];
  let recallSum = 0;
  let mrrSum = 0;
  let positive = 0;
  let negativeFalseHits = 0;
  let negativeCount = 0;

  for (const item of cases) {
    const started = Date.now();
    let fragments = [];
    let error = null;
    try {
      fragments = await retrieve(item.question);
    } catch (err) {
      error = err.message;
    }
    const durationMs = Date.now() - started;
    durations.push(durationMs);
    const rankedDocIds = [...new Set(fragments.map((f) => f.documentId))];

    if (item.documents.length > 0) {
      positive += 1;
      const expected = new Set(item.documents);
      const hitCount = rankedDocIds.filter((id) => expected.has(id)).length;
      const recall = hitCount / expected.size;
      recallSum += recall;
      const firstRank = rankedDocIds.findIndex((id) => expected.has(id));
      const rr = firstRank === -1 ? 0 : 1 / (firstRank + 1);
      mrrSum += rr;
      results.push({
        id: item.id,
        rankedDocIds,
        expected: item.documents,
        recall,
        reciprocalRank: rr,
        durationMs,
        error,
      });
    } else {
      // 负向用例：知识库没有对应资料，理想情况返回空
      negativeCount += 1;
      if (rankedDocIds.length > 0) negativeFalseHits += 1;
      results.push({
        id: item.id,
        rankedDocIds,
        expected: [],
        falseHit: rankedDocIds.length > 0,
        durationMs,
        error,
      });
    }
  }

  const sorted = [...durations].sort((a, b) => a - b);
  return {
    total: cases.length,
    recallAtK: positive ? Number((recallSum / positive).toFixed(4)) : null,
    mrr: positive ? Number((mrrSum / positive).toFixed(4)) : null,
    positiveCases: positive,
    falseHitRate: negativeCount
      ? Number((negativeFalseHits / negativeCount).toFixed(4))
      : null,
    negativeCases: negativeCount,
    latencyAvgMs: Math.round(
      durations.reduce((s, d) => s + d, 0) / durations.length,
    ),
    latencyP95Ms:
      sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)],
    results,
  };
}

async function main() {
  const cases = JSON.parse(
    await fs.readFile(
      new URL("../test/agent/retrieval.json", import.meta.url),
      "utf8",
    ),
  );

  const passes = [];

  // 关键词基线（任何环境都可跑，作为降级路径质量基线）
  if (mode === "keyword" || mode === "hybrid") {
    passes.push({
      mode: "keyword",
      metrics: await runPass(cases, (question) =>
        searchDocuments({ query: question, limit: topK }),
      ),
    });
  }

  if (mode === "hybrid") {
    if (config.rag.enabled) await initVectorStore();
    if (!isRagReady()) {
      console.warn(
        "[eval] RAG 未就绪（未启用 / 缺少 EMBEDDING_API_KEY / 初始化失败），跳过混合检索评估",
      );
    } else {
      const useRerank =
        (config.rag.rerankEnabled || forceRerank) &&
        Boolean(config.rag.rerankApiKey);
      if (forceRerank && !config.rag.rerankApiKey) {
        console.warn(
          "[eval] 缺少 RERANK/EMBEDDING API Key，无法开启 rerank 对比",
        );
      }

      // 先跑关闭 rerank 的纯融合结果，作为精排收益的对照基线
      config.rag.rerankEnabled = false;
      passes.push({
        mode: "hybrid",
        metrics: await runPass(cases, (question) =>
          searchDocumentsHybrid({ query: question, limit: topK }),
        ),
      });

      if (useRerank) {
        config.rag.rerankEnabled = true;
        passes.push({
          mode: "hybrid+rerank",
          metrics: await runPass(cases, (question) =>
            searchDocumentsHybrid({ query: question, limit: topK }),
          ),
        });
      }
    }
  }

  const report = {
    date: new Date().toISOString(),
    node: process.version,
    topK,
    config: {
      ragEnabled: config.rag.enabled,
      recallTopK: config.rag.recallTopK,
      chunkSize: config.rag.chunkSize,
      rerankEnabled: config.rag.rerankEnabled,
      rerankModel: config.rag.rerankModel,
    },
    passes,
  };

  // 控制台汇总
  for (const pass of passes) {
    const m = pass.metrics;
    console.log(
      `[${pass.mode}] Recall@${topK}=${m.recallAtK} MRR=${m.mrr} ` +
        `falseHit=${m.falseHitRate} avg=${m.latencyAvgMs}ms p95=${m.latencyP95Ms}ms`,
    );
    for (const r of m.results) {
      const mark =
        r.expected.length === 0
          ? r.falseHit
            ? "FALSE-HIT"
            : "empty-ok"
          : r.recall === 1
            ? "hit"
            : r.recall > 0
              ? "partial"
              : "MISS";
      console.log(
        `  ${mark.padEnd(10)} ${r.id.padEnd(18)} -> [${r.rankedDocIds.join(",")}]`,
      );
    }
  }

  const folder = new URL("../../.artifacts/", import.meta.url);
  await fs.mkdir(folder, { recursive: true });
  const out = new URL(`retrieval-${Date.now()}.json`, folder);
  await fs.writeFile(out, JSON.stringify(report, null, 2));
  console.log(`Retrieval report: ${fileURLToPath(out)}`);
}

main().catch((err) => {
  console.error("检索评估失败:", err);
  process.exit(1);
});
