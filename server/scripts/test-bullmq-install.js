#!/usr/bin/env node
(async () => {
  try {
    const bull = await import("bullmq");
    const ioredis = await import("ioredis");
    console.log(
      "bullmq imported:",
      typeof bull.Queue === "function" ? "ok" : "loaded",
    );
    console.log(
      "ioredis imported:",
      typeof ioredis.default === "function" ? "ok" : "loaded",
    );
    console.log(
      "Modules available. To fully test bullmq you need a reachable Redis instance.",
    );
    process.exit(0);
  } catch (e) {
    console.error("Import failed:", e?.message || e);
    process.exit(2);
  }
})();
