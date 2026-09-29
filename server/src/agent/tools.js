/**
 * Agent 可用工具定义
 *
 * 工具是只读的：仅检索与读取已发布文档，
 * 任何写入/删除操作都不得作为工具暴露给模型。
 *
 * 每个工具返回的内容都会通过 registry.register 注册为来源编号，
 * 这样模型回答时必须用 [Sx] 引用，便于事后校验。
 */
import { tool } from "langchain";
import { z } from "zod";
import {
  readDocument,
  searchDocuments,
  searchDocumentsHybrid,
} from "../services/knowledgeService.js";
import { lookupConfirmedEntity } from "../db/index.js";
import { searchHistoricalQA } from "../services/qaMemoryService.js";
import { config } from "../config/index.js";

/**
 * 创建知识工具集
 * @param {Object} params
 * @param {number} params.userId    当前用户 id（保留扩展：未来可按用户过滤可见文档）
 * @param {SourceRegistry} params.registry 来源注册表，工具返回的片段都通过它注册
 * @param {AbortSignal} params.signal  中断信号，工具调用前先检查是否已取消
 */
export function createKnowledgeTools({ userId, registry, signal }) {
  if (!userId) throw new Error("Server identity required");
  // 同一轮运行的检索硬预算：模型会把「found 但不是目标文档」当规则漏洞
  // 反复换词检索（历史事故：追索已删除文档直到 60s 超时中止）。
  // 超过预算一律强制收口，不再执行真实检索。
  const MAX_SEARCH_CALLS = 3;
  let searchCalls = 0;
  return [
    /**
     * search_documents：混合检索已发布文档（向量召回 + 关键词加权融合）
     * - RAG 启用时走向量库语义召回 + 关键词加权融合排序
     * - RAG 未启用或向量库不可用时自动回退到纯关键词检索
     * - 返回 top limit 个片段（带命中位置附近的预览文本）
     * - 工具返回的片段都通过 registry.register 注册为来源编号
     */
    tool(
      async (args) => {
        signal.throwIfAborted();
        if (++searchCalls > MAX_SEARCH_CALLS) {
          return JSON.stringify({
            status: "budget_exceeded",
            items: [],
            hint: `本轮检索已达上限（${MAX_SEARCH_CALLS} 次）。禁止再次检索，立即基于已有信息作答；若目标文档未命中，明确告知用户知识库暂无此资料，不得臆测其存在。`,
          });
        }
        // 优先混合检索（透传取消信号给 rerank）；失败时回退到关键词检索，保证可用性
        const items = await searchDocumentsHybrid({ ...args, signal }).catch(
          (err) => {
            // [rerank-diag] hybrid 抛异常被 catch：这里会静默回退到关键词，rerank 不会执行
            console.log(
              `[rerank-diag] hybrid-threw-fallback-to-keyword: ${err?.message || err}`,
            );
            return searchDocuments(args);
          },
        );
        const registered = items.map((item) => registry.register(item));
        // not_found 作为一等状态显式返回：让模型明确感知「检索失败」，
        // 走收口分支（告知用户缺资料），而不是换词死磕或臆测文档存在
        return JSON.stringify(
          registered.length
            ? { status: "found", items: registered }
            : {
                status: "not_found",
                items: [],
                hint: "未检索到相关资料。最多再换 1 种表述重试；仍无结果则停止检索，明确告知用户知识库暂无此资料，不得臆测文档存在。",
              },
        );
      },
      {
        name: "search_documents",
        description:
          "搜索已发布知识库，支持语义检索与关键词组合。可用自然语言提问，也可提取简短关键词以空格分隔。硬性限制：同一轮回答中无论返回 found 还是 not_found，本工具最多调用 3 次；检索结果中没有目标文档即视为知识库缺失，停止检索并明确告知用户缺少资料，不得换词反复检索或臆测文档存在。",
        // 默认返回条数取 RAG_TOP_K（最终给 agent 的条数）；召回候选池由 RAG_RECALL_TOP_K 独立控制
        schema: z
          .object({
            query: z.string().trim().min(1).max(200),
            category: z.string().max(100).optional(),
            limit: z.number().int().min(1).max(10).default(config.rag.topK),
          })
          .strict(),
      },
    ),
    /**
     * read_document：按 id 读取已发布文档正文（分页）
     * - 不会增加浏览量（仅用于 agent 取数）
     * - 支持 offset / maxChars 分段读取，避免一次返回过长
     * - 文档不存在时返回 JSON 错误（而非抛异常），让模型继续决策
     */
    tool(
      async (args) => {
        signal.throwIfAborted();
        try {
          return JSON.stringify({
            status: "found",
            ...registry.register(await readDocument(args)),
          });
        } catch (error) {
          if (error.status === 404)
            return JSON.stringify({
              status: "not_found",
              error: "文档不存在或未发布",
              hint: "禁止再次尝试读取同一文档 ID，直接基于已有信息作答。",
            });
          throw error;
        }
      },
      {
        name: "read_document",
        description:
          "按文档 ID 读取已发布正文，不增加浏览量。可使用 nextOffset 分段读取。",
        schema: z
          .object({
            documentId: z.number().int().positive(),
            offset: z.number().int().nonnegative().default(0),
            maxChars: z.number().int().min(1).max(6000).default(6000),
          })
          .strict(),
      },
    ),
    /**
     * lookup_entity：按名称/别名查结构化实体（仅 confirmed）
     * - 返回实体 summary + aliases，并把 sources（源文档）解析为文档片段注册为 [Sx]
     * - 只召回人工确认过的实体，未确认的抽取结果不参与检索
     */
    tool(
      async (args) => {
        signal.throwIfAborted();
        const entity = await lookupConfirmedEntity(args.name);
        if (!entity)
          return JSON.stringify({
            status: "not_found",
            found: false,
            name: args.name,
            hint: "实体不存在或未确认。禁止臆测该实体定义，可改用 search_documents 检索或直接告知用户缺少资料。",
          });
        const sources = [];
        for (const docId of entity.sources || []) {
          try {
            const frag = await readDocument({ documentId: docId, maxChars: 2000 });
            sources.push(registry.register(frag));
          } catch {
            // 源文档已删除/下线：跳过，不阻断实体返回
          }
        }
        return JSON.stringify({
          status: "found",
          found: true,
          name: entity.name,
          type: entity.type,
          aliases: entity.aliases,
          summary: entity.summary,
          sources,
        });
      },
      {
        name: "lookup_entity",
        description:
          "按名称或别名查询知识库中已人工确认的结构化实体（人物/组织/产品/概念等），返回实体摘要及其来源文档片段。仅在需要了解某个具体概念的权威定义时使用。",
        schema: z
          .object({
            name: z.string().trim().min(1).max(100),
          })
          .strict(),
      },
    ),
    // 长期记忆：仅 MEMORY_ENABLED=true 时暴露历史问答检索工具
    ...(config.memory.enabled
      ? [
          /**
           * searchHistoricalQA：语义召回当前用户「已确认」的历史问答
           * - 强制按 userId 隔离，只召回 confirmed，避免跨用户泄露
           * - 历史答案已剥离旧 [Sx] 编号，其来源重新 sourceIsValid 校验后注册为新编号
           */
          tool(
            async (args) => {
              signal.throwIfAborted();
              const items = await searchHistoricalQA({
                userId,
                query: args.query,
                limit: args.limit,
              });
              return JSON.stringify({
                items: items.map((item) => ({
                  question: item.question,
                  answer: item.answer,
                  sources: item.sources.map((source) =>
                    registry.register(source),
                  ),
                })),
              });
            },
            {
              name: "searchHistoricalQA",
              description:
                "检索当前用户此前已确认有效的历史问答，用于复用过往已采信的结论、保持回答口径一致。返回的问题与答案均来自历史对话沉淀。",
              schema: z
                .object({
                  query: z.string().trim().min(1).max(200),
                  limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(10)
                    .default(config.memory.qaTopK),
                })
                .strict(),
            },
          ),
        ]
      : []),
  ];
}
