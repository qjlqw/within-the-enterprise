/**
 * Supabase 后端适配器
 * 使用 @supabase/supabase-js 通过 service_role key 在后端读写表
 */
let client = null;
let connected = false;

function ensureEnv() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_KEY not set");
  }
}

export async function connect() {
  if (connected && client) return client;
  ensureEnv();
  try {
    const { createClient } = await import("@supabase/supabase-js");
    client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      {
        auth: { persistSession: false },
      },
    );
    // 简单请求确认连接
    await client.rpc("pg_sleep", { i: 0 }).catch(() => {}); // no-op, just test availability
    connected = true;
    return client;
  } catch (e) {
    connected = false;
    throw e;
  }
}

export function isConnected() {
  return connected && !!client;
}

export async function insertDocument(doc) {
  if (!client) await connect();
  // 假设表名为 documents，字段与内存对象一致：id, title, content, author_id, author_name, category, tags, status, version, created_at, updated_at
  const record = {
    id: doc.id,
    title: doc.title,
    content: doc.content,
    author_id: doc.authorId,
    author_name: doc.authorName,
    category: doc.category,
    tags: doc.tags || [],
    status: doc.status,
    version: doc.version,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  };
  const { data, error } = await client
    .from("documents")
    .upsert(record)
    .select("id");
  if (error) throw error;
  return data;
}

export async function deleteDocumentById(id) {
  if (!client) await connect();
  const { data, error } = await client
    .from("documents")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) throw error;
  return data;
}

export default {
  connect,
  isConnected,
  insertDocument,
  deleteDocumentById,
};
