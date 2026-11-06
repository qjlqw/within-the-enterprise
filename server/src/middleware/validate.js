/**
 * 统一的请求参数校验工具（Zod）
 *
 * 目的：
 * - 分页参数设置硬上限，避免 `pageSize=100000` 造成大范围扫描与内存放大
 * - 路径参数严格解析为整数，拒绝 `4abc` 这类被 parseInt 静默截断的输入
 * - 请求体统一 schema，失败直接返回 400，而不是把脏数据写入数据库
 */
import { z } from "zod";
import { badRequest } from "../utils/response.js";

/** 正整数 ID（路径参数） */
export const idSchema = z.coerce.number().int().positive();

/** 分页参数：pageSize 硬上限，默认 10 */
export const paginationSchema = (maxPageSize = 50, defaultPageSize = 10) =>
  z.object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(maxPageSize)
      .default(defaultPageSize),
  });

/** 通用 limit 参数：用于排行榜/推荐等非分页列表 */
export const limitSchema = (max = 50, fallback = 10) =>
  z.object({
    limit: z.coerce.number().int().min(1).max(max).default(fallback),
  });

/**
 * 解析并返回校验后的数据；失败抛出 400
 * @param {import("zod").ZodType} schema
 * @param {unknown} value
 * @param {string} message
 */
export function parse(schema, value, message = "请求参数无效") {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const first = result.error.issues?.[0];
    throw badRequest(first?.message ? `${message}：${first.message}` : message);
  }
  return result.data;
}

/** 严格解析路径中的数字 ID，非法值直接 400 */
export function parseId(value, name = "id") {
  const result = idSchema.safeParse(value);
  if (!result.success) throw badRequest(`非法的 ${name}`);
  return result.data;
}

/** Express 中间件工厂：校验 body 并替换为清洗后的对象 */
export function validateBody(schema, message) {
  return (req, _res, next) => {
    try {
      req.body = parse(schema, req.body, message);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Express 中间件工厂：校验 query 并替换为清洗后的对象 */
export function validateQuery(schema, message) {
  return (req, _res, next) => {
    try {
      req.query = parse(schema, req.query, message);
      next();
    } catch (error) {
      next(error);
    }
  };
}
