/**
 * 服务启动入口：
 * - 连接 Supabase 数据库（纯直查，无内存种子数据）
 * - 在配置端口上监听 HTTP 请求
 * - 注册 SIGINT / SIGTERM 优雅退出
 *
 * 启动命令：npm --prefix server run dev
 */
import app from "./app.js";
import { config } from "./config/index.js";
import { initDb } from "./db/index.js";
import { initVectorStore } from "./services/embeddingService.js";
import { registerProcessHandlers, recordError, audit } from "./services/observability.js";

// 进程级兜底：未捕获异常 / 未处理 Promise 拒绝进入错误监控
registerProcessHandlers();

// 连接 Supabase 数据库（未配置环境变量时直接抛错，不回退内存）
await initDb();

// 初始化向量库：失败不阻断服务，agent 自动降级为关键词检索
if (config.rag.enabled) {
  initVectorStore().catch((err) => {
    recordError("rag.init", err);
    console.error("[RAG] 初始化失败，已降级为关键词检索:", err.message);
  });
}

const server = app.listen(config.port, () => {
  console.log(`========================================`);
  console.log(`  企业内部知识库后端服务已启动`);
  console.log(`  地址: http://localhost:${config.port}`);
  console.log(`  API:  http://localhost:${config.port}/api`);
  console.log(`  Agent enabled: ${config.agent.enabled} (PID: ${process.pid})`);
  console.log(`  RAG enabled: ${config.rag.enabled}`);
  console.log(`  Rerank enabled: ${config.rag.rerankEnabled}`);
  console.log(`========================================`);
  audit("server.start", { port: config.port, ragEnabled: config.rag.enabled, rerankEnabled: config.rag.rerankEnabled });
});

// 优雅退出：收到信号后关闭 HTTP server，避免请求被强行中断
process.on("SIGINT", () => {
  server.close(() => {
    console.log("\n服务已停止");
    audit("server.stop", { signal: "SIGINT" });
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

export default server;
