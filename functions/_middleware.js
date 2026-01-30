// functions/_middleware.js
// 認証ガード + レート制限 + 保守モード（Pages Functions middleware）

import {
  getMaintenance,
  jsonResponse,
  verifySignedToken,
  readSessionCookie,
  readAdminCookie,
  rateLimitHit,
} from "./api/_shared.js";

function num(env, name, def) {
  const v = env?.[name];
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function getClientIp(request) {
  // Cloudflare 環境なら通常これが入る
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

function isPath(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
}

async function requireUserAuth({ request, env }) {
  const c = readSessionCookie(request, env);
  if (!c.ok) return { ok: false };
  const v = await verifySignedToken(env, c.token);
  if (!v.ok) return { ok: false };
  if (v.payload?.typ !== "user" || !v.payload?.user) return { ok: false };
  return { ok: true, payload: v.payload };
}

async function requireAdminAuth({ request, env }) {
  const c = readAdminCookie(request, env);
  if (!c.ok) return { ok: false };
  const v = await verifySignedToken(env, c.token);
  if (!v.ok) return { ok: false };
  if (v.payload?.typ !== "admin" || !v.payload?.id) return { ok: false };
  return { ok: true, payload: v.payload };
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // ---- 保守モード ----
  // ログイン系と静的ファイルは通す（必要なら調整）
  if (getMaintenance(env)) {
    const allow =
      isPath(path, "/") ||
      isPath(path, "/login") ||
      isPath(path, "/admin/login") ||
      isPath(path, "/assets") ||
      isPath(path, "/api/login") ||
      isPath(path, "/api/logout") ||
      isPath(path, "/api/admin/login") ||
      isPath(path, "/api/admin/logout");
    if (!allow) {
      return new Response(
        `<html><body style="font-family: sans-serif; padding: 24px;">
          <h2>メンテナンス中</h2>
          <p>しばらくしてからアクセスしてください。</p>
        </body></html>`,
        { status: 503, headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
  }

  // =========================================================
  // ① ページ(HTML)の認証ガード：ここが無いと「画面だけ見える」事故が起きる
  // =========================================================
  if (isPath(path, "/chat")) {
    const a = await requireUserAuth({ request, env });
    if (!a.ok) {
      url.pathname = "/login/";
      return Response.redirect(url.toString(), 302);
    }
  }

  if (isPath(path, "/admin")) {
    // /admin/login は誰でもOK
    if (!isPath(path, "/admin/login")) {
      const a = await requireAdminAuth({ request, env });
      if (!a.ok) {
        url.pathname = "/admin/login/";
        return Response.redirect(url.toString(), 302);
      }
    }
  }

  // =========================================================
  // ② API の認証 + レート制限
  // =========================================================

  // ---- chat API（一般ユーザー）----
  if (isPath(path, "/api/chat")) {
    const a = await requireUserAuth({ request, env });
    if (!a.ok) return jsonResponse({ ok: false, error: "Not logged in" }, 401);

    const user = String(a.payload.user);
    const ip = getClientIp(request);

    // デフォルト値（あなたが指定した数値）
    const USER_5M_LIMIT = num(env, "CHAT_USER_5M_LIMIT", 30);
    const USER_DAY_LIMIT = num(env, "CHAT_USER_DAY_LIMIT", 200);
    const IP_5M_LIMIT = num(env, "CHAT_IP_5M_LIMIT", 60);
    const IP_DAY_LIMIT = num(env, "CHAT_IP_DAY_LIMIT", 500);

    // 5分
    {
      const r1 = await rateLimitHit(env, `chat:u:${user}`, USER_5M_LIMIT, 300);
      if (!r1.ok) return jsonResponse({ ok: false, error: "Rate limit (user/5m)" }, 429);

      const r2 = await rateLimitHit(env, `chat:ip:${ip}`, IP_5M_LIMIT, 300);
      if (!r2.ok) return jsonResponse({ ok: false, error: "Rate limit (ip/5m)" }, 429);
    }

    // 24時間
    {
      const r3 = await rateLimitHit(env, `chat:u:${user}:day`, USER_DAY_LIMIT, 86400);
      if (!r3.ok) return jsonResponse({ ok: false, error: "Rate limit (user/day)" }, 429);

      const r4 = await rateLimitHit(env, `chat:ip:${ip}:day`, IP_DAY_LIMIT, 86400);
      if (!r4.ok) return jsonResponse({ ok: false, error: "Rate limit (ip/day)" }, 429);
    }
  }

  // ---- admin API（管理画面）----
  if (isPath(path, "/api/admin")) {
    // login/logout/sessionは誰でも（ただしsessionはcookieで判定される）
    const open =
      isPath(path, "/api/admin/login") ||
      isPath(path, "/api/admin/logout") ||
      isPath(path, "/api/admin/session");
    if (!open) {
      const a = await requireAdminAuth({ request, env });
      if (!a.ok) return jsonResponse({ ok: false, error: "Not logged in (admin)" }, 401);

      const id = String(a.payload.id);

      const WRITE_1M_LIMIT = num(env, "ADMIN_WRITE_1M_LIMIT", 10);
      const WRITE_DAY_LIMIT = num(env, "ADMIN_WRITE_DAY_LIMIT", 50);
      const PREVIEW_1M_LIMIT = num(env, "ADMIN_PREVIEW_1M_LIMIT", 30);

      // preview：少し緩め（30回/1分）
      if (isPath(path, "/api/admin/preview")) {
        const r = await rateLimitHit(env, `admin_preview:u:${id}`, PREVIEW_1M_LIMIT, 60);
        if (!r.ok) return jsonResponse({ ok: false, error: "Rate limit (admin_preview)" }, 429);
      }

      // save/delete：書き込み系（10回/1分、50回/24h）
      if (isPath(path, "/api/admin/save") || isPath(path, "/api/admin/delete")) {
        const r1 = await rateLimitHit(env, `admin_write:u:${id}`, WRITE_1M_LIMIT, 60);
        if (!r1.ok) return jsonResponse({ ok: false, error: "Rate limit (admin_write/1m)" }, 429);

        const r2 = await rateLimitHit(env, `admin_write:u:${id}:day`, WRITE_DAY_LIMIT, 86400);
        if (!r2.ok) return jsonResponse({ ok: false, error: "Rate limit (admin_write/day)" }, 429);
      }
    }
  }

  return next();
}




