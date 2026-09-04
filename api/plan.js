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
import { getWeekJourney } from "../lib/weeks.js";

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

    // Authoritative journey: weeks passed / total, by graded-quiz >=70% (ported
    // from Springboard's canvas-dashboard). This overrides item-completion % as the
    // real "where you are" signal. Degrade gracefully if grades can't be read.
    let journey = null;
    try {
      journey = await getWeekJourney(courseId, studentId);
    } catch (e) {
      journey = null;
    }
    if (journey && journey.totalWeeks > 0) {
      progress.percentComplete = journey.percentComplete;
      progress.doneItems = journey.weeksPassed;
      progress.totalItems = journey.totalWeeks;
      progress.unit = "weeks";
    }

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
      // Triage real user turns (never the opening) for emotional routing.
      const label = mode === "greeting" ? "coach" : await triage(messages);
      if (label === "crisis") {
        agent = crisisHandoff(progress);
      } else {
        agent = await runCoach({ messages, energy, mode, daysAway, progressDelta, progress, remaining, special, journey, ctx, distress: label === "distress" });
      }
    } else {
      agent = fallbackCoach({ messages, energy, mode, daysAway, progressDelta, progress, remaining, special, journey });
    }

    // Compact week map for the UI (which weeks passed, which is next).
    const weeks =
      journey && journey.totalWeeks
        ? journey.weeks
            .filter((w) => w.gradedItems.length > 0)
            .map((w) => ({
              week: w.weekNumber,
              passed: w.passed,
              focus: journey.focusWeek ? w.weekNumber === journey.focusWeek.weekNumber : false,
            }))
        : null;

    res.status(200).json({ progress, weeks, ...agent });
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

WEEK JOURNEY (this is the real progress model — use it over item counts):
- Progress = weeksPassed / totalWeeks. A week is PASSED when its graded quiz scored
  >= passThresholdPercent (70). Reading/engagement of other items does NOT matter.
- "How am I doing" = how many weeks passed vs total, and which week they're on.
- When you recommend a task (and nudgeAllowed), drive the FOCUS WEEK:
  * If focusWeek.quizzesPassed is false: recommend the reading FIRST
    (focusWeek.reading[0], use its estMinutes), framed as "read this week's material,
    then take the quiz". The quiz (focusWeek.quiz) is the goal after reading.
  * nextAction = that reading item (title+url). If reading is already covered or none
    exists, nextAction = focusWeek.quiz.
- Never invent items — only use focusWeek.reading / focusWeek.quiz urls.

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

async function runCoach({ messages, energy, mode, daysAway, progressDelta, progress, remaining, special, journey, ctx, distress = false }) {
  const model = env("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001");
  const nudgeAllowed = mode !== "greeting" && !distress && allowNudge(messages);
  const focus = journey?.focusWeek || null;
  const grounding = {
    student: ctx?.givenName || ctx?.name || "there",
    energySignal: energy,
    nudgeAllowed,
    daysAway,
    progressDeltaSinceLastVisit: progressDelta,
    distressSignal: distress,
    weekJourney: journey
      ? {
          weeksPassed: journey.weeksPassed,
          totalWeeks: journey.totalWeeks,
          passThresholdPercent: journey.passThresholdPercent,
          focusWeek: focus
            ? {
                week: focus.weekNumber,
                moduleName: focus.moduleName,
                quizzesPassed: focus.quizzesPassed,
                reading: focus.reading.slice(0, 5).map((r) => ({ ...r, estMinutes: estimateMinutes(r) })),
                quiz: focus.quiz,
              }
            : null,
        }
      : null,
    progress: {
      percentComplete: progress.percentComplete,
      doneItems: progress.doneItems,
      totalItems: progress.totalItems,
      unit: progress.unit || "items",
    },
    remainingItems: remaining.slice(0, 20),
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
      celebrate: progress.percentComplete === 100,
    };
  }

  const out = normalize(parsed, progress);
  // Hard gate: never surface a task before it's earned, or while the student is distressed.
  if (distress || !nudgeAllowed) {
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
function crisisHandoff(progress) {
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

function normalize(p, progress) {
  return {
    say: p.say || "I'm here — tell me what's on your mind.",
    intent: ["chat", "status", "plan"].includes(p.intent) ? p.intent : "chat",
    nextAction: p.nextAction || null,
    plan: Array.isArray(p.plan) ? p.plan : null,
    special: p.special || null,
    celebrate: p.celebrate === true || progress.percentComplete === 100,
  };
}

// Deterministic coach when no API key — keeps the POC alive and on-message.
function fallbackCoach({ messages, energy, mode, daysAway, progressDelta, progress, remaining, special, journey }) {
  const focus = journey?.focusWeek || null;
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

  // Prefer the week journey: reading of the focus week first, then its quiz.
  let nextAction = null;
  if (focus) {
    if (!focus.quizzesPassed && focus.reading && focus.reading[0]) {
      const rd = focus.reading[0];
      nextAction = { title: rd.title, url: rd.url, minutes: estimateMinutes(rd), why: `Read Week ${focus.week} material, then take the quiz` };
    } else if (focus.quiz) {
      nextAction = { title: focus.quiz.title, url: focus.quiz.url, minutes: 20, why: `Take the Week ${focus.week} quiz to pass it` };
    }
  }
  if (!nextAction && hero) {
    nextAction = { title: hero.title, url: hero.url, minutes: hero.estMinutes, why: hero.overdue ? "Overdue — clear this first" : "Due soon" };
  }

  let say;
  if (done) {
    say = "You finished. Quietly huge.";
  } else if (wantsStatus) {
    say = journey && journey.totalWeeks
      ? `${journey.weeksPassed} of ${journey.totalWeeks} weeks passed${focus ? ` — Week ${focus.week} is next` : ""}.`
      : `${progress.percentComplete}% done.`;
  } else if (focus && !focus.quizzesPassed && focus.reading && focus.reading[0]) {
    say = `Week ${focus.week} next — read, then take the quiz:`;
  } else if (energy === "low") {
    say = "One small thing to keep momentum:";
  } else {
    say = "Here's where to start:";
  }

  return {
    source: "rule-based",
    say,
    intent: wantsStatus ? "status" : "plan",
    nextAction,
    plan: plan.length ? plan : null,
    special: special[0] ? { kind: special[0].kind, title: special[0].title, url: special[0].url, note: special[0].kind === "resume" ? "Your resume assignment is in " + special[0].module : "Book your call in " + special[0].module } : null,
    celebrate: done,
  };
}

// Exported for unit tests (see test/plan.test.js). The default export is the handler.
export { runCoach, triage, crisisHandoff, normalize };
