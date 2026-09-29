import express from "express";
import { once } from "node:events";
import { initDb, findUserById } from "./src/db/index.js";
import { signToken } from "./src/middleware/auth.js";
import { errorHandler } from "./src/middleware/error.js";
import documentsRouter from "./src/routes/documents.js";

await initDb();
const app = express();
app.use("/api/documents", documentsRouter);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}/api/documents`;

const user = await findUserById(1);
const token = signToken(user);
const form = new FormData();
form.append("file", new Blob([Buffer.from("# 标题\n\n正文")]), "guide.md");
form.append("category", "技术文档");

const res = await fetch(`${base}/upload`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
console.log("status:", res.status);
console.log("body:", await res.text());
server.closeAllConnections();
server.close();
