#!/usr/bin/env node
import { initDb, createUser, createDocument } from "../src/db/index.js";
import backblaze from "../src/services/storage/backblaze.js";
import { enqueueIndexJob, indexQueue } from "../src/services/indexQueue.js";

async function main() {
  initDb();
  const user = createUser({
    name: "smoke",
    email: "smoke@local",
    password: "pwd",
  });
  const fileBuffer = Buffer.from(
    "# Smoke test\n\nThis is a test file for smoke testing.",
    "utf8",
  );

  if (
    process.env.B2_ACCOUNT_ID &&
    process.env.B2_APPLICATION_KEY &&
    process.env.B2_BUCKET_ID
  ) {
    console.log("Attempting Backblaze upload...");
    try {
      const res = await backblaze.upload(fileBuffer, "smoke-test.md");
      console.log("Backblaze upload result:", res);
    } catch (err) {
      console.error("Backblaze upload failed:", err?.message || err);
    }
  } else {
    console.log(
      "B2 credentials not configured; skipping Backblaze upload test.",
    );
  }

  const doc = createDocument(
    {
      title: "Smoke Doc",
      content: "Smoke content",
      category: "测试",
      tags: [],
      status: "published",
    },
    user,
  );
  console.log("Created document id:", doc.id);

  const job = enqueueIndexJob(doc.id, "smoke-test");
  console.log("Enqueued index job:", job ? job.jobId : null);

  if (indexQueue?.pump) {
    try {
      // try to run pending in-memory queue tasks if present
      await indexQueue.pump();
      console.log("Ran in-memory queue pump");
    } catch (e) {
      console.warn("pump() failed:", e?.message || e);
    }
  }

  console.log(
    "Queue stats:",
    typeof indexQueue.stats === "function"
      ? await indexQueue.stats()
      : indexQueue.stats,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
