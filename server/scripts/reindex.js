#!/usr/bin/env node
/**
 * 向量库批量重建脚本
 *
 * 用途：
 * - 首次启用 RAG 时灌入存量数据
 * - 向量库损坏后恢复
 * - 切换 embedding 模型后重建
 *
 * 前置条件：
 * 1) server/.env 配置 RAG_ENABLED=true、LLM_API_KEY
 * 2) 无需外部进程，HNSWLib 随 Node.js 运行
 *
 * 执行：npm --prefix server run reindex
 */
import { config } from "../src/config/index.js";
import { initDb, listDocuments } from "../src/db/index.js";
import { initVectorStore, upsertDocument } from "../src/services/embeddingService.js";

async function main() {
  console.log("========================================");
  console.log("  向量库批量重建");
  console.log("========================================");

  if (!config.rag.enabled) {
    console.error("[RAG] 未启用（RAG_ENABLED 非 true），退出");
    process.exit(1);
  }
  if (!config.rag.embeddingApiKey) {
    console.error("[RAG] 缺少 embeddingApiKey（复用 LLM_API_KEY），退出");
    process.exit(1);
  }

  // 初始化数据连接 + 向量库连接
  await initDb();
  await initVectorStore();
  console.log("[RAG] 本地向量库已就绪，开始批量重建...");

  const { list: published } = await listDocuments({ status: "published" });
  console.log(`[RAG] 共 ${published.length} 篇已发布文档待索引`);

  let success = 0;
  let failed = 0;
  let chunks = 0;
  for (const doc of published) {
    try {
      const result = await upsertDocument(doc);
      success++;
      chunks += result.indexed || 0;
      if (success % 5 === 0) console.log(`[RAG] 进度: ${success}/${published.length}`);
    } catch (err) {
      failed++;
      console.error(`[RAG] 文档 ${doc.id} (${doc.title}) 索引失败:`, err.message);
    }
  }
  console.log(`[RAG] 切片总数: ${chunks}`);

  console.log("========================================");
  console.log(`  重建完成: 成功 ${success} / 失败 ${failed}`);
  console.log("========================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[RAG] 重建失败:", err);
  process.exit(1);
});
