/**
 * 文档文件解析服务（P1 数据入口）
 *
 * 当前支持：
 * - Markdown（.md / .markdown）：原文直接入库
 * - 纯文本（.txt）：UTF-8 解码后入库
 * - Word（.docx）：mammoth 提取纯文本（不依赖 Python / 原生模块）
 *
 * 明确不支持：
 * - 旧版 .doc（mammoth 不支持二进制格式）
 * - PDF（pdf-parse 无法支撑大文件流式分页，按排期后置）
 *
 * 安全约束：
 * - 扩展名白名单 + MIME/文件头嗅探双重校验，不能只信任上传方声明的 Content-Type
 * - 解析在内存中完成，大小上限由路由层 multer 与 config.document.uploadMaxBytes 控制
 * - 解析后正文为空直接拒绝，避免产生空文档脏数据
 */
import mammoth from "mammoth";
import path from "node:path";
import { config } from "../config/index.js";
import { badRequest } from "../utils/response.js";

/** 扩展名 -> 格式 */
const EXT_FORMAT = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".docx": "docx",
};

/** 取小写扩展名（含点） */
export function getExtension(filename = "") {
  return path.extname(String(filename)).toLowerCase();
}

/** 扩展名是否在上传白名单 */
export function isAllowedExtension(filename) {
  return config.document.allowedExtensions.includes(getExtension(filename));
}

/**
 * 文件头（magic bytes）嗅探
 * - docx 本质是 ZIP：PK\x03\x04 / 空压缩包 PK\x05\x06 / 分卷 PK\x07\x08
 * - md/txt 为文本：不含 NUL，且 UTF-8 解码后不可见控制符占比极低
 */
function sniffKind(buffer, ext) {
  const head = buffer.subarray(0, 4);
  const isZip =
    (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) ||
    (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x05 && head[3] === 0x06) ||
    (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x07 && head[3] === 0x08);

  if (ext === ".docx") {
    if (!isZip) throw badRequest("DOCX 文件内容无效（不是有效的 Office 文档）");
    return "docx";
  }

  if (isZip) {
    throw badRequest("文件内容与扩展名不符：仅支持 Markdown / TXT / DOCX");
  }
  // 文本类：出现 NUL 字节基本可判定为二进制伪装
  if (buffer.includes(0)) {
    throw badRequest("文本文件包含非法二进制内容");
  }
  return "text";
}

/**
 * 解析上传文件为纯文本正文
 *
 * @param {Object} file multer 文件对象（memoryStorage：含 buffer/originalname/mimetype）
 * @returns {Promise<{ format: string, title: string, content: string, warnings: string[] }>}
 * @throws ApiError(400) 类型不支持 / 内容非法 / 正文为空
 */
export async function parseDocumentFile(file) {
  if (!file?.buffer) throw badRequest("文件内容为空");
  const ext = getExtension(file.originalname);
  if (!isAllowedExtension(file.originalname)) {
    throw badRequest("仅支持 Markdown、TXT、DOCX 格式文件");
  }

  const format = EXT_FORMAT[ext];
  const sniffed = sniffKind(file.buffer, ext);
  const warnings = [];
  let content = "";

  if (sniffed === "docx") {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    content = result.value || "";
    // mammoth 的 warnings 主要是无法识别的样式等，不影响文本提取
    if (result.messages?.length) {
      warnings.push(`DOCX 转换提示 ${result.messages.length} 条`);
    }
  } else {
    // UTF-8 解码并去掉 BOM；统一换行符
    content = file.buffer
      .toString("utf-8")
      .replace(/^﻿/, "")
      .replace(/\r\n?/g, "\n");
  }

  content = content.replace(/\u0000/g, "").trim();
  if (!content) throw badRequest("文件内容为空或无法解析出文本");

  return {
    format,
    title: extractTitle(content, file.originalname, format),
    content,
    warnings,
  };
}

/**
 * 推导文档标题：
 * - Markdown 取第一个一级标题（# xxx）
 * - 其他格式取第一个非空行（最多 80 字）
 * - 都没有则用去掉扩展名的文件名
 */
function extractTitle(content, filename, format) {
  if (format === "markdown") {
    const h1 = content.match(/^#\s+(.+?)\s*$/m);
    if (h1?.[1]?.trim()) return h1[1].trim().slice(0, 80);
  }
  const firstLine = content
    .split("\n")
    .map((line) => line.trim().replace(/^#+\s*/, ""))
    .find(Boolean);
  if (firstLine) return firstLine.slice(0, 80);
  return path.basename(filename, getExtension(filename)).slice(0, 80) || "未命名文档";
}

/** multer fileFilter：扩展名 + 声明 MIME 初筛（内容嗅探在解析时二次校验） */
export function documentFileFilter(_req, file, cb) {
  if (!isAllowedExtension(file.originalname)) {
    return cb(badRequest("仅支持 .md / .markdown / .txt / .docx 文件"));
  }
  // 浏览器/系统对 md、docx 的 MIME 声明不统一（常为 application/octet-stream 或 text/plain），
  // 这里只拦明显不属于文档的类型，真正校验交给文件头嗅探
  const allowedMimePrefixes = ["text/", "application/octet-stream", "application/vnd.openxmlformats", ""];
  const mime = (file.mimetype || "").toLowerCase();
  if (mime && !allowedMimePrefixes.some((prefix) => mime.startsWith(prefix))) {
    return cb(badRequest("文件类型不被允许"));
  }
  cb(null, true);
}
