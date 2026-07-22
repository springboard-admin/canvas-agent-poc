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

    const { messages = [], energy = null } = req.body || {};
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

    let agent;
    if (process.env.ANTHROPIC_API_KEY) {
      agent = await runCoach({ messages, energy, progress, remaining, special, ctx });
    } else {
      agent = fallbackCoach({ messages, energy, progress, remaining, special });
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

STATE-AWARE SIZING (use the energy signal + their words):
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

async function runCoach({ messages, energy, progress, remaining, special, ctx }) {
  const model = env("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001");
  const grounding = {
    student: ctx?.givenName || ctx?.name || "there",
    energySignal: energy,
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
  return { source: "claude", ...normalize(parsed, progress) };
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
function fallbackCoach({ messages, energy, progress, remaining, special }) {
  const last = (messages[messages.length - 1]?.content || "").toLowerCase();
  const wantsStatus = /how.*doing|progress|behind|on track/.test(last);
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
  const say = done
    ? "You finished. Quietly huge."
    : wantsStatus
    ? `${progress.percentComplete}% done${progress.overdueCount ? ` — ${progress.overdueCount} to catch up, easy` : ", on pace"}.`
    : energy === "low"
    ? "One small thing to keep momentum:"
    : "Here's where to start:";

  return {
    source: "rule-based",
    say,
    intent: wantsStatus ? "status" : "plan",
    nextAction: hero
      ? { title: hero.title, url: hero.url, minutes: hero.estMinutes, why: hero.overdue ? "Overdue — clear this first" : "Due soon" }
      : null,
    plan: plan.length ? plan : null,
    special: special[0] ? { kind: special[0].kind, title: special[0].title, url: special[0].url, note: special[0].kind === "resume" ? "Your resume assignment is in " + special[0].module : "Book your call in " + special[0].module } : null,
    celebrate: done,
  };
}
