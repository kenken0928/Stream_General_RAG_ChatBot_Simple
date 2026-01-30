// functions/api/admin/preview.js
import { jsonResponse, errorResponse, readAdminCookie, verifySignedToken, getR2Bucket } from "../_shared.js";

export async function onRequest({ request, env }) {
  const c = readAdminCookie(request, env);
  if (!c.ok) return errorResponse("Not logged in (admin)", 401);
  const v = await verifySignedToken(env, c.token);
  if (!v.ok) return errorResponse(`Bad admin session: ${v.reason}`, 401);

  const bucket = getR2Bucket(env);
  if (!bucket) return errorResponse("R2 binding missing", 500);

  const csvKey = String(env.RAG_CSV_KEY || "rag.csv");
  const cfgKey = String(env.R2_CONFIG_KEY || "config.json");

  const csvObj = await bucket.get(csvKey);
  const cfgObj = await bucket.get(cfgKey);

  const csvText = csvObj ? await csvObj.text() : null;
  const cfgText = cfgObj ? await cfgObj.text() : null;

  return jsonResponse({
    ok: true,
    keys: { csvKey, cfgKey },
    csv: csvText ? csvText.split(/\r?\n/).slice(0, 50).join("\n") : null,
    config: cfgText,
  });
}
