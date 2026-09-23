/**
 * 知识助手 Agent 路由
 *
 * 路由前缀：/api/agent（在 app.js 中挂载）
 *
 * 接口列表：
 *   POST   /sessions                创建会话
 *   GET    /sessions                分页查询会话列表
 *   GET    /sessions/:id            查询会话详情（含消息与运行状态）
 *   DELETE /sessions/:id             删除会话
 *   POST   /sessions/:id/cancel      取消运行中的问答
 *   POST   /sessions/:id/messages    提交新一轮问答（SSE 流式响应）
 *
 * 所有接口都要求登录（auth 中间件）。
 * createAgentRouter 接受依赖注入参数，便于测试替换。
 */
import { Router } from "express";
import { z } from "zod";
import { auth } from "../middleware/auth.js";
import { success, badRequest } from "../utils/response.js";
import { config } from "../config/index.js";
import { sessionStore } from "../agent/sessionStore.js";
import { assertModelConfigured } from "../agent/model.js";
import { runAgent } from "../agent/index.js";
import { publicError } from "../agent/events.js";
import { audit } from "../services/observability.js";

// 请求体 / 查询参数 schema
const messageSchema = z
  .object({
    message: z.string().trim().min(1).max(4000),   // 用户提问内容
    clientMessageId: z.uuid(),                     // 客户端幂等键，避免重复提交
  })
  .strict();
const cancelSchema = z.object({ runId: z.uuid() }).strict();
const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(20).default(20),
});

/** 通用 schema 解析：失败抛 badRequest 由错误中间件统一处理 */
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest("请求参数无效");
  return result.data;
};

/**
 * 创建 agent 路由
 * @param {Object} deps 依赖注入（默认使用真实实现）
 *   - store         会话存储
 *   - runner        agent 运行函数
 *   - checkConfig   模型配置检查
 *   - options       agent 运行参数
 */
export function createAgentRouter({
  store = sessionStore,
  runner = runAgent,
  checkConfig = assertModelConfigured,
  options = config.agent,
} = {}) {
  const router = Router();
  router.use(auth);  // 全部接口都需登录

  // 创建会话
  router.post("/sessions", async (req, res, next) => {
    try {
      success(res, await store.view(store.create(req.user.id)));
    } catch (error) {
      next(error);
    }
  });

  // 分页查询会话列表
  router.get("/sessions", async (req, res, next) => {
    try {
      const { page, pageSize } = parse(paginationSchema, req.query);
      success(res, await store.list(req.user.id, page, pageSize));
    } catch (error) {
      next(error);
    }
  });

  // 查询会话详情
  router.get("/sessions/:id", async (req, res, next) => {
    try {
      success(res, await store.view(store.get(req.user.id, req.params.id)));
    } catch (error) {
      next(error);
    }
  });

  // 删除会话（若有运行中任务会先中止）
  router.delete("/sessions/:id", (req, res, next) => {
    try {
      store.remove(req.user.id, req.params.id);
      success(res);
    } catch (error) {
      next(error);
    }
  });

  // 取消运行中的问答：runId 必须匹配当前会话的运行
  router.post("/sessions/:id/cancel", (req, res, next) => {
    try {
      const session = store.get(req.user.id, req.params.id);
      const { runId } = parse(cancelSchema, req.body);
      if (session.run?.runId === runId)
        session.run.controller.abort("cancelled");
      success(res);
    } catch (error) {
      next(error);
    }
  });

  /**
   * 提交消息并流式返回回答（SSE）
   *
   * 整体流程：
   * 1) 读取会话与历史 -> 校验模型配置 -> 开启运行
   * 2) 设置 SSE 响应头，写出 start 事件
   * 3) 与 agent 运行竞速：AbortController 控制取消
   *    - 模型正常完成：写出 sources + done
   *    - 用户取消 / 断连：done cancelled
   *    - 其他错误：写 error 事件
   * 4) finally 中清理定时器、收尾运行状态、结束响应、打印审计日志
   *
   * SSE 事件：start / token / tool_start / tool_end / sources / done / error
   * 心跳：每 15s 写一行注释，避免代理超时关闭连接
   */
  router.post("/sessions/:id/messages", async (req, res, next) => {
    let session, run, history;
    try {
      // 阶段 1：准备阶段（同步错误走 next）
      session = store.get(req.user.id, req.params.id);
      const body = parse(messageSchema, req.body);
      checkConfig(options);
      history = await store.history(session);
      run = store.begin(session, body.message, body.clientMessageId);
    } catch (error) {
      return next(error);
    }

    const { controller, turn, runId } = run;
    const started = Date.now();
    let terminal = false;      // 是否已写终结事件（done/error），避免重复写
    let usage;
    /** SSE 写出一行事件 */
    const write = (event, data) => {
      if (terminal || res.destroyed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    /** 把 agent 内部 emit 转成对外的 SSE 事件 */
    const emit = (event, data) => {
      if (controller.signal.aborted || terminal) return;
      if (event === "token") {
        // 流式 token：累加到 assistant 消息内容并下发
        turn.assistant.content += data.delta;
        write(event, { ...data, messageId: turn.assistant.id });
      } else if (event === "tool_start" || event === "tool_end")
        write(event, data);
    };
    /** 客户端断连时中止运行 */
    const close = () => {
      if (!terminal) controller.abort("disconnected");
    };
    // 超时定时器：到点主动中止运行
    const timer = setTimeout(
      () => controller.abort("timeout"),
      options.timeoutMs,
    );
    // 心跳：防止代理在长时间无数据时关闭连接
    const heartbeat = setInterval(() => {
      if (!terminal && !res.destroyed) res.write(": heartbeat\n\n");
    }, 15000);
    res.on("close", close);
    let onAbort;
    try {
      // 阶段 2：写 SSE 头并发出 start 事件
      res
        .status(200)
        .set({
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",  // 关闭 Nginx 缓冲，确保流式下发
        });
      res.flushHeaders();
      write("start", {
        runId,
        sessionId: session.sessionId,
        messageId: turn.assistant.id,
      });

      // 把 abort 转成 Promise reject，与 runner 竞速
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new Error("Run aborted"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      // 阶段 3：运行 agent
      const result = await Promise.race([
        runner({
          userId: req.user.id,
          message: turn.user.content,
          history,
          signal: controller.signal,
          emit,
          options,
          onEvidence: (sources) => {
            // 实时更新本轮证据列表（前端可展示引用来源）
            if (!controller.signal.aborted && !terminal)
              turn.evidence = sources;
          },
        }),
        aborted,
      ]);
      controller.signal.throwIfAborted();
      // 阶段 4a：成功收尾
      turn.assistant.content = result.text;
      turn.assistant.sources = result.sources;
      turn.assistant.status = "completed";
      turn.evidence = result.evidence;
      usage = result.usage;
      write("sources", { items: result.sources });
      write("done", { runId, status: "completed", usage });
    } catch (error) {
      console.log("error", error);

      // 阶段 4b：失败收尾，区分取消 / 超时 / 资料变更 / 其他
      const reason = controller.signal.reason;
      const cancelled =
        controller.signal.aborted &&
        ["cancelled", "disconnected"].includes(reason);
      turn.assistant.status = cancelled ? "cancelled" : "failed";
      turn.assistant.sources = [];
      if (cancelled) write("done", { runId, status: "cancelled" });
      else {
        const detail =
          reason === "timeout"
            ? { code: "TIMEOUT", message: "回答超时，请重试或缩小问题范围" }
            : reason === "sources_changed"
              ? { code: "SOURCES_CHANGED", message: "资料已变更，请重新提问" }
              : publicError(error);
        turn.assistant.error = detail.message;
        write("error", { runId, ...detail });
      }
    } finally {
      // 阶段 5：清理资源（无论成功失败都执行）
      terminal = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      res.off("close", close);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      controller.abort("finished");
      store.finish(session, run);
      if (!res.destroyed) res.end();
      // 审计日志：记录谁、在哪轮会话、运行时长、状态与用量（不含提问正文）
      audit("agent.run", {
        runId,
        userId: req.user.id,
        sessionId: session.sessionId,
        durationMs: Date.now() - started,
        status: turn.assistant.status,
        usage,
      });
    }
  });
  return router;
}

export default createAgentRouter();
