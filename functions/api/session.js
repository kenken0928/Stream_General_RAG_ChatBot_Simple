// functions/api/session.js
import { jsonResponse, verifySignedToken, readSessionCookie } from "./_shared.js";

export async function onRequest({ request, env }) {
  const c = readSessionCookie(request, env);
  if (!c.ok) return jsonResponse({ ok: true, loggedIn: false });

  const v = await verifySignedToken(env, c.token);
  if (!v.ok) return jsonResponse({ ok: true, loggedIn: false, reason: v.reason });

  return jsonResponse({ ok: true, loggedIn: true, payload: v.payload });
}
