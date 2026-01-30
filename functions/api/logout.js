// functions/api/logout.js
import { jsonResponse, clearCookie } from "./_shared.js";

export async function onRequest() {
  return jsonResponse({ ok: true }, 200, { "set-cookie": clearCookie("sr_user") });
}
