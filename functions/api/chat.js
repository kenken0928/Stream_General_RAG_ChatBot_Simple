// functions/api/chat.js
import {
  readJson,
  jsonResponse,
  errorResponse,
  readSessionCookie,
  verifySignedToken,
  getR2Bucket,
} from "./_shared.js";

async function readTextFromR2(env, key) {
  const bucket = getR2Bucket(env);
  if (!bucket) throw new Error("R2 binding is missing (check Bindings variable name)");
  const obj = await bucket.get(key);
  if (!obj) return null;
  return await obj.text();
}

/**
 * =========================
 * RAG: Search helpers（改良版）
 * =========================
 * - 正規化強化（NFKC / 記号ゆらぎ吸収）
 * - 日本語向けキーワード抽出（形態素解析なし）
 * - 2文字bigramのJaccard類似（表記ゆらぎに強い）
 * - スコア0除外（ノイズ混入を減らす）
 */

function normalizeForSearch(s) {
  return (s || "")
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/\u3000/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[()（）「」『』【】［］\[\]{}<>＜＞]/g, " ")
    .replace(/[、。,.!?！？：:;；/\\|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractKeywordsJa(text) {
  const cleaned = normalizeForSearch(text);

  const parts = cleaned
    .split(/\s+/)
    .flatMap((w) => w.split(/の|が|は|を|に|へ|で|と|や|から|まで|です|ます/))
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);

  const seq = [];
  const re = /[一-龠々ぁ-んァ-ヶーa-zA-Z0-9]+/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const s = m[0].trim();
    if (s.length >= 2) seq.push(s);
  }

  const set = new Set();
  const out = [];
  for (const x of [...parts, ...seq]) {
    if (!set.has(x)) {
      set.add(x);
      out.push(x);
    }
  }

  out.sort((a, b) => b.length - a.length);
  return out.slice(0, 25);
}

function bigrams(s) {
  const t = normalizeForSearch(s);
  const arr = [];
  for (let i = 0; i < t.length - 1; i++) arr.push(t.slice(i, i + 2));
  return arr;
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function pickContextFromCsv(csvText, query, limit = 20) {
  const lines = (csvText || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  const qNorm = normalizeForSearch(query || "");
  const qLower = qNorm.toLowerCase();

  const keywords = extractKeywordsJa(qNorm);
  const qBigrams = bigrams(qNorm);

  const scored = lines
    .map((line) => {
      const lNorm = normalizeForSearch(line);
      const hay = lNorm.toLowerCase();
      let score = 0;

      // 1) 質問全文が含まれる（強い）
      if (qLower && hay.includes(qLower)) score += 10;

      // 2) キーワード一致（長い語ほど少し強く）
      for (const kw of keywords) {
        const k = kw.toLowerCase();
        if (!k) continue;
        if (hay.includes(k)) score += Math.min(12, 2 + Math.floor(kw.length / 2));
      }

      // 3) bigram類似（重みは控えめ）
      const sim = jaccard(qBigrams, bigrams(lNorm));
      score += sim * 12;

      return { line, score };
    })
    .sort((a, b) => b.score - a.score);

  // 4) スコア0は除外（ノイズ混入を減らす）
  const positive = scored.filter((x) => x.score > 0);

  // 5) 0件ならフォールバック（“何も出ない”事故を避ける）
  const chosen = (positive.length ? positive : scored).slice(
    0,
    Math.min(limit, scored.length)
  );

  return chosen.map((x) => x.line).join("\n");
}

/**
 * =========================
 * Config loader（R2のconfig.jsonを読む）
 * =========================
 */
async function loadConfig(env) {
  const cfgKey = String(env.R2_CONFIG_KEY || "config.json");
  const text = await readTextFromR2(env, cfgKey);

  if (!text) {
    // config.json が無い場合のデフォルト
    return {
      llm: {
        provider: String(env.LLM_PROVIDER || "openai"),
        openaiModel: "gpt-4o-mini",
        geminiModel: "gemini-1.5-flash",
      },
      prompt: {
        system:
          "あなたは社内ヘルプデスクです。根拠のない推測はせず、不明な場合は不明と言ってください。",
        rules: ["可能なら箇条書きで答える", "根拠となる行があれば言及する"],
      },
    };
  }

  try {
    const cfg = JSON.parse(text);
    const llm = cfg?.llm || {};
    const prompt = cfg?.prompt || {};
    return {
      llm: {
        provider: String(llm.provider || env.LLM_PROVIDER || "openai"),
        openaiModel: String(llm.openaiModel || "gpt-4o-mini"),
        geminiModel: String(llm.geminiModel || "gemini-1.5-flash"),
      },
      prompt: {
        system: String(
          prompt.system ||
            "あなたは社内ヘルプデスクです。根拠のない推測はせず、不明な場合は不明と言ってください。"
        ),
        rules: Array.isArray(prompt.rules) ? prompt.rules.map(String) : [],
      },
    };
  } catch {
    // JSONが壊れている場合の安全フォールバック
    return {
      llm: {
        provider: String(env.LLM_PROVIDER || "openai"),
        openaiModel: "gpt-4o-mini",
        geminiModel: "gemini-1.5-flash",
      },
      prompt: {
        system:
          "あなたは社内ヘルプデスクです。根拠のない推測はせず、不明な場合は不明と言ってください。",
        rules: ["可能なら箇条書きで答える", "根拠となる行があれば言及する"],
      },
    };
  }
}

/**
 * =========================
 * LLM callers
 * =========================
 */
function extractTextFromResponsesApi(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const chunks = [];
  for (const item of data?.output || []) {
    for (const c of item?.content || []) {
      if (typeof c?.text === "string") chunks.push(c.text);
      if (typeof c?.output_text === "string") chunks.push(c.output_text);
    }
  }
  return chunks.join("").trim();
}

async function callOpenAI(env, model, prompt) {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is missing");

  // Responses API（今のOpenAIの推奨寄り）
  const payload = {
    model,
    input: prompt,
    text: { format: { type: "text" } },
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status} / ${text}`);

  const data = JSON.parse(text);
  const out = extractTextFromResponsesApi(data);
  if (!out) throw new Error("OpenAI response text was empty.");
  return out;
}

async function callGemini(env, model, prompt) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(key)}`;

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini API error: ${res.status} / ${text}`);

  const data = JSON.parse(text);
  const out =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return out;
}

function buildPrompt({ system, rules, context, message }) {
  const rulesText =
    Array.isArray(rules) && rules.length
      ? rules.map((r) => `- ${String(r)}`).join("\n")
      : "- 不明なことは不明と言う\n- 可能なら箇条書きで";

  return [
    `# System`,
    system || "あなたは有能なアシスタントです。",
    ``,
    `# 参考情報（RAGから抽出した関連行）`,
    context || "（該当する行が見つかりませんでした）",
    ``,
    `# ユーザーの質問`,
    message,
    ``,
    `# 回答ルール`,
    rulesText,
  ].join("\n");
}

export async function onRequest({ request, env }) {
  try {
    if (request.method !== "POST") return errorResponse("POST only", 405);

    // auth
    const c = readSessionCookie(request, env);
    if (!c.ok) return errorResponse("Not logged in", 401);

    const v = await verifySignedToken(env, c.token);
    if (!v.ok) return errorResponse(`Bad session: ${v.reason}`, 401);

    const body = await readJson(request);
    const message = String(body?.message || "").trim();
    if (!message) return errorResponse("message is required", 400);

    // load config.json（管理画面の設定を反映）
    const cfg = await loadConfig(env);

    // load RAG CSV
    const csvKey = String(env.RAG_CSV_KEY || "rag.csv");
    const csvText = await readTextFromR2(env, csvKey);
    const context = csvText
      ? pickContextFromCsv(csvText, message, 20)
      : "(R2にrag.csvがありません)";

    const prompt = buildPrompt({
      system: cfg?.prompt?.system,
      rules: cfg?.prompt?.rules,
      context,
      message,
    });

    const provider = String(cfg?.llm?.provider || "openai").toLowerCase();
    let answer = "";

    if (provider === "gemini") {
      answer = await callGemini(env, cfg.llm.geminiModel, prompt);
    } else {
      answer = await callOpenAI(env, cfg.llm.openaiModel, prompt);
    }

    return jsonResponse({ ok: true, answer });
  } catch (e) {
    const detail = e && typeof e.message === "string" ? e.message : String(e);
    // DEBUG=1 のときだけ詳細を返す（運用で便利）
    const debugEnabled = String(env.DEBUG || "0") === "1";
    if (debugEnabled) return errorResponse(detail, 500);
    return errorResponse("Internal Server Error", 500);
  }
}
