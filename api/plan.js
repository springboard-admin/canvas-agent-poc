// Agent endpoint (Phase 1).
// Frontend POSTs { messages: [...transcript], energy } — memory is client-side.
// We inject real Canvas module data + a server-computed progress read, then let
// Haiku act as a calm, state-aware study coach that returns a small JSON shape:
//   { say, intent, nextAction, plan, special, celebrate }
// Progress numbers are authoritative from the server, never invented by the model.
import { env, readState, parseCookies } from "../lib/lti.js";
import {
  getModules,
  summarizeProgress,
  estimateMinutes,
  findSpecialItems,
} from "../lib/canvas.js";

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
    const progress = summarizeProgress(modules);
    const special = findSpecialItems(modules);

    // Attach honest ~time estimates to remaining items for grounding.
    const remaining = progress.remaining.map((it) => ({
      ...it,
      estMinutes: estimateMinutes(it),
    }));

    // progressDelta = points gained since their last visit (from client localStorage).
    const progressDelta =
      typeof signals.lastPercent === "number"
        ? progress.percentComplete - signals.lastPercent
        : null;
    const daysAway =
      typeof signals.daysAway === "number" ? signals.daysAway : null;

    let agent;
    if (process.env.ANTHROPIC_API_KEY) {
      agent = await runCoach({ messages, energy, mode, daysAway, progressDelta, progress, remaining, special, ctx });
    } else {
      agent = fallbackCoach({ messages, energy, mode, daysAway, progressDelta, progress, remaining, special });
    }

    res.status(200).json({ progress, ...agent });
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

SPECIAL ITEMS: only mention resume/booking/coaching items if they exist in the
provided list AND are relevant to what the student said or asked. Never invent them.

TIME: use the provided estMinutes. Always phrase estimates as approximate ("~10 min").

OPENING GREETING (when told this is the opening): the student just landed and hasn't
said anything. Do NOT give them a task or a plan. Open with ONE short, warm,
personalized line + a light, genuine question that invites them to reply — so they
start a conversation and you can read how they're doing. Use the signals for warmth,
not pressure:
- daysAway large (>=3): "welcome back", zero guilt, glad they're here.
- progressDelta > 0: quietly note the momentum.
- behind: stay encouraging and low-pressure; make it feel okay to be here.
- on track: warm reinforcement.
Set intent "chat", nextAction null, plan null. Keep it under ~25 words.

CELEBRATION: if percentComplete is 100, warmly acknowledge they've finished — keep it
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
nextAction/plan titles and urls MUST come from the provided remaining items. Plan minutes should sum to <= the student's available time.`;

async function runCoach({ messages, energy, mode, daysAway, progressDelta, progress, remaining, special, ctx }) {
  const model = env("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001");
  const nudgeAllowed = mode !== "greeting" && allowNudge(messages);
  const grounding = {
    student: ctx?.givenName || ctx?.name || "there",
    energySignal: energy,
    nudgeAllowed,
    daysAway,
    progressDeltaSinceLastVisit: progressDelta,
    progress: {
      percentComplete: progress.percentComplete,
      doneItems: progress.doneItems,
      totalItems: progress.totalItems,
      overdueCount: progress.overdueCount,
      onTrack: progress.onTrack,
    },
    remainingItems: remaining.slice(0, 40),
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
      content: "This is the OPENING — the student just landed and hasn't asked anything. Follow the OPENING GREETING rules: one personalized hook + one tiny next step.",
    });
  }

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      system: SYSTEM,
      messages: anthropicMessages,
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Anthropic ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = (data.content || []).map((c) => c.text || "").join("");
  const parsed = safeJson(text);
  const out = normalize(parsed, progress);
  // Hard gate: never surface a task before it's earned, even if the model tries.
  if (!nudgeAllowed) {
    out.nextAction = null;
    out.plan = null;
    if (out.intent === "plan") out.intent = "chat";
  }
  return { source: "claude", ...out };
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

function normalize(p, progress) {
  return {
    say: p.say || "I'm here whenever you want to make a little progress.",
    intent: ["chat", "status", "plan"].includes(p.intent) ? p.intent : "chat",
    nextAction: p.nextAction || null,
    plan: Array.isArray(p.plan) ? p.plan : null,
    special: p.special || null,
    celebrate: p.celebrate === true || progress.percentComplete === 100,
  };
}

// Deterministic coach when no API key — keeps the POC alive and on-message.
function fallbackCoach({ messages, energy, mode, daysAway, progressDelta, progress, remaining, special }) {
  const last = (messages[messages.length - 1]?.content || "").toLowerCase();
  const isGreeting = mode === "greeting";
  const nudgeAllowed = !isGreeting && allowNudge(messages);
  const wantsStatus = /how.*doing|progress|behind|on track/.test(last);

  // Opening / early chit-chat: converse, don't hand out a task.
  if (isGreeting) {
    let hello;
    if (daysAway != null && daysAway >= 3) hello = "Welcome back — good to see you. How's the course feeling lately?";
    else if (progressDelta != null && progressDelta > 0) hello = "Nice to see you again — you've been moving. How's it going?";
    else hello = "Hey — glad you're here. How are you feeling about things this week?";
    return { source: "rule-based", say: hello, intent: "chat", nextAction: null, plan: null, special: null, celebrate: progress.percentComplete === 100 };
  }
  if (!nudgeAllowed && !wantsStatus) {
    return { source: "rule-based", say: "I hear you. Tell me a bit more — how much time or energy do you have?", intent: "chat", nextAction: null, plan: null, special: null, celebrate: false };
  }
  const minutesMatch = last.match(/(\d{1,3})\s*(min|minute|m)\b/);
  const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 30;

  const sorted = [...remaining].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const da = a.dueAt ? Date.parse(a.dueAt) : Infinity;
    const db = b.dueAt ? Date.parse(b.dueAt) : Infinity;
    return da - db;
  });

  // Low energy → smallest item first.
  if (energy === "low") sorted.sort((a, b) => a.estMinutes - b.estMinutes);

  const hero = sorted[0] || null;
  const budget = energy === "low" ? Math.min(minutes, 10) : minutes;
  const plan = [];
  let used = 0;
  for (const it of sorted) {
    if (used + it.estMinutes > budget) continue;
    plan.push({ title: it.title, url: it.url, minutes: it.estMinutes, why: it.overdue ? "Overdue — clear this first" : "Due soon" });
    used += it.estMinutes;
    if (plan.length >= 4) break;
  }

  const done = progress.percentComplete === 100;
  let say;
  if (done) {
    say = "You finished. Quietly huge.";
  } else if (isGreeting) {
    const name = ""; // kept terse
    if (daysAway != null && daysAway >= 3) {
      say = "Welcome back. Here's one small thing to ease in:";
    } else if (progressDelta != null && progressDelta > 0) {
      say = `Up ${progressDelta}% since last time — keep it rolling:`;
    } else if (progress.overdueCount > 0) {
      say = `Caught up is closer than it feels — start here:`;
    } else {
      say = "You're on pace. One step to stay there:";
    }
  } else if (wantsStatus) {
    say = `${progress.percentComplete}% done${progress.overdueCount ? ` — ${progress.overdueCount} to catch up, easy` : ", on pace"}.`;
  } else if (energy === "low") {
    say = "One small thing to keep momentum:";
  } else {
    say = "Here's where to start:";
  }

  return {
    source: "rule-based",
    say,
    intent: wantsStatus && !isGreeting ? "status" : "plan",
    nextAction: hero
      ? { title: hero.title, url: hero.url, minutes: hero.estMinutes, why: hero.overdue ? "Overdue — clear this first" : "Due soon" }
      : null,
    plan: plan.length ? plan : null,
    special: special[0] ? { kind: special[0].kind, title: special[0].title, url: special[0].url, note: special[0].kind === "resume" ? "Your resume assignment is in " + special[0].module : "Book your call in " + special[0].module } : null,
    celebrate: done,
  };
}
