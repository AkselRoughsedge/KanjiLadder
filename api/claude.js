// POST /api/claude — the app's only route to Claude. Keeps ANTHROPIC_API_KEY on the server and only
// answers signed-in users whose email is listed in ALLOWED_EMAILS.
//
// Body: { messages: [{ role: "user" | "assistant", content: string }], max_tokens?: number }
// Reply: { text: string, stop_reason: string }

export const config = { maxDuration: 60 };

const SUPABASE_URL = "https://qrhlnlxohhsbkpdqygvn.supabase.co";
const SUPABASE_KEY = "sb_publishable_SWa7x_xCLtYE96bR7hFOVw_zN9L6j9i";
const MAX_CHARS = 120000;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });

  // 1. Who is asking? Verify the Supabase session token.
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ") || auth.length < 20) return send(res, 401, { error: "Sign in first" });
  const who = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SUPABASE_KEY, authorization: auth } });
  if (!who.ok) return send(res, 401, { error: "Your sign-in has expired" });
  const user = await who.json();

  // 2. Only listed accounts may spend the API key.
  const allowed = (process.env.ALLOWED_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length || !allowed.includes(String(user.email || "").toLowerCase())) return send(res, 403, { error: "This account isn't allowed to use Claude features" });
  if (!process.env.ANTHROPIC_API_KEY) return send(res, 500, { error: "ANTHROPIC_API_KEY is not set in Vercel" });

  // 3. Validate the request.
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: "Body must be JSON" }); }
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length || messages.length > 40) return send(res, 400, { error: "messages must be a non-empty list" });
  let chars = 0;
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content) return send(res, 400, { error: "Each message needs a role and text" });
    chars += m.content.length;
  }
  if (chars > MAX_CHARS) return send(res, 413, { error: "Request too long" });
  if (messages[0].role !== "user" || messages[messages.length - 1].role !== "user") return send(res, 400, { error: "Messages must start and end with the user" });
  const maxTokens = Math.max(64, Math.min(Number(body.max_tokens) || 1500, 8000));

  // 4. Ask Claude.
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5", max_tokens: maxTokens, messages }),
    });
  } catch (e) {
    return send(res, 502, { error: "Couldn't reach Claude" });
  }
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 400);
    return send(res, r.status === 429 || r.status === 529 ? 429 : 502, { error: "Claude request failed", detail });
  }
  const j = await r.json();
  const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  return send(res, 200, { text, stop_reason: j.stop_reason });
}
