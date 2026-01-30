// public/assets/app.js
export async function apiGet(path) {
  const res = await fetch(path, { credentials: "include" });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export async function apiPost(path, bodyObj) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj || {}),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export function $(id) {
  return document.getElementById(id);
}

export function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

/**
 * 既存の呼び出し（appendChat("You: ..."), appendChat("Bot: ...")）を壊さずに、
 * 見た目だけ「吹き出しUI」に変更する。
 *
 * - "You:" / "Bot:" のプレフィックスを検出して左右分け
 * - それ以外は system 扱い（中央/薄い表示）
 */
function parseChatLine(line) {
  const s = String(line ?? "").replace(/\r\n/g, "\n");

  // You: / Bot: の検出（全角コロンも許容）
  const m = s.match(/^\s*(You|Bot)\s*[:：]\s*/i);
  if (m) {
    const who = m[1].toLowerCase(); // you / bot
    const role = who === "you" ? "user" : "bot";
    const content = s.slice(m[0].length);
    return { role, content };
  }

  // 既存の "User:" / "Assistant:" にも一応対応（保険）
  const m2 = s.match(/^\s*(User|Assistant)\s*[:：]\s*/i);
  if (m2) {
    const who = m2[1].toLowerCase();
    const role = who === "user" ? "user" : "bot";
    const content = s.slice(m2[0].length);
    return { role, content };
  }

  return { role: "system", content: s };
}

function ensureChatboxMode(box) {
  // もし過去の実装で textContent にログが残っていたら、初回だけ簡易変換
  if (!box) return;
  if (box.dataset.mode === "bubbles") return;

  // 既存がテキストログなら、子要素化して変換
  const existing = (box.textContent || "").trim();
  box.textContent = "";
  box.dataset.mode = "bubbles";

  if (!existing) return;

  // 既存ログを行単位で変換（空行は無視）
  const lines = existing.split("\n").map((x) => x.trim()).filter(Boolean);
  for (const ln of lines) {
    const { role, content } = parseChatLine(ln);
    appendChatBubble(box, role, content);
  }
}

function appendChatBubble(box, role, content) {
  const row = document.createElement("div");
  row.className = `msg-row ${role}`;

  const bubble = document.createElement("div");
  bubble.className = `msg-bubble ${role}`;

  // 文章を保ちつつ、改行も表示できるように pre を使う
  const pre = document.createElement("pre");
  pre.className = "msg-text";
  pre.textContent = content;

  bubble.appendChild(pre);
  row.appendChild(bubble);
  box.appendChild(row);

  // スクロール最下部へ
  box.scrollTop = box.scrollHeight;
}

/**
 * 互換性のためシグネチャは維持：
 * appendChat("You: ...") / appendChat("Bot: ...") をそのまま使える
 */
export function appendChat(text) {
  const box = $("chatbox");
  if (!box) return;

  ensureChatboxMode(box);

  // appendChat は元々 1回呼ぶたびに改行追加だったので、
  // ここでは “1メッセージ=1吹き出し” として扱う。
  const { role, content } = parseChatLine(text);

  // 空は何もしない（ノイズ防止）
  const c = String(content ?? "").trimEnd();
  if (!c) return;

  appendChatBubble(box, role, c);
}
