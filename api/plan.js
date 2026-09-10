// Agent endpoint. Frontend POSTs { messages: [...transcript] } — memory is client-side.
// Flow: Haiku triage (safety gate) → at_risk/crisis deflect to advising (no model loop);
// otherwise a Sonnet tool-use loop over the connector registry (lib/connectors/). The model
// reads facts + renders cards via tools; card CONTENTS are built by us from authoritative
// data, never the model's words. Response: { say, cards:[...], source }.
import { env, readState, parseCookies } from "../lib/lti.js";
import { getStudentProgress, deriveState } from "../lib/myprogress.js";
import { toolDefs, runTool, makeToolCtx } from "../lib/connectors/index.js";
import { progressCard, nextCard } from "../lib/connectors/myprogress.js";

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
    const daysAway = typeof signals.daysAway === "number" ? signals.daysAway : null;

    let agent;
    if (process.env.ANTHROPIC_API_KEY) {
      // Triage real user turns (never the opening) for emotional routing. This is a
      // safety gate BEFORE the agent loop — at_risk/crisis never reach the tools.
      const label = mode === "greeting" ? "coach" : await triage(messages);
      if (label === "crisis" || label === "at_risk") {
        agent = advisingHandoff(label);
      } else {
        agent = await runAgent({ messages, mode, daysAway, courseId, studentId, ctx, distress: label === "distress" });
      }
    } else {
      // No API key → deterministic demo path over the same single source.
      const sp = await getStudentProgress(courseId, studentId).catch(() => null);
      agent = fallbackCoach({ messages, status: deriveState(sp) });
    }

    res.status(200).json(agent);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

const SYSTEM = `You are a warm, calm study advisor living on a student's course home page.
Your job: help a tired, busy, procrastinating learner keep making small, steady progress —
and, almost without noticing, finish the course.

STYLE — HIGH SIGNAL, FEW WORDS (matters most):
- Reply in 1-2 short warm sentences. Often one is better. Cut every word not pulling weight.
- No preamble ("Good question", "Honestly"), no hedging, no repeating the question.
- Answer EXACTLY what was asked. Don't over-explain or dump everything.
- Cards carry the detail — do NOT recite item names, numbers, or URLs in your text.

YOU HAVE TOOLS — this is how you know things and how you show cards. You have no built-in
knowledge of this student; get every fact from a tool.
READ tools (call these to learn facts, then answer in your own warm words):
- get_progress — overall curriculum state, gate, passing cutoff, counts, score. For "how am I doing".
- get_week(week) — the items in a week and how they did (score, out of, submitted, passed).
  For "did I do week 2?", "what's left in week 3?".
- find_item(query) — search their items by name/keyword.
- get_phases — the whole journey across all phases (where they are, passed vs required).
SHOW tools (render a card the student sees — content is built from authoritative data; you
only choose to show it). Cards are the EXCEPTION — most answers are words only:
- show_all_weeks — the FULL week-by-week list. ONLY when they explicitly ask for the full
  list / all weeks / to see everything / the details. NEVER for a general "how am I doing".
- show_next_step — the single next-step tile. ONLY when they ask what to do / for a task.
- open_in_canvas(week) — a clickable card opening that week's Canvas module page in a new tab.
  For "take me to week N", "where do I study", "open the module".
- show_phases — the journey stepper (all phases). For "show my phases", "overall journey".

"HOW AM I DOING" = a WARM, HIGH-LEVEL answer IN WORDS + reassurance it's still catchable if
they're behind. Call get_progress to get the facts, then say it briefly — do NOT dump the week
list. Only render show_all_weeks if they then ask to see everything.

NEVER invent, estimate, or recompute a fact. If a tool doesn't give it, say you don't have
it — don't guess. Everything you state must trace to a tool result.

CARDS ARE THE EXCEPTION, NOT THE RULE. Default: just talk, no card. A card is a heavy
interruption — earn it. Specific questions and follow-ups get a spoken answer, no card.
Never show the same card two turns running.

EXPLAIN PASSING BY THE GATE (get_progress.gate.type — varies by course, get it right):
- "all_complete": every module must be passed — "you've passed {passedCount} of {totalCount};
  {remaining} to go, each just needs to clear the bar."
- "pass_count": "you need {required} passed; you're at {passedCount}, {remaining} more."
- "cumulative": "you need {passThreshold}% overall; you're at {score}%."
Use the gate's real numbers. This is how the student knows what "done" means.
PASSING CUTOFF: get_progress.passPercent is the score an item must reach to pass. Asked "what's
the passing score" → give it. Never say you don't have the cutoff.

SCORE VISIBILITY FOLLOWS THE VIEW (from get_progress.view), exactly like the app:
- "detailed": you MAY state the score. scoreBand "good" = reinforce, "warn" = gentle.
- "focus" (behind): score is HIDDEN on the student's own screen — do NOT state a percentage.
  Lead with "you're a bit behind but can still catch up", then the one next step.

COACHING BY STATE (get_progress.state):
- caught_up: warm, brief reinforcement. Don't manufacture work.
- on_track: light touch; protect momentum, don't over-coach.
- off_track (focus): warmth + "you can still finish on time", NO number, one smallest step.
- behind: shrink the ask — ONE small step, zero guilt.
- starting / nothing_due / unavailable: encouraging, no task; if unavailable, say plainly you
  can't read their progress right now.

DON'T PUSH A TASK TOO EARLY: on the opening or first exchange, don't hand out a task unless
they ask for one or give a time budget. Open by connecting warmly; let a suggestion emerge.

HABITS (only when attendance/engagement tools are available — they may not be yet): when
tools for mentor-call attendance or live-session engagement exist, factor them into "how am I
doing" and gently build good habits — don't keep mentors waiting, cut no-shows, catch missed
live-session recordings — alongside curriculum progress. If those tools aren't present, ignore
this.

OPENING GREETING (when told this is the opening): the student just landed. No task, no card.
One short warm personalized line + a light question. daysAway >=3 → "welcome back", zero guilt.
Under ~25 words.`;

// The agent: a tool-use loop. The model decides which tools to call across the connector
// registry; we execute them, feed results back, and loop until it's done. Cards are
// collected from the render tools (authoritative content, built by us). Cap iterations so
// a misbehaving model can never hang; fall back honestly if the call fails outright.
const MAX_ITERS = 6;
async function runAgent({ messages, mode, daysAway, courseId, studentId, ctx, distress = false }) {
  const model = env("ANTHROPIC_MODEL", "claude-sonnet-5");
  const toolCtx = makeToolCtx({ courseId, studentId });
  const cards = [];
  const tools = toolDefs();

  const convo = (messages || [])
    .filter((m) => m && m.role && m.content)
    .slice(-12)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) }));
  const anthropicMessages = [...convo];
  if (mode === "greeting") {
    anthropicMessages.push({ role: "user", content: `[opening — the student ${ctx?.givenName ? ctx.givenName + " " : ""}just landed${daysAway != null ? `, ${daysAway} days since last visit` : ""}, hasn't asked anything. Follow the OPENING GREETING rules: one warm line + a light question. No task, no card.]` });
  }
  if (distress) {
    anthropicMessages.push({ role: "user", content: "[the student sounds low/overwhelmed — lead with warmth, DO NOT offer a task or show a next-step/open card this turn, just be human and invite them to say more.]" });
  }

  let say = "";
  try {
    for (let i = 0; i < MAX_ITERS; i++) {
      const data = await callMessages({ model, system: SYSTEM, messages: anthropicMessages, tools });
      const content = data.content || [];
      const text = content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (text) say = text;
      const toolUses = content.filter((b) => b.type === "tool_use");
      if (data.stop_reason !== "tool_use" || toolUses.length === 0) break;
      anthropicMessages.push({ role: "assistant", content });
      const results = [];
      for (const tu of toolUses) {
        const out = await runTool(tu.name, tu.input, toolCtx, cards);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
      }
      anthropicMessages.push({ role: "user", content: results });
    }
  } catch (e) {
    console.error("agent loop failed:", e.message);
    return { source: "error", say: "I hit a snag on my end just now — mind saying that again?", cards: [] };
  }

  // Preserve the guarantees: while distressed, drop any task/navigation cards (keep an
  // overview if the model insisted). A card must never surface work into a hard moment.
  let finalCards = cards;
  if (distress) finalCards = finalCards.filter((c) => c.kind === "progress");

  return { source: "claude", say: say || "I'm here — what's on your mind?", cards: finalCards };
}

async function callMessages({ model, system, messages, tools, maxTokens = 800 }) {
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
      // Cache the stable system prompt across the loop's round-trips.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      tools,
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Anthropic ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
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

const TRIAGE_TOOL = {
  name: "classify",
  description: "Classify the student's latest message.",
  input_schema: {
    type: "object",
    properties: {
      label: { type: "string", enum: ["coach", "status", "distress", "at_risk", "crisis"] },
    },
    required: ["label"],
  },
};

const TRIAGE_SYSTEM = `Classify the student's latest message into exactly one label:
- crisis: self-harm, suicide, abuse, a medical or mental-health emergency — someone needs a human NOW.
- at_risk: signals they might LEAVE the program — "quit", "drop out", "withdraw", "can't do this anymore", "want to give up", "thinking of leaving" — OR strong overwhelm about continuing ("it's too much", "can't keep up with work and study", "burning out"). This is NOT ours to solve; it hands off to advising.
- distress: struggling, discouraged, "life is hard", low motivation — emotional, but they are NOT signalling they might leave.
- status: asking how they're doing / their progress / where they stand.
- coach: anything else — wants a task, a course question, or casual chat.
Priority when torn: crisis > at_risk > distress > status > coach.`;

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
    return ["coach", "status", "distress", "at_risk", "crisis"].includes(label) ? label : "coach";
  } catch (e) {
    console.error("triage failed:", e.message);
    return "coach";
  }
}

// Deflect to advising. No model call, no problem-solving — the moment we see a student
// might leave (or is in crisis), we hand off. One channel: advising@ (per product).
// NOTE: the "flagged your advising team" claim is not yet backed by a real notification —
// backlog: Segment event -> HubSpot workflow creating a task for the contact owner with the
// conversation as payload. Until then the advising inbox is the actual path.
function advisingHandoff(kind) {
  const email = env("ADVISING_EMAIL", "advising@springboard.com");
  const lead =
    kind === "crisis"
      ? "I'm really glad you told me — this matters, and you shouldn't carry it alone."
      : "That's a lot to be carrying, and this isn't something to sort out on your own.";
  return {
    source: kind, // "at_risk" | "crisis"
    say: `${lead} I've flagged your advising team and they'll reach out as soon as they can — you can also email them at ${email}.`,
    cards: [],
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

// Deterministic path when no API key — same single source, new {say, cards} shape.
function fallbackCoach({ messages, status }) {
  if (status.state === "unknown") return { source: "rule-based", say: "I can't read your progress right now — but I'm here. What's on your mind?", cards: [] };
  const last = (messages[messages.length - 1]?.content || "").toLowerCase();
  const wantsStatus = /how.*doing|progress|behind|on track/.test(last);
  if (wantsStatus) return { source: "rule-based", say: status.label + (status.state === "off_track" || status.state === "behind" ? " — still catchable." : "."), cards: [] };
  if (/all weeks|everything|full list|show me the|details/.test(last)) return { source: "rule-based", say: "Here's the full picture:", cards: [progressCard(status)] };
  if (!allowNudge(messages)) return { source: "rule-based", say: "I hear you. Tell me a bit more — how are you feeling about things?", cards: [] };
  const c = nextCard(status);
  if (!c) return { source: "rule-based", say: "You're all caught up — nice.", cards: [] };
  return { source: "rule-based", say: "Here's where to start:", cards: [c] };
}

// Exported for unit tests (see test/plan.test.js). The default export is the handler.
export { runAgent, triage, advisingHandoff, fallbackCoach };
