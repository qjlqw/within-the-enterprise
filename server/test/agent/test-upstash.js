#!/usr/bin/env node
import {
  initVectorStore,
  upsertDocument,
  semanticSearch,
  deleteDocument,
  isRagReady,
} from "../../src/services/embeddingService.js";
import * as vectorStore from "../../src/services/vectorStore/index.js";
import { config } from "../../src/config/index.js";

(async () => {
  try {
    console.log("[E2E] Starting Upstash end-to-end test");
    console.log("[E2E] VECTOR_STORE=", config.vector.store);

    // Initialize embedding service / vector store
    await initVectorStore();

    // Prefer to test vectorStore directly: query index info to determine expected dimension
    if (vectorStore.isEnabled()) {
      console.log(
        "[E2E] vectorStore adapter enabled - testing vectorStore directly",
      );
      await vectorStore.init();
      const info = await vectorStore.getInfo();
      console.log("[E2E] index info:", info);
      // Determine expected dimension from info if available
      const expectedDim = info?.dimension || info?.dim || 1536;
      console.log("[E2E] expected vector dimension:", expectedDim);

      const docId = 999999;
      const items = [
        {
          id: `${docId}:v1`,
          embedding: Array.from({ length: expectedDim }, () => Math.random()),
          metadata: {
            documentId: docId,
            title: "E2E Test",
            category: "test",
            version: 1,
            offset: 0,
            nextOffset: null,
          },
          text: "sample text 1",
        },
        {
          id: `${docId}:v2`,
          embedding: Array.from({ length: expectedDim }, () => Math.random()),
          metadata: {
            documentId: docId,
            title: "E2E Test",
            category: "test",
            version: 1,
            offset: 100,
            nextOffset: null,
          },
          text: "sample text 2",
        },
      ];
      await vectorStore.upsertVectors(items);
      console.log("[E2E] upsertVectors done");
      const q = items[0].embedding;
      const search = await vectorStore.search(q, 5);
      console.log("[E2E] vector search:", JSON.stringify(search, null, 2));
      await vectorStore.deleteByDocumentId(docId);
      console.log("[E2E] deleted vectors by document id via vectorStore");
    } else {
      console.error("[E2E] No vector store enabled. Check configuration.");
      process.exit(2);
    }

    console.log("[E2E] Upstash E2E test completed successfully");
    process.exit(0);
  } catch (err) {
    console.error("[E2E] Upstash E2E test failed:", err?.message || err);
    process.exit(1);
  }
})();
