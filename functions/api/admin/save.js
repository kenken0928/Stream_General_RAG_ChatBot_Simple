// functions/api/admin/save.js
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

  const c = readAdminCookie(request, env);
  if (!c.ok) return errorResponse("Not logged in (admin)", 401);
  const v = await verifySignedToken(env, c.token);
  if (!v.ok) return errorResponse(`Bad admin session: ${v.reason}`, 401);

  const body = await readJson(request);
  const csvText = typeof body.csv === "string" ? body.csv : null;
  const configText = typeof body.config === "string" ? body.config : null;

  const bucket = getR2Bucket(env);
  if (!bucket) return errorResponse("R2 binding missing", 500);

  const csvKey = String(env.RAG_CSV_KEY || "rag.csv");
  const cfgKey = String(env.R2_CONFIG_KEY || "config.json");

  const saved = { csv: false, config: false };

  if (csvText !== null) {
    await bucket.put(csvKey, csvText, { httpMetadata: { contentType: "text/csv; charset=utf-8" } });
    saved.csv = true;
  }
  if (configText !== null) {
    // JSONとして一応検証
    try {
      JSON.parse(configText);
    } catch (e) {
      return errorResponse(`config is not valid JSON: ${String(e)}`, 400);
    }
    await bucket.put(cfgKey, configText, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
    saved.config = true;
  }

  return jsonResponse({ ok: true, saved, keys: { csvKey, cfgKey } });
}
