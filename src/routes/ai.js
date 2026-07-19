/**
 * "Ask your books" — AI chat over the tenant's own data (Premium).
 *
 * The LLM (Groq, OpenAI-compatible API) never touches the database directly:
 * it can only call the whitelisted read-only tools in ai-tools.js, and every
 * tool runs with the tenant id taken from the JWT — never from model output.
 * A per-tenant daily request cap keeps API spend bounded.
 */
const express = require("express");
const db = require("../db");
const { auth, logAction } = require("../middleware");
const { TOOLS, runTool } = require("../ai-tools");

const router = express.Router();
router.use(auth);
// Paid add-on: only orgs the platform super admin has switched on may use AI
// (tenants.ai_enabled — see PATCH /platform/orgs/:id/ai). Tier is irrelevant.
router.use((req, res, next) => {
  if (!req.tenant?.ai_enabled)
    return res.status(403).json({ error: "ai_addon_disabled", message: "AI Assistant is not enabled for this organization." });
  next();
});

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const DAILY_LIMIT = Math.max(1, parseInt(process.env.AI_DAILY_LIMIT, 10) || 50);
const MAX_TOOL_ROUNDS = 6;

// Our tool schemas → OpenAI/Groq function-calling format.
const GROQ_TOOLS = TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

/**
 * Action intents (voice/typed commands like "add expense 500 for diesel").
 * The model only PROPOSES these; nothing is written server-side from model
 * output. The client shows a confirmation and then calls the normal
 * authenticated API (POST /expenses etc.) itself.
 */
const PAGES = ["sales", "purchases", "payments", "expenses", "reports", "inventory", "parties", "manufacturing", "accounting"];
const ACTION_TOOLS = [
  {
    type: "function",
    function: {
      name: "record_expense",
      description: "The user asks to add/record a business expense, e.g. 'add expense 500 for diesel' / '500 ka diesel likh do'. Extract the amount and a short category. The app will ask the user to confirm before saving.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Expense amount in rupees" },
          category: { type: "string", description: "Short expense category, e.g. Diesel, Rent, Tea, Labour" },
          note: { type: "string", description: "Optional extra detail" },
          account: { type: "string", enum: ["cash", "bank"], description: "Paid from cash (default) or bank" },
        },
        required: ["amount", "category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_new_bill",
      description: "The user wants to create a new sale invoice or purchase bill, e.g. 'create invoice for Ravi' / 'naya bill banao'. Opens the form (prefilled with the party if named) — nothing is saved yet.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["sale", "purchase"] },
          party: { type: "string", description: "Customer/supplier name if mentioned" },
        },
        required: ["kind"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_page",
      description: "The user explicitly asks to open/go to a section of the app. For DATA questions ('show pending payments', 'today's cash report') answer with the report tools instead of navigating.",
      parameters: { type: "object", properties: { page: { type: "string", enum: PAGES } }, required: ["page"] },
    },
  },
];
const ACTION_NAMES = new Set(ACTION_TOOLS.map((t) => t.function.name));

/** Validate a proposed action → {action} the client can render, or {error}. */
function validateAction(name, args) {
  if (name === "record_expense") {
    const amount = Math.round(Number(args.amount) * 100) / 100;
    const category = String(args.category || "").trim().slice(0, 40);
    if (!(amount > 0)) return { error: "amount is missing or not positive — ask the user for the amount" };
    if (!category) return { error: "category is missing — ask what the expense was for" };
    return {
      action: {
        type: "record_expense",
        params: {
          amount, category,
          account: args.account === "bank" ? "bank" : "cash",
          note: String(args.note || "").trim().slice(0, 200) || undefined,
        },
      },
    };
  }
  if (name === "open_new_bill") {
    return {
      action: {
        type: "open_new_bill",
        params: { kind: args.kind === "purchase" ? "purchase" : "sale", party: String(args.party || "").trim().slice(0, 60) || undefined },
      },
    };
  }
  if (name === "open_page") {
    if (!PAGES.includes(args.page)) return { error: `page must be one of: ${PAGES.join(", ")}` };
    return { action: { type: "open_page", params: { page: args.page } } };
  }
  return { error: `Unknown action: ${name}` };
}

const today = () => new Date().toISOString().slice(0, 10);
const usedToday = (tenantId) =>
  db.prepare("SELECT count FROM ai_usage WHERE tenant_id=? AND day=?").get(tenantId, today())?.count || 0;

function systemPrompt(tenant) {
  return `You are the Business Assistant inside LedgerFlow, an accounting & inventory app for Indian small businesses.
You are chatting with the owner/staff of "${tenant.name}". Today's date is ${today()}. Amounts are in ${tenant.base_currency || "INR"} — format them Indian style (e.g. ₹1,20,500).

Rules:
- Answer questions about THIS business using the tools; never invent numbers. If a tool returns no data, say so plainly.
- Pick sensible date ranges from phrases like "this month" or "last week" using today's date.
- Be brief and practical: lead with the number/answer, then 1-2 lines of context or advice. Use a short list or table only when comparing several things.
- Reply in the language the user writes in (English, Hindi or Hinglish).
- Commands: use record_expense when they ask to add an expense, open_new_bill when they want to create an invoice/bill, open_page only when they explicitly ask to open a section. The app confirms with the user before saving anything.
- For data questions ("show pending payments", "today's cash report") answer directly with the report tools — don't navigate.
- For anything else you cannot do (editing entries, payments entry, etc.), explain where in the app to do it.
- Politely decline questions unrelated to this business or its accounting.`;
}

async function callGroq(payload) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Groq API ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** GET /api/ai/status — is the assistant available, and how much quota is left. */
router.get("/status", (req, res) => {
  const used = usedToday(req.tenant.id);
  res.json({
    enabled: !!process.env.GROQ_API_KEY,
    limit: DAILY_LIMIT,
    used_today: used,
    remaining: Math.max(0, DAILY_LIMIT - used),
  });
});

/** POST /api/ai/chat — { messages: [{role:'user'|'assistant', content:string}] }
 *  Client sends the visible conversation; we add the system prompt and run the
 *  tool-calling loop server-side. Returns { reply, remaining }. */
router.post("/chat", async (req, res) => {
  const msgs = req.body?.messages;
  if (!Array.isArray(msgs) || msgs.length === 0 || msgs.length > 30)
    return res.status(400).json({ error: "messages must be a non-empty array (max 30)" });
  for (const m of msgs) {
    if ((m?.role !== "user" && m?.role !== "assistant") || typeof m?.content !== "string" || m.content.length > 4000)
      return res.status(400).json({ error: "Each message needs role user/assistant and text content (max 4000 chars)" });
  }
  if (msgs[msgs.length - 1].role !== "user")
    return res.status(400).json({ error: "Last message must be from the user" });

  const used = usedToday(req.tenant.id);
  if (used >= DAILY_LIMIT)
    return res.status(429).json({ error: `Daily AI limit reached (${DAILY_LIMIT} questions). Try again tomorrow.`, remaining: 0 });

  if (!process.env.GROQ_API_KEY)
    return res.status(503).json({ error: "AI assistant is not configured on this server." });

  db.prepare(
    `INSERT INTO ai_usage (tenant_id, day, count) VALUES (?,?,1)
     ON CONFLICT(tenant_id, day) DO UPDATE SET count = count + 1`
  ).run(req.tenant.id, today());

  const conversation = [
    { role: "system", content: systemPrompt(req.tenant) },
    ...msgs.map((m) => ({ role: m.role, content: m.content })),
  ];

  try {
    let reply = null;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const data = await callGroq({
        model: MODEL,
        messages: conversation,
        tools: [...GROQ_TOOLS, ...ACTION_TOOLS],
        tool_choice: round === MAX_TOOL_ROUNDS ? "none" : "auto", // force an answer on the last round
        temperature: 0.2,
        max_tokens: 1024,
      });
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error("Empty response from AI service");

      if (msg.tool_calls?.length) {
        // A valid action proposal ends the turn — the client takes over
        // (confirmation UI / navigation). Invalid proposals are fed back so the
        // model can ask the user for the missing piece.
        conversation.push(msg);
        for (const tc of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
          if (ACTION_NAMES.has(tc.function.name)) {
            const v = validateAction(tc.function.name, args);
            if (v.action) {
              logAction(req, "command", "ai_assistant", req.tenant.id);
              return res.json({
                action: v.action,
                reply: (msg.content || "").trim(),
                remaining: Math.max(0, DAILY_LIMIT - usedToday(req.tenant.id)),
              });
            }
            conversation.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: v.error }) });
            continue;
          }
          let result;
          try {
            result = runTool(req.tenant.id, tc.function.name, args);
          } catch (e) {
            result = { error: String(e.message || e) };
          }
          conversation.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
        }
        continue;
      }
      reply = (msg.content || "").trim();
      break;
    }
    if (!reply) throw new Error("AI service returned no answer");

    logAction(req, "query", "ai_assistant", req.tenant.id);
    res.json({ reply, remaining: Math.max(0, DAILY_LIMIT - usedToday(req.tenant.id)) });
  } catch (e) {
    console.error("AI chat failed:", e.message);
    const msg = e.status === 401
      ? "AI assistant is misconfigured (invalid API key)."
      : e.status === 429
        ? "The AI service is busy right now. Please try again in a minute."
        : "The AI assistant could not answer right now. Please try again.";
    res.status(502).json({ error: msg });
  }
});

module.exports = router;
