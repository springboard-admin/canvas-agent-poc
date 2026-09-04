// Agent endpoint (Phase 1).
// Frontend POSTs { messages: [...transcript], energy } — memory is client-side.
// We inject real Canvas module data + a server-computed progress read, then let
// Haiku act as a calm, state-aware study coach that returns a small JSON shape:
//   { say, intent, nextAction, plan, special, celebrate }
// Progress numbers are authoritative from the server, never invented by the model.
import { env, readState, parseCookies } from "../lib/lti.js";
import { getModules, findSpecialItems } from "../lib/canvas.js";
import { getPhaseProgress, getDashboardHealth } from "../lib/myprogress.js";

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  try {
    const cookies = parseCookies(req);
    let ctx = null;
    if (cookies.sa_session) {
      try {
        ctx = (await readState(cookies.sa_session)).ctx;
      } catch {
        /* anonymous demo */
      }
    }

    const {
      messages = [],
      energy = null,
      mode = "chat",
      signals = {},
    } = req.body || {};
    const courseId = ctx?.courseId || env("CANVAS_COURSE_ID", "");
    if (!courseId) {
      res.status(400).json({ error: "No course context. Launch from Canvas." });
      return;
    }
    const studentId = ctx?.userId;

    const modules = await getModules(courseId, studentId);
    const special = findSpecialItems(modules);

    // Single source of truth = the My Progress app (exactly what the student sees on
    // screen). Both readers degrade to null; we never re-derive progress locally, so the
    // agent can never contradict the dashboard. If both are blind → honest-blind.
    const [phase, health] = await Promise.all([
      getPhaseProgress(courseId, studentId).catch(() => null),
      getDashboardHealth(courseId, studentId).catch(() => null),
    ]);
    const progressUnavailable = !(phase && phase.configured) && !health;

    const daysAway =
      typeof signals.daysAway === "number" ? signals.daysAway : null;

    let agent;
    if (process.env.ANTHROPIC_API_KEY) {
      // Triage real user turns (never the opening) for emotional routing.
      const label = mode === "greeting" ? "coach" : await triage(messages);
      if (label === "crisis") {
        agent = crisisHandoff();
      } else {
        agent = await runCoach({ messages, energy, mode, daysAway, phase, health, progressUnavailable, special, ctx, distress: label === "distress" });
      }
    } else {
      agent = fallbackCoach({ messages, phase, health, progressUnavailable, special });
    }

    // Status card for the UI: one cell per phase (what the student sees), plus headline.
    const weeks = phase && phase.configured ? phase.phaseMap : null;
    const progress =
      phase && phase.configured
        ? { phasesDone: phase.phasesDone, totalPhases: phase.totalPhases, currentPhaseName: phase.currentPhaseName, journeyComplete: phase.journeyComplete }
        : null;

    res.status(200).json({ progress, weeks, health, ...agent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

const SYSTEM = `You are a warm, calm study coach living on a student's course home page.
Your entire job: make the next step feel small, obvious, and do-able — so a tired,
busy, procrastinating learner keeps making finite progress every week and, almost
without noticing, finishes the course.

STYLE — HIGH SIGNAL, FEW WORDS (this matters most):
- "say" is at most 1-2 short sentences. Often one is better. Cut every word that
  isn't pulling weight. Aim for ~20 words, never more than ~35.
- Warm and human, but spare. No preamble ("Good question", "Honestly"), no hedging,
  no lists inside say, no repeating what they asked. Lead with the point.
- Frame progress, not deficit. If behind, say how CLOSE they are — briefly.
- One clear next action; extras go in "plan". The card carries the detail, so "say"
  should NOT re-list items or minutes.
- A nudge, if any, is 3-5 words ("Start it now?").

DON'T PUSH A TASK TOO EARLY (important):
- Do NOT hand out a task on the opening or in the first exchange unless the student
  explicitly asks for something to do or gives a time budget ("I have 15 min").
- Open by connecting: a warm, personal hook + a light question that gets them talking
  and lets you read their mood/energy from their reply. Gauge energy INDIRECTLY from
  what they say — never ask "how's your energy" outright.
- Let a suggestion emerge naturally after a couple of turns, once it feels earned.
  When you do suggest, keep it to ONE small thing.
- If nudgeAllowed is false in the data, keep nextAction and plan null and just converse.

STATE-AWARE SIZING (infer energy from their words; no explicit energy question):
- low energy: pick the smallest, most passive win (a short read/video), ~5-10 min,
  just to keep momentum. Reassure that small counts.
- ok/medium: a normal 15-30 min plan.
- high/motivated: point at the hardest / most overdue / highest-leverage item.
- Never let a session end empty-handed: always at least one finishable item.

CONVERSATION:
- If they ask a question (e.g. "why did you pick that?", "how am I doing?"),
  ANSWER it naturally in "say". Do NOT force a plan when they just want to talk.
- Only set intent "plan" when they want something to do / gave a time budget.
- Set intent "status" when they ask how they're doing.
- Otherwise intent "chat".

PROGRESS — SINGLE SOURCE OF TRUTH (this is what the student sees in "My Progress"):
- All progress + health comes ONLY from the provided data. NEVER invent or estimate a
  number. Speak the SAME numbers the student sees on their screen — a contradiction
  breaks trust.
- "progress" = phase journey: phasesDone / totalPhases, currentPhaseName, journeyComplete.
  "How am I doing" answers from this plus "health".
- "health" = overallHealth (0-100), consistencyScore, overdueCount, upcomingCount,
  weeklyTrend (improving/steady/slipping). Use these to read how they're really doing.
- If "progressUnavailable" is true, you CANNOT see their progress right now: say so
  plainly, don't invent numbers, and keep the conversation going warmly.
- When you recommend a task (and nudgeAllowed), drive the FOCUS phase:
  * focus.items are the not-yet-passed items of the active phase. Prefer an item with
    isPage true (a reading) FIRST, framed as "read this, then the graded item"; otherwise
    the first focus item.
  * nextAction = that item (title + url). Never invent items — only use focus.items urls.

SPECIAL ITEMS: only mention resume/booking/coaching items if they exist in the
provided list AND are relevant to what the student said or asked. Never invent them.

TIME: only give a minutes estimate if you're confident; otherwise omit minutes. Always
phrase any estimate as approximate ("~10 min").

OPENING GREETING (when told this is the opening): the student just landed and hasn't
said anything. Do NOT give them a task or a plan. Open with ONE short, warm,
personalized line + a light, genuine question that invites them to reply — so they
start a conversation and you can read how they're doing. Use the signals for warmth,
not pressure:
- daysAway large (>=3): "welcome back", zero guilt, glad they're here.
- behind (low health / overdue): stay encouraging and low-pressure; make it feel okay to
  be here.
- on track (healthy): warm reinforcement.
Set intent "chat", nextAction null, plan null. Keep it under ~25 words.

CELEBRATION: if journeyComplete is true, warmly acknowledge they've finished — keep it
understated and genuine.

Return STRICT JSON only, no prose outside it:
{
  "say": "your conversational message (always present, 1-3 short sentences)",
  "intent": "chat" | "status" | "plan",
  "nextAction": { "title": "...", "url": "...", "minutes": 10, "why": "one short reason" } | null,
  "plan": [ { "title": "...", "url": "...", "minutes": 10, "why": "..." } ] | null,
  "special": { "kind": "resume"|"booking", "title": "...", "url": "...", "note": "one line" } | null,
  "celebrate": false
}
nextAction/plan titles and urls MUST come from the provided focus.items. Never invent items or numbers.`;

async function runCoach({ messages, energy, mode, daysAway, phase, health, progressUnavailable, special, ctx, distress = false }) {
  const model = env("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001");
  const nudgeAllowed = mode !== "greeting" && !distress && allowNudge(messages);
  const celebrate = !!(phase && phase.configured && phase.journeyComplete);
  const grounding = {
    student: ctx?.givenName || ctx?.name || "there",
    energySignal: energy,
    nudgeAllowed,
    daysAway,
    distressSignal: distress,
    progressUnavailable: !!progressUnavailable,
    progress:
      phase && phase.configured
        ? {
            phasesDone: phase.phasesDone,
            totalPhases: phase.totalPhases,
            currentPhaseName: phase.currentPhaseName,
            journeyComplete: phase.journeyComplete,
          }
        : null,
    focus: phase && phase.configured ? phase.focus : null,
    health: health || null,
    specialItems: special,
  };

  const convo = (messages || [])
    .filter((m) => m && m.role && m.content)
    .slice(-12)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) }));

  // Prepend the grounding as the first user turn so the model has live data.
  const anthropicMessages = [
    { role: "user", content: `LIVE COURSE DATA (authoritative, use these numbers):\n${JSON.stringify(grounding)}` },
    ...convo,
  ];
  if (mode === "greeting") {
    anthropicMessages.push({
      role: "user",
      content: "This is the OPENING — the student just landed and hasn't asked anything. Follow the OPENING GREETING rules: a warm personalized hook + a light question. No task, no plan.",
    });
  }
  if (distress) {
    anthropicMessages.push({
      role: "user",
      content: "The student sounds emotionally low or overwhelmed. Lead with warmth and genuine acknowledgement. Do NOT offer a task, plan, or next step this turn — just be human and invite them to say more. Set intent 'chat', nextAction and plan null.",
    });
  }

  // Structured output via a forced tool call — the model's reply is schema-valid JSON,
  // not prose we have to fish out. Retry once on failure; never fail silently.
  let parsed = null;
  try {
    parsed = await callStructured({ model, system: SYSTEM, messages: anthropicMessages, tool: COACH_TOOL });
  } catch (e) {
    console.error("coach call failed:", e.message);
  }
  if (!parsed) {
    try {
      parsed = await callStructured({
        model,
        system: SYSTEM,
        messages: [...anthropicMessages, { role: "user", content: "Reply again by calling the respond tool with valid fields." }],
        tool: COACH_TOOL,
      });
    } catch (e) {
      console.error("coach retry failed:", e.message);
    }
  }
  if (!parsed) {
    // Honest last resort — never the old cheerful filler masquerading as a real reply.
    return {
      source: "error",
      say: "I hit a snag on my end just now — mind saying that again?",
      intent: "chat",
      nextAction: null,
      plan: null,
      special: null,
      celebrate,
    };
  }

  const out = normalize(parsed, celebrate);
  // Hard gate: never surface a task before it's earned, while distressed, or while we
  // can't see the student's progress (no item to honestly recommend).
  if (distress || !nudgeAllowed || progressUnavailable) {
    out.nextAction = null;
    out.plan = null;
    if (out.intent === "plan") out.intent = "chat";
  }
  return { source: "claude", ...out };
}

// ---- structured model calls ---------------------------------------------------

// One Anthropic call that returns schema-valid JSON via a forced tool. The tool_use
// input IS the structured object — no prose-parsing, no silent-fallback risk.
async function callStructured({ model, system, messages, tool, maxTokens = 600 }) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Anthropic ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  const block = (data.content || []).find((c) => c.type === "tool_use");
  return block ? block.input : null;
}

const ACTION_SHAPE = {
  type: "object",
  properties: {
    title: { type: "string" },
    url: { type: "string" },
    minutes: { type: "number" },
    why: { type: "string" },
  },
};

const COACH_TOOL = {
  name: "respond",
  description: "Reply to the student. Always call this tool with your message.",
  input_schema: {
    type: "object",
    properties: {
      say: { type: "string", description: "1-3 short warm sentences." },
      intent: { type: "string", enum: ["chat", "status", "plan"] },
      nextAction: ACTION_SHAPE,
      plan: { type: "array", items: ACTION_SHAPE },
      special: {
        type: "object",
        properties: {
          kind: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          note: { type: "string" },
        },
      },
      celebrate: { type: "boolean" },
    },
    required: ["say", "intent"],
  },
};

const TRIAGE_TOOL = {
  name: "classify",
  description: "Classify the student's latest message.",
  input_schema: {
    type: "object",
    properties: {
      label: { type: "string", enum: ["coach", "status", "distress", "crisis"] },
    },
    required: ["label"],
  },
};

const TRIAGE_SYSTEM = `Classify the student's latest message into exactly one label:
- crisis: self-harm, suicide, abuse, a medical or mental-health emergency, or acute distress needing a human now.
- distress: struggling, overwhelmed, discouraged, "life is hard", burned out, low motivation — emotional but not an emergency.
- status: asking how they're doing / their progress / where they stand.
- coach: anything else — wants a task, a course question, or casual chat.
When torn between distress and coach, choose distress. When torn between crisis and distress, choose crisis.`;

// Cheap classifier on the latest user turn. Fail-safe: any error → "coach" (never block).
async function triage(messages) {
  const users = (messages || []).filter((m) => m && m.role === "user");
  const last = users[users.length - 1]?.content;
  if (!last) return "coach";
  const model = env("ANTHROPIC_TRIAGE_MODEL", "claude-haiku-4-5");
  try {
    const out = await callStructured({
      model,
      system: TRIAGE_SYSTEM,
      messages: [{ role: "user", content: String(last).slice(0, 2000) }],
      tool: TRIAGE_TOOL,
      maxTokens: 50,
    });
    const label = out?.label;
    return ["coach", "status", "distress", "crisis"].includes(label) ? label : "coach";
  } catch (e) {
    console.error("triage failed:", e.message);
    return "coach";
  }
}

// Static, config-driven safe handoff for a crisis signal. No model call. Wording is a
// safe default until Springboard provides legal-approved copy (M3).
function crisisHandoff() {
  const url = env("SUPPORT_CONTACT_URL", "");
  const note = env(
    "SUPPORT_CONTACT_NOTE",
    "You can reach a real person who can help — you don't have to carry this alone.",
  );
  return {
    source: "crisis",
    say: "I'm really glad you told me. This sounds like a lot to carry, and you don't have to handle it on your own — a real person can help.",
    intent: "chat",
    nextAction: null,
    plan: null,
    special: {
      kind: "support",
      title: url ? "Talk to someone now" : "Reach your Student Advisor",
      url,
      note,
    },
    celebrate: false,
  };
}

// A task may surface once the student explicitly asks for one / gives a time budget,
// or after they've sent at least two messages (a couple of exchanges in).
function allowNudge(messages) {
  const users = (messages || []).filter((m) => m && m.role === "user");
  const lastUser = (users[users.length - 1]?.content || "").toLowerCase();
  const explicit =
    /\b\d{1,3}\s*(min|minute|mins|m)\b/.test(lastUser) ||
    /what should i|what do i|give me|something to do|to do|study|next step|catch up|plan|start/.test(lastUser);
  return explicit || users.length >= 2;
}

function safeJson(text) {
  try {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s === -1 || e === -1) return {};
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return {};
  }
}

function normalize(p, celebrate = false) {
  return {
    say: p.say || "I'm here — tell me what's on your mind.",
    intent: ["chat", "status", "plan"].includes(p.intent) ? p.intent : "chat",
    nextAction: p.nextAction || null,
    plan: Array.isArray(p.plan) ? p.plan : null,
    special: p.special || null,
    celebrate: p.celebrate === true || celebrate === true,
  };
}

// Deterministic coach when no API key — keeps the POC alive, on the same single-source
// data (phase + health), honest-blind when progress can't be read.
function fallbackCoach({ messages, phase, health, progressUnavailable, special }) {
  const last = (messages[messages.length - 1]?.content || "").toLowerCase();
  const nudgeAllowed = allowNudge(messages);
  const wantsStatus = /how.*doing|progress|behind|on track/.test(last);
  const configured = !!(phase && phase.configured);
  const focus = configured ? phase.focus : null;
  const celebrate = !!(configured && phase.journeyComplete);

  if (progressUnavailable) {
    return { source: "rule-based", say: "I can't read your progress right now — but I'm here. What's on your mind?", intent: "chat", nextAction: null, plan: null, special: null, celebrate: false };
  }
  if (celebrate) {
    return { source: "rule-based", say: "You finished the journey. Quietly huge.", intent: "chat", nextAction: null, plan: null, special: null, celebrate: true };
  }
  if (wantsStatus) {
    const bits = [];
    if (configured) bits.push(`${phase.phasesDone} of ${phase.totalPhases} phases done${phase.currentPhaseName ? ` — ${phase.currentPhaseName} is next` : ""}`);
    if (health && typeof health.overallHealth === "number") bits.push(`health ${health.overallHealth}/100`);
    return { source: "rule-based", say: (bits.join("; ") || "Here's where you stand") + ".", intent: "status", nextAction: null, plan: null, special: null, celebrate: false };
  }
  if (!nudgeAllowed) {
    return { source: "rule-based", say: "I hear you. Tell me a bit more — how are you feeling about things?", intent: "chat", nextAction: null, plan: null, special: null, celebrate: false };
  }

  // Next item from the active phase — prefer a reading (isPage) first, then the graded item.
  let nextAction = null;
  if (focus && focus.items && focus.items.length) {
    const pick = focus.items.find((it) => it.isPage) || focus.items[0];
    nextAction = { title: pick.title, url: pick.url, why: pick.isPage ? `Read this, then the graded item in ${focus.name}` : `Next in ${focus.name}` };
  }
  return {
    source: "rule-based",
    say: nextAction ? "Here's where to start:" : "Nothing outstanding I can see — nice.",
    intent: nextAction ? "plan" : "chat",
    nextAction,
    plan: null,
    special: special[0] ? { kind: special[0].kind, title: special[0].title, url: special[0].url, note: special[0].kind === "resume" ? "Your resume assignment is in " + special[0].module : "Book your call in " + special[0].module } : null,
    celebrate: false,
  };
}

// Exported for unit tests (see test/plan.test.js). The default export is the handler.
export { runCoach, triage, crisisHandoff, normalize };
