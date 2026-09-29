import "./src/config/index.js";
import { initDb, findUserById } from "./src/db/index.js";

await initDb();
for (const id of [1, 2, 3]) {
  const u = await findUserById(id);
  console.log(`user ${id}:`, u ? `${u.name} roles=${JSON.stringify(u.roles)}` : null);
}
