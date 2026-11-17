import { initDb, listQa } from "../src/db/index.js";
import { initVectorStore, isRagReady, getEmbeddings, upsertNamespaceVectors } from "../src/services/embeddingService.js";

await initDb();
await initVectorStore();
const { list } = await listQa({ page: 1, pageSize: 100000 });
if (!isRagReady()) {
  console.error("RAG is not ready; run after embedding configuration and initialization.");
  process.exitCode = 1;
} else {
  const embeddings = getEmbeddings();
  let count = 0;
  for (const qa of list) {
    const vector = Array.isArray(qa.embedding) && qa.embedding.length
      ? qa.embedding
      : await embeddings.embedQuery(`${qa.question}\n${qa.answer}`);
    await upsertNamespaceVectors("qa", [{
      id: `qa-${qa.id}`,
      text: `${qa.question}\n${qa.answer}`,
      metadata: {
        qaId: qa.id,
        userId: qa.userId,
        status: qa.status,
        verified: qa.verified === true,
        memoryScore: qa.memoryScore ?? 0.3,
        lastVerifiedAt: qa.lastVerifiedAt,
        question: qa.question,
      },
      embedding: vector,
    }]);
    count += 1;
  }
  console.log(`Backfilled ${count} QA memory vectors.`);
}
