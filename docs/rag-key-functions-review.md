# RAG 关键函数摘录 — embeddingService 与 indexQueue

本文件汇总 `server/src/services/embeddingService.js` 与 `server/src/services/indexQueue.js` 中用于向量索引与队列的关键函数完整实现，便于审阅与风险评估。

---

## embeddingService.js 关键函数

```javascript
export function currentIndexVersion() {
  const { rag } = config;
  return `v${INDEX_FORMAT_VERSION}:${rag.embeddingModel}:${rag.chunkSize}:${rag.chunkOverlap}`;
}

function createEmbeddings() {
  const { rag } = config;
  return new OpenAIEmbeddings({
    model: rag.embeddingModel,
    apiKey: rag.embeddingApiKey,
    configuration: { baseURL: rag.embeddingBaseURL },
    maxRetries: 0,
  });
}

async function embedDocumentsBatched(texts) {
  const result = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embeddings.embedDocuments(batch);
    for (let j = 0; j < vectors.length; j++) result.push(vectors[j]);
  }
  return result;
}

function loadVectors() {
  try {
    if (!fs.existsSync(VECTORS_FILE)) return { loaded: 0, stale: false };
    const data = JSON.parse(fs.readFileSync(VECTORS_FILE, "utf-8"));
    const stale = !data.version || data.version !== currentIndexVersion();
    if (stale) {
      console.warn(
        `[RAG] 索引版本不一致（磁盘: ${data.version}，当前: ${currentIndexVersion()}），丢弃旧索引并重建`,
      );
      vectors = [];
      idCounter = 0;
      return { loaded: 0, stale: true };
    }
    vectors = data.vectors || [];
    idCounter = data.idCounter || 0;
    return { loaded: vectors.length, stale: false };
  } catch {
    vectors = [];
    idCounter = 0;
    return { loaded: 0, stale: false };
  }
}

function saveVectors() {
  try {
    fs.mkdirSync(VECTORS_DIR, { recursive: true });
    fs.writeFileSync(
      VECTORS_FILE,
      JSON.stringify(
        { version: currentIndexVersion(), vectors, idCounter },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("[RAG] 向量数据持久化失败:", err.message);
  }
}

async function chunkDocument(doc) {
  const { chunkSize, chunkOverlap } = config.rag;
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    lengthFunction: (text) => text.length,
    separators: ["\n\n", "\n", "。", "！", "？", "；", "，", " "],
    keepSeparator: true,
  });
  const texts = await splitter.splitText(doc.content);

  const chunks = [];
  for (const text of texts) {
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    const offset = doc.content.indexOf(text);
    if (offset === -1) continue;
    chunks.push({
      text,
      metadata: {
        documentId: doc.id,
        title: doc.title,
        category: doc.category,
        version: doc.version,
        offset,
        nextOffset:
          offset + text.length < doc.content.length
            ? offset + text.length
            : null,
      },
    });
  }
  return chunks;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function initVectorStore() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      if (!config.rag.enabled) {
        console.log("[RAG] 未启用（RAG_ENABLED 非 true），跳过初始化");
        return;
      }
      if (!config.rag.embeddingApiKey) {
        console.warn(
          "[RAG] 缺少 embeddingApiKey，跳过初始化（复用 LLM_API_KEY）",
        );
        return;
      }
      embeddings = createEmbeddings();
      loadVectors();

      if (vectors.length > 0) {
        console.log(`[RAG] 向量库已就绪（复用已有 ${vectors.length} 个切片）`);
        initialized = true;
        return;
      }

      const docs = allDocuments().filter((d) => d.status === "published");
      console.log(`[RAG] 正在为 ${docs.length} 篇文档生成向量...`);
      let total = 0;
      for (const doc of docs) {
        try {
          const chunks = await chunkDocument(doc);
          if (chunks.length === 0) continue;
          const texts = chunks.map((c) => c.text);
          const embeddingsArr = await embedDocumentsBatched(texts);
          for (let i = 0; i < chunks.length; i++) {
            vectors.push({
              id: `v${++idCounter}`,
              text: chunks[i].text,
              metadata: chunks[i].metadata,
              embedding: embeddingsArr[i],
            });
          }
          total += chunks.length;
        } catch (err) {
          console.error(`[RAG] 文档 ${doc.id} 入库失败:`, err.message);
        }
      }
      saveVectors();
      console.log(
        `[RAG] 向量库已就绪，已索引 ${docs.length} 篇文档 / ${total} 个切片`,
      );
      initialized = true;
    } catch (err) {
      console.error("[RAG] 初始化失败，已降级为关键词检索");
      console.error("      原因:", err.message);
      console.error("      排查：");
      console.error("      1) Embedding API Key 是否有效？");
      console.error(`      2) 索引目录可写？${VECTORS_DIR}`);
      console.error("      agent 仍可工作，仅检索回退为关键词模式");
      initialized = false;
    }
  })();
  return initPromise;
}

export async function upsertDocument(doc) {
  if (!initialized || !embeddings) return { indexed: 0 };
  if (doc.status !== "published") {
    await deleteDocument(doc.id);
    return { indexed: 0 };
  }
  vectors = vectors.filter((v) => v.metadata.documentId !== doc.id);
  const chunks = await chunkDocument(doc);
  if (chunks.length === 0) {
    saveVectors();
    return { indexed: 0 };
  }
  const texts = chunks.map((c) => c.text);
  const embeddingsArr = await embedDocumentsBatched(texts);
  for (let i = 0; i < chunks.length; i++) {
    vectors.push({
      id: `v${++idCounter}`,
      text: chunks[i].text,
      metadata: chunks[i].metadata,
      embedding: embeddingsArr[i],
    });
  }
  saveVectors();
  return { indexed: chunks.length };
}

export async function deleteDocument(docId) {
  if (!initialized) return;
  const before = vectors.length;
  vectors = vectors.filter((v) => v.metadata.documentId !== docId);
  if (vectors.length !== before) saveVectors();
}

export async function semanticSearch({ query, category, limit = 5 }) {
  if (!initialized || !embeddings || vectors.length === 0) return [];
  try {
    const queryEmbedding = await embeddings.embedQuery(query);
    const scored = vectors
      .filter((v) => !category || v.metadata.category === category)
      .map((v) => ({
        ...v,
        score: cosineSimilarity(queryEmbedding, v.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map((v) => ({
      documentId: v.metadata.documentId,
      title: v.metadata.title,
      category: v.metadata.category,
      version: v.metadata.version,
      offset: v.metadata.offset,
      text: v.text,
      nextOffset: v.metadata.nextOffset,
      score: v.score,
    }));
  } catch (err) {
    console.error("[RAG] semanticSearch 失败，回退关键词检索:", err.message);
    return [];
  }
}

export const isRagReady = () => initialized;
```

---

## indexQueue.js 关键函数

```javascript
export function createIndexQueue(deps = {}) {
  const options = deps.options || config.indexQueue;
  const upsert = deps.upsert || upsertDocument;
  const remove = deps.remove || deleteDocument;
  const findDoc = deps.findDoc || findDocument;
  const ready = deps.ready || isRagReady;
  const ragEnabled = deps.ragEnabled || (() => config.rag.enabled);
  const setTimer =
    deps.setTimer ||
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
  const clearTimer = deps.clearTimer || clearTimeout;
  const now = deps.now || Date.now;

  const jobs = new Map();
  const byDoc = new Map();

  let timer = null;
  let pumping = false;

  const iso = () => new Date(now()).toISOString();

  function schedule(delay = 0) {
    if (timer) return;
    timer = setTimer(() => {
      timer = null;
      void pump();
    }, delay);
  }

  function enqueue(docId, reason = "document_changed") {
    const id = Number(docId);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const current = byDoc.get(id);
    if (
      current &&
      ["pending", "processing", "waiting", "retrying"].includes(current.status)
    ) {
      return current;
    }
    const job = {
      jobId: randomUUID(),
      docId: id,
      status: "pending",
      reason,
      attempts: 0,
      indexed: 0,
      lastError: null,
      runAt: now(),
      createdAt: iso(),
      updatedAt: iso(),
    };
    jobs.set(job.jobId, job);
    byDoc.set(id, job);
    pruneHistory();
    schedule(0);
    return job;
  }

  function pruneHistory() {
    if (jobs.size <= MAX_HISTORY) return;
    const finished = [...jobs.values()]
      .filter((job) => job.status === "done" || job.status === "failed")
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const removeCount = jobs.size - MAX_HISTORY;
    for (const job of finished.slice(0, removeCount)) jobs.delete(job.jobId);
  }

  function nextDueJob() {
    return [...jobs.values()]
      .filter((job) => ["pending", "retrying", "waiting"].includes(job.status))
      .filter((job) => job.runAt <= now())
      .sort(
        (a, b) => a.runAt - b.runAt || a.createdAt.localeCompare(b.createdAt),
      )[0];
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (true) {
        const job = nextDueJob();
        if (!job) break;
        job.status = "processing";
        job.updatedAt = iso();

        if (ragEnabled() && !ready()) {
          job.status = "waiting";
          job.runAt = now() + 2000;
          schedule(2000);
          break;
        }

        try {
          job.attempts += 1;
          const doc = findDoc(job.docId);
          if (!doc || doc.status !== "published") {
            await remove(job.docId);
            job.indexed = 0;
          } else {
            const result = await upsert(doc);
            job.indexed = result?.indexed || 0;
          }
          job.status = "done";
          job.runAt = 0;
          job.lastError = null;
          job.updatedAt = iso();
          audit("index_job.done", {
            docId: job.docId,
            attempts: job.attempts,
            indexed: job.indexed,
          });
        } catch (err) {
          job.lastError = String(err?.message || err).slice(0, 300);
          job.updatedAt = iso();
          if (job.attempts >= options.maxAttempts) {
            job.status = "failed";
            job.runAt = 0;
            recordError("index_job", err, {
              docId: job.docId,
              attempts: job.attempts,
            });
            audit("index_job.failed", {
              docId: job.docId,
              attempts: job.attempts,
              reason: job.reason,
              error: job.lastError,
            });
          } else {
            job.status = "retrying";
            const delay = options.retryBaseDelayMs * 2 ** (job.attempts - 1);
            job.runAt = now() + delay;
            schedule(delay);
          }
        }
      }
    } finally {
      pumping = false;
    }
  }

  function retry(jobId) {
    const job = jobs.get(jobId);
    if (!job) return null;
    if (!["failed", "done"].includes(job.status)) return job;
    job.status = "pending";
    job.attempts = 0;
    job.lastError = null;
    job.reason = "manual_retry";
    job.runAt = now();
    job.updatedAt = iso();
    schedule(0);
    return job;
  }

  function getByDoc(docId) {
    return byDoc.get(Number(docId)) || null;
  }

  function list({ status } = {}) {
    return [...jobs.values()]
      .filter((job) => !status || job.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function stats() {
    const result = { total: jobs.size };
    for (const job of jobs.values())
      result[job.status] = (result[job.status] || 0) + 1;
    return result;
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { enqueue, retry, getByDoc, list, stats, stop, schedule, pump };
}

export const indexQueue = createIndexQueue();

export const enqueueIndexJob = (docId, reason) =>
  indexQueue.enqueue(docId, reason);
```
