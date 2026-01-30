// functions/api/_shared.js
// 共通ユーティリティ（Cookie/署名/レスポンス/R2/KVレート制限）

// --- R2 binding helper ---
// Cloudflare Pages の Bindings で R2 bucket の Variable name を "R2_BUCKET" にしている前提
export function getR2Bucket(env) {
  return env?.R2_BUCKET || env?.["simple-rag-chat-bucket"] || null;
}

export function getMaintenance(env) {
  return String(env?.MAINTENANCE_MODE || "0") === "1";
}

// --- base64url ---
function toBase64Url(bytes) {
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// --- HMAC ---
async function hmacSign(secret, messageBytes) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, messageBytes);
  return new Uint8Array(sig);
}

async function hmacVerify(secret, messageBytes, sigBytes) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify("HMAC", key, sigBytes, messageBytes);
}

// --- signed token ---
export async function createSignedToken(env, payloadObj) {
  const secret = env.SESSION_SIGNING_SECRET;
  if (!secret) throw new Error("SESSION_SIGNING_SECRET is missing");

  const enc = new TextEncoder();
  const payloadJson = JSON.stringify(payloadObj);
  const payloadB64 = toBase64Url(enc.encode(payloadJson));
  const msgBytes = enc.encode(payloadB64);
  const sigBytes = await hmacSign(secret, msgBytes);
  const sigB64 = toBase64Url(sigBytes);
  return `${payloadB64}.${sigB64}`;
}

export async function verifySignedToken(env, token) {
  if (!token || typeof token !== "string") return { ok: false, reason: "no token" };
  const secret = env.SESSION_SIGNING_SECRET;
  if (!secret) return { ok: false, reason: "no secret" };

  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "bad format" };

  const [payloadB64, sigB64] = parts;
  const enc = new TextEncoder();
  const msgBytes = enc.encode(payloadB64);

  let sigBytes;
  try {
    sigBytes = fromBase64Url(sigB64);
  } catch {
    return { ok: false, reason: "bad sig b64" };
  }

  const valid = await hmacVerify(secret, msgBytes, sigBytes);
  if (!valid) return { ok: false, reason: "bad signature" };

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
  } catch {
    return { ok: false, reason: "bad payload" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) return { ok: false, reason: "expired", payload };

  return { ok: true, payload };
}

// --- cookies ---
function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  const out = {};
  for (const part of header.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf("=");
    if (i < 0) continue;
    const k = p.slice(0, i).trim();
    const v = decodeURIComponent(p.slice(i + 1));
    out[k] = v;
  }
  return out;
}

export function buildSetCookie(name, value, opts = {}) {
  const { maxAgeSec, path = "/", httpOnly = true, secure = true, sameSite = "Lax" } = opts;
  const pieces = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) pieces.push("HttpOnly");
  if (secure) pieces.push("Secure");
  if (typeof maxAgeSec === "number") pieces.push(`Max-Age=${maxAgeSec}`);
  return pieces.join("; ");
}

export function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`;
}

export function readSessionCookie(request, env) {
  const cookies = parseCookies(request);
  const token = cookies.sr_user;
  return { ok: !!token, token };
}

export function readAdminCookie(request, env) {
  const cookies = parseCookies(request);
  const token = cookies.sr_admin;
  return { ok: !!token, token };
}

// --- JSON helpers ---
export async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function jsonResponse(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(message, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

// =========================================================
// KV Rate Limit（env.RATELIMIT を使用）
// - Cloudflare KV は「厳密な原子インクリメント」ではないので、完全厳密ではないが実用上OK
// =========================================================
export async function rateLimitHit(env, key, limit, windowSec) {
  const kv = env?.RATELIMIT;
  if (!kv) {
    // KV未設定なら「制限なし」で動かす（本番では必ずBindingすること）
    return { ok: true, count: 0, limit, windowSec, note: "RATELIMIT binding missing" };
  }

  const now = Date.now();
  const namespacedKey = `rl:${key}:${windowSec}`;

  let cur = 0;
  try {
    const v = await kv.get(namespacedKey);
    cur = v ? Number(v) : 0;
    if (!Number.isFinite(cur)) cur = 0;
  } catch {
    cur = 0;
  }

  const next = cur + 1;

  // すでに超えているなら弾く
  if (next > limit) {
    return { ok: false, count: next, limit, windowSec };
  }

  // TTL付きで保存
  try {
    await kv.put(namespacedKey, String(next), { expirationTtl: windowSec });
  } catch {
    // KV書き込み失敗は「安全側に倒して弾く」でもいいが、運用上は通す方がマシなことが多い
    // ここは通す（必要なら false に変えてOK）
    return { ok: true, count: next, limit, windowSec, note: "KV put failed (allowed)" };
  }

  return { ok: true, count: next, limit, windowSec };
}
