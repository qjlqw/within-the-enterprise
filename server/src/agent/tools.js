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
        return JSON.stringify({
          items: items.map((item) => registry.register(item)),
        });
      },
      {
        name: "search_documents",
        description:
          "搜索已发布知识库，支持语义检索与关键词组合。可用自然语言提问，也可提取简短关键词以空格分隔；无结果时尝试其他表述。",
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
          return JSON.stringify(registry.register(await readDocument(args)));
        } catch (error) {
          if (error.status === 404)
            return JSON.stringify({ error: "文档不存在或未发布" });
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
  ];
}
