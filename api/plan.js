// Agent endpoint (Phase 1).
// Frontend POSTs { messages: [...transcript], energy } — memory is client-side.
// We inject real Canvas module data + a server-computed progress read, then let
// Haiku act as a calm, state-aware study coach that returns a small JSON shape:
//   { say, intent, nextAction, plan, special, celebrate }
// Progress numbers are authoritative from the server, never invented by the model.
import { env, readState, parseCookies } from "../lib/lti.js";
import { getModules, findSpecialItems } from "../lib/canvas.js";
import { getCurriculumState, deriveState } from "../lib/myprogress.js";

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

    // Single source of truth = the My Progress app (exactly what the student sees).
    // One read; state is derived deterministically, never by the model. On failure we
    // degrade honest-blind rather than invent a number.
    const cs = await getCurriculumState(courseId, studentId).catch(() => null);
    const status = deriveState(cs);
    const progressUnavailable = status.state === "unknown";

    const daysAway =
      typeof signals.daysAway === "number" ? signals.daysAway : null;

    let agent;
    if (process.env.ANTHROPIC_API_KEY) {
      // Triage real user turns (never the opening) for emotional routing.
      const label = mode === "greeting" ? "coach" : await triage(messages);
      if (label === "crisis" || label === "at_risk") {
        agent = advisingHandoff(label);
      } else {
        agent = await runCoach({ messages, energy, mode, daysAway, status, progressUnavailable, special, ctx, distress: label === "distress" });
      }
    } else {
      agent = fallbackCoach({ messages, status, progressUnavailable, special });
    }

    res.status(200).json({ status: progressUnavailable ? null : status, ...agent });
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
- The card carries the detail, so "say" should NOT re-list items or numbers.
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

CONVERSATION:
- If they ask a question (e.g. "why did you pick that?", "how am I doing?"),
  ANSWER it naturally in "say". Do NOT force a plan when they just want to talk.
- Only set intent "plan" when they want something to do / gave a time budget.
- Set intent "status" when they ask how they're doing.
- Otherwise intent "chat".

PROGRESS — YOU DO NOT COMPUTE IT (this mirrors exactly what the student sees in
"My Progress"; never contradict their screen):
- "status" is authoritative and already computed: state, label, view, dueCount,
  doneCount, outstanding, score, scoreBand, and "next" (the one concrete next item).
- NEVER invent, estimate, or recompute a number, percentage, week or item name.
- SCORE VISIBILITY FOLLOWS THE VIEW, exactly like the app:
  * view "detailed": you MAY reference "score" (e.g. "you're at 82%"). scoreBand "good"
    = reinforce; "warn" = gentle, still encouraging.
  * view "focus": "score" is null and HIDDEN on the student's own screen too. Do NOT
    state or hint at a percentage. Lead with "you're a bit behind but can still catch up",
    then the single next step.
- The next step and item list are rendered as cards — do NOT recite items or URLs in
  "say". Refer to the step, don't list it.
- If "progressUnavailable" is true you CANNOT see their progress: say so plainly, invent
  nothing, keep talking warmly.

ANSWER THE ACTUAL QUESTION — use "weekFacts" (per week: done, and each item's complete /
submitted / score / outOf). This lets you answer specifics in "say" WITHOUT a card:
- "did I do week 2?" → check weekFacts for week 2. If submitted but score < pass, say so
  warmly: "You did take it — scored 35 — but it's under the bar to count as passed, so it's
  still on your list. Worth a retake." If submitted and not yet graded (score null), say
  "it's in, just not graded yet." Never re-vomit the whole list to answer one week.

WHICH CARD TO SHOW ("show") — DEFAULT "none". A card is a heavy interruption; earn it:
- "none": normal. Any follow-up, any specific question, any chit-chat. Just talk.
- "overview": ONLY when they ask broadly how they're doing AND haven't just seen it. Never
  two turns in a row.
- "next": ONLY when they ask what to do / for a task. Shows one tile, not the list.
When unsure, "none". The conversation is the product; the card is the exception.

EXPLAIN PASSING BY THE GATE (status.gate.type — this varies by course, get it right):
- "all_complete": every weekly module must be passed. "You've passed {passedCount} of
  {totalCount}; {remaining} still to go — each one just needs to clear the bar."
- "pass_count": pass a set number. "You need {required} passed; you're at {passedCount},
  so {remaining} more to go."
- "cumulative": an overall score. "You need {passThreshold}% overall; you're at {score}%.
  Lifting the low ones pulls it up." (Only when view is detailed — see score rule above.)
Use the gate's real numbers, never invent them. This is how the student knows what "done"
actually means.

PASSING CUTOFF: status.passPercent is the score an item must reach to count as passed. When
asked "what's the passing score", give it: "you need {passPercent}% to pass." status.next.score
/ .outOf are the current item's score and total. Never say you don't have the cutoff — it's
in status.passPercent.

COACHING BY STATE (meet them where they are):
- caught_up: warm, brief reinforcement. Don't manufacture work.
- on_track: light touch. Protect the momentum; don't over-coach a student who's fine.
- off_track (focus view): lead with warmth and "you can still finish on time", NO number,
  then the one smallest next step. Never lecture or list what they've missed.
- behind: shrink the ask. ONE small step, zero guilt, "start here" energy.
- starting / nothing_due: encouraging, no pressure, no task.

SPECIAL ITEMS: only mention resume/booking/coaching items if they exist in the
provided list AND are relevant to what the student said or asked. Never invent them.

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

You return only "say", "intent" and optionally "special". The next step, the item list
and the status card are built by the app from authoritative data — not by you.`;

async function runCoach({ messages, energy, mode, daysAway, status, progressUnavailable, special, ctx, distress = false }) {
  const model = env("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001");
  const nudgeAllowed = mode !== "greeting" && !distress && allowNudge(messages);
  const celebrate = status.state === "caught_up";
  const grounding = {
    student: ctx?.givenName || ctx?.name || "there",
    energySignal: energy,
    nudgeAllowed,
    daysAway,
    distressSignal: distress,
    progressUnavailable: !!progressUnavailable,
    // Authoritative, already computed. The model reads it; it never recomputes it.
    status: progressUnavailable
      ? null
      : {
          state: status.state,
          label: status.label,
          view: status.view, // "focus" (behind — hide score) | "detailed" (show score)
          gate: status.gate, // how the phase is passed: {type, passedCount, totalCount, required, passThreshold, remaining, gateMet}
          passPercent: status.passPercent, // the score % an item must reach to pass (the cutoff)
          dueCount: status.dueCount,
          doneCount: status.doneCount,
          outstanding: status.outstanding,
          score: status.score, // null in focus view; a number in detailed view
          scoreBand: status.scoreBand, // "good" | "warn" | null
          next: status.next ? { title: status.next.title, week: status.next.week, score: status.next.score, outOf: status.next.outOf } : null,
        },
    // Per-week facts so the model can answer specific questions ("did I do week 2?")
    // WITHOUT dumping the whole card. It reasons over these; it never recites them.
    weekFacts: progressUnavailable ? null : status.facts,
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
      show: "none",
      nextAction: null,
      special: null,
      celebrate,
    };
  }

  const out = normalize(parsed, celebrate);
  // The model chose which card (if any) to show. We gate it: no cards while distressed
  // or blind. Card CONTENTS are always ours (authoritative), never the model's words.
  let show = ["none", "overview", "next"].includes(parsed.show) ? parsed.show : "none";
  if (distress || progressUnavailable) show = "none";
  if (show === "next" && !(nudgeAllowed && status.next)) show = "none";
  out.show = show;
  out.nextAction = show === "next"
    ? { title: status.next.title, url: status.next.url, week: status.next.week, score: status.next.score, outOf: status.next.outOf, needPct: status.passPercent, why: `Week ${status.next.week} — your next unfinished item` }
    : null;
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

// Deliberately small: the model writes the human sentence and nothing else. The next
// step, the item list and the status card come from authoritative data. Fewer output
// tokens per turn, and nothing factual can be hallucinated.
const COACH_TOOL = {
  name: "respond",
  description: "Reply to the student. Always call this tool with your message.",
  input_schema: {
    type: "object",
    properties: {
      say: { type: "string", description: "1-2 short warm sentences answering exactly what was asked. No item names, no numbers, no URLs — cards carry those." },
      intent: { type: "string", enum: ["chat", "status", "plan"] },
      show: {
        type: "string",
        enum: ["none", "overview", "next"],
        description: "Which card to render. none = just talk (DEFAULT for follow-ups and specific questions). overview = the full status card (only for a broad 'how am I doing'). next = the single next-step tile (when they ask what to do).",
      },
      special: {
        type: "object",
        properties: {
          kind: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          note: { type: "string" },
        },
      },
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
  const say =
    kind === "crisis"
      ? "I'm really glad you told me — this matters, and you shouldn't carry it alone. I've flagged your advising team and they'll reach out to support you as soon as they can."
      : "That's a lot to be carrying, and this isn't something to sort out on your own. I've flagged your advising team — they'll reach out to support you as soon as they can.";
  return {
    source: kind, // "at_risk" | "crisis"
    say,
    intent: "chat",
    show: "none",
    nextAction: null,
    special: {
      kind: "advising",
      title: "Your advising team",
      email, // copyable — rendered as copy-to-clipboard, not a mailto link
      note: "They'll reach out — you can also email them directly:",
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
    nextAction: null, // set by the caller from authoritative data, never by the model
    special: p.special || null,
    celebrate: celebrate === true,
  };
}

// Deterministic coach when no API key — keeps the POC alive, on the same single-source
// data (phase + health), honest-blind when progress can't be read.
function fallbackCoach({ messages, status, progressUnavailable, special }) {
  const reply = (say, intent = "chat", show = "none", nextAction = null, celebrate = false) => ({
    source: "rule-based", say, intent, show, nextAction, special: null, celebrate,
  });
  if (progressUnavailable) return reply("I can't read your progress right now — but I'm here. What's on your mind?");

  const last = (messages[messages.length - 1]?.content || "").toLowerCase();
  const wantsStatus = /how.*doing|progress|behind|on track/.test(last);
  if (wantsStatus) return reply(status.label + ".", "status", "overview", null, status.state === "caught_up");
  if (!allowNudge(messages)) return reply("I hear you. Tell me a bit more — how are you feeling about things?");
  if (!status.next) return reply("You're all caught up — nice.", "chat", "none", null, true);

  return {
    ...reply("Here's where to start:", "plan", "next", {
      title: status.next.title,
      url: status.next.url,
      week: status.next.week,
      score: status.next.score,
      outOf: status.next.outOf,
      needPct: status.passPercent,
      why: `Week ${status.next.week} — your next unfinished item`,
    }),
    special: special[0]
      ? { kind: special[0].kind, title: special[0].title, url: special[0].url, note: special[0].kind === "resume" ? "Your resume assignment is in " + special[0].module : "Book your call in " + special[0].module }
      : null,
  };
}

// Exported for unit tests (see test/plan.test.js). The default export is the handler.
export { runCoach, triage, advisingHandoff, normalize };
