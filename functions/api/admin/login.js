// functions/api/admin/login.js
import { readJson, jsonResponse, errorResponse, buildSetCookie, createSignedToken } from "../_shared.js";

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return errorResponse("POST only", 405);

  const body = await readJson(request);
  const id = String(body.id || "");
  const password = String(body.password || "");

  if (id !== String(env.ADMIN_ID || "") || password !== String(env.ADMIN_PASSWORD || "")) {
    return errorResponse("Invalid credentials", 401);
  }

  const ttl = Number(env.ADMIN_SESSION_TTL_SEC || 3600);
  const now = Math.floor(Date.now() / 1000);

  const token = await createSignedToken(env, {
    typ: "admin",
    id,
    iat: now,
    exp: now + ttl,
  });

  const setCookie = buildSetCookie("sr_admin", token, { maxAgeSec: ttl });

  return jsonResponse({ ok: true }, 200, { "set-cookie": setCookie });
}
