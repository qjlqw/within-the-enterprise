import { config } from "../../config/index.js";

const B2_ACCOUNT_ID = process.env.B2_ACCOUNT_ID || process.env.B2_KEY_ID || "";
const B2_APPLICATION_KEY =
  process.env.B2_APPLICATION_KEY || process.env.B2_APPLICATION_KEY || "";
const B2_BUCKET_ID = process.env.B2_BUCKET_ID || "";
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME || "";

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
    const text = await res.text().catch(() => "");
    throw new Error(`b2_authorize_account failed: ${res.status} ${text}`);
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
    const text = await res.text().catch(() => "");
    throw new Error(`b2_get_upload_url failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function upload(buffer, filename) {
  const authInfo = await authorize();
  const { apiUrl, authorizationToken, downloadUrl } = authInfo;
  const uploadInfo = await getUploadUrl(apiUrl, authorizationToken);
  const { uploadUrl, uploadAuthToken } = uploadInfo;

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: uploadAuthToken,
      "X-Bz-File-Name": encodeURIComponent(filename),
      "Content-Type": "application/octet-stream",
      "X-Bz-Content-Sha1": "do_not_verify",
    },
    body: buffer,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`b2_upload_file failed: ${res.status} ${text}`);
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
    const text = await res.text().catch(() => "");
    throw new Error(`b2_delete_file_version failed: ${res.status} ${text}`);
  }
  return res.json();
}

export default {
  upload,
  deleteFileVersion,
};
