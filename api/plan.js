// Core agent endpoint. The SPA POSTs { minutes, message } here.
// We read the course Modules (real Canvas data), summarize progress, then ask
// Claude to (a) give a short progress read and (b) build a time-boxed plan
// using only real module items. Falls back to rule-based if no API key.
import { readState, env } from "../lib/lti.js";
import { parseCookies } from "../lib/lti.js";
import { getModules, summarizeProgress } from "../lib/canvas.js";

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
        /* expired/invalid -> treated as anonymous demo below */
      }
    }

    const { minutes = 30, message = "" } = req.body || {};
    // Course + student come from the LTI 1.1 launch custom fields (carried in
    // the signed session cookie). Fall back to env for local testing only.
    const courseId = ctx?.courseId || env("CANVAS_COURSE_ID", "");
    const studentId = ctx?.userId;
    if (!courseId) {
      res.status(400).json({ error: "No course context. Launch from Canvas." });
      return;
    }

    const modules = await getModules(courseId, studentId);
    const progress = summarizeProgress(modules);

    let result;
    if (process.env.ANTHROPIC_API_KEY) {
      result = await planWithClaude({ minutes, message, progress, ctx });
    } else {
      result = ruleBasedPlan({ minutes, progress });
    }

    res.status(200).json({ progress, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function planWithClaude({ minutes, message, progress, ctx }) {
  const model = env("ANTHROPIC_MODEL", "claude-sonnet-5");
  const system = `You are a calm, encouraging study coach embedded in a Canvas course home page.
You ONLY recommend from the provided real module items (use their exact titles and urls).
Be concise and warm. Never invent assignments. If the student is behind, prioritize overdue and soonest-due gradeable items.
Return STRICT JSON with this shape:
{
  "status_line": "one short sentence on how they're doing",
  "reason": "one short sentence explaining behind/on-track",
  "plan": [{"title": "...", "url": "...", "minutes": 10, "why": "short reason"}],
  "encouragement": "one short sentence"
}
The plan's minutes must sum to <= the available minutes.`;

  const payload = {
    availableMinutes: minutes,
    studentMessage: message,
    progress: {
      percentComplete: progress.percentComplete,
      overdueCount: progress.overdueCount,
      onTrack: progress.onTrack,
    },
    remainingItems: progress.remaining.slice(0, 40),
  };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages: [
        {
          role: "user",
          content: `Student ${ctx?.givenName || ""} has ${minutes} minutes.\nData:\n${JSON.stringify(payload)}`,
        },
      ],
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Anthropic ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = (data.content || []).map((c) => c.text || "").join("");
  const json = extractJson(text);
  return { source: "claude", ...json };
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in model output");
  return JSON.parse(text.slice(start, end + 1));
}

// Deterministic fallback so the POC works with no API key.
function ruleBasedPlan({ minutes, progress }) {
  const perItem = 12;
  const capacity = Math.max(1, Math.floor(minutes / perItem));
  const sorted = [...progress.remaining].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const da = a.dueAt ? Date.parse(a.dueAt) : Infinity;
    const db = b.dueAt ? Date.parse(b.dueAt) : Infinity;
    return da - db;
  });
  const picks = sorted.slice(0, capacity);
  const plan = picks.map((p) => ({
    title: p.title,
    url: p.url,
    minutes: Math.floor(minutes / Math.max(1, picks.length)),
    why: p.overdue ? "Overdue — clear this first" : "Due soon",
  }));
  const behind = progress.overdueCount > 0;
  return {
    source: "rule-based",
    status_line: `You're ${progress.percentComplete}% through this course.`,
    reason: behind
      ? `You have ${progress.overdueCount} item(s) past due — a little behind, but very catchable.`
      : `You're on track — nice work.`,
    plan,
    encouragement: `${minutes} focused minutes will move you forward. Let's go.`,
  };
}
