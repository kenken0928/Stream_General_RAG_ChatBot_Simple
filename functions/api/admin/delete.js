// functions/api/admin/delete.js
import {
  readJson,
  jsonResponse,
  errorResponse,
  readAdminCookie,
  verifySignedToken,
  getR2Bucket,
} from "../_shared.js";

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return errorResponse("POST only", 405);

  // admin auth
  const c = readAdminCookie(request, env);
  if (!c.ok) return errorResponse("Not logged in (admin)", 401);
  const v = await verifySignedToken(env, c.token);
  if (!v.ok) return errorResponse(`Bad admin session: ${v.reason}`, 401);

  const body = await readJson(request);

  // target は "csv" or "config" のみ許可（任意キー削除を防止）
  const target = String(body.target || "");
  if (target !== "csv" && target !== "config") {
    return errorResponse('target must be "csv" or "config"', 400);
  }

  const bucket = getR2Bucket(env);
  if (!bucket) return errorResponse("R2 binding missing", 500);

  const csvKey = String(env.RAG_CSV_KEY || "rag.csv");
  const cfgKey = String(env.R2_CONFIG_KEY || "config.json");
  const key = target === "csv" ? csvKey : cfgKey;

  await bucket.delete(key);

  return jsonResponse({
    ok: true,
    deleted: { target, key },
  });
}
