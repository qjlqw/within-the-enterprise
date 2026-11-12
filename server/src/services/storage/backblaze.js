import { createHash } from "node:crypto";
import { config } from "../../config/index.js";

const B2_ACCOUNT_ID = process.env.B2_ACCOUNT_ID || process.env.B2_KEY_ID || "";
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY || "";
const B2_BUCKET_ID = process.env.B2_BUCKET_ID || "";
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME || "";

/**
 * 处理 B2 上游失败：错误 message 只带状态码，不拼接响应体（避免把上游
 * 内部信息泄露给调用方/客户端）；原始响应体截断 200 字符进日志保留排查能力。
 */
async function throwB2Error(op, res) {
  const text = await res.text().catch(() => "");
  console.error(`${op} failed: ${res.status} ${text.slice(0, 200)}`);
  throw new Error(`${op} failed: ${res.status}`);
}

async function authorize() {
  if (!B2_ACCOUNT_ID || !B2_APPLICATION_KEY) {
    throw new Error(
      "Backblaze B2 credentials not configured (B2_ACCOUNT_ID / B2_APPLICATION_KEY)",
    );
  }
  const auth = Buffer.from(`${B2_ACCOUNT_ID}:${B2_APPLICATION_KEY}`).toString(
    "base64",
  );
  const res = await fetch(
    "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
    {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
      },
    },
  );
  if (!res.ok) {
    await throwB2Error("b2_authorize_account", res);
  }
  return res.json();
}

async function getUploadUrl(apiUrl, authToken) {
  if (!B2_BUCKET_ID) throw new Error("B2_BUCKET_ID is not set");
  const res = await fetch(`${apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: "POST",
    headers: {
      Authorization: authToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bucketId: B2_BUCKET_ID }),
  });
  if (!res.ok) {
    await throwB2Error("b2_get_upload_url", res);
  }
  return res.json();
}

async function upload(buffer, filename) {
  const authInfo = await authorize();
  const { apiUrl, authorizationToken, downloadUrl } = authInfo;
  const uploadInfo = await getUploadUrl(apiUrl, authorizationToken);
  // b2_get_upload_url 返回的字段名是 authorizationToken，而非 uploadAuthToken
  const { uploadUrl, authorizationToken: uploadAuthToken } = uploadInfo;

  // 本地计算真实 SHA1 交给 B2 校验，保证上传内容完整性（不再使用 do_not_verify）
  const sha1 = createHash("sha1").update(buffer).digest("hex");
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: uploadAuthToken,
      "X-Bz-File-Name": encodeURIComponent(filename),
      "Content-Type": "application/octet-stream",
      "X-Bz-Content-Sha1": sha1,
    },
    body: buffer,
  });

  if (!res.ok) {
    await throwB2Error("b2_upload_file", res);
  }
  const data = await res.json();
  const fileId = data.fileId;
  const fileName = data.fileName;
  // best-effort public URL if bucket name and downloadUrl provided
  const url =
    B2_BUCKET_NAME && downloadUrl
      ? `${downloadUrl}/file/${B2_BUCKET_NAME}/${encodeURIComponent(fileName)}`
      : null;
  return { fileId, fileName, url, raw: data };
}

async function deleteFileVersion(fileId, fileName) {
  const authInfo = await authorize();
  const { apiUrl, authorizationToken } = authInfo;
  const res = await fetch(`${apiUrl}/b2api/v2/b2_delete_file_version`, {
    method: "POST",
    headers: {
      Authorization: authorizationToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fileName, fileId }),
  });
  if (!res.ok) {
    await throwB2Error("b2_delete_file_version", res);
  }
  return res.json();
}

export default {
  upload,
  deleteFileVersion,
};
