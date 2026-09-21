import { config } from "../../config/index.js";

let adapter = null;

if (config.vector && config.vector.store === "upstash") {
  // lazy load upstash adapter
  const mod = await import("./upstash.js");
  adapter = mod;
}

export function isEnabled() {
  return adapter !== null;
}

export async function init() {
  if (!adapter) return;
  return adapter.init();
}

export async function upsertVectors(items) {
  if (!adapter) throw new Error("vector store not enabled");
  return adapter.upsertVectors(items);
}

export async function deleteByDocumentId(documentId) {
  if (!adapter) throw new Error("vector store not enabled");
  return adapter.deleteByDocumentId(documentId);
}

export async function search(queryEmbedding, topK = 5) {
  if (!adapter) throw new Error("vector store not enabled");
  return adapter.search(queryEmbedding, topK);
}

export async function getInfo() {
  if (!adapter) throw new Error("vector store not enabled");
  return adapter.getInfo ? adapter.getInfo() : null;
}
