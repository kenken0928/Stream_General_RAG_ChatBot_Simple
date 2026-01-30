// functions/api/login.js
import { readJson, jsonResponse, errorResponse, buildSetCookie, createSignedToken } from "./_shared.js";

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return errorResponse("POST only", 405);

  const body = await readJson(request);
  const user = String(body.user || "");
  const password = String(body.password || "");

  if (user !== String(env.LOGIN_USER || "") || password !== String(env.LOGIN_PASSWORD || "")) {
    return errorResponse("Invalid credentials", 401);
  }

  const ttl = Number(env.SESSION_MAX_AGE_SEC || 86400);
  const now = Math.floor(Date.now() / 1000);

  const token = await createSignedToken(env, {
    typ: "user",
    user,
    iat: now,
    exp: now + ttl,
  });

  const setCookie = buildSetCookie("sr_user", token, { maxAgeSec: ttl });

  return jsonResponse(
    { ok: true },
    200,
    { "set-cookie": setCookie }
  );
}
