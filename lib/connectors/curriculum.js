// Curriculum connector — wraps the "My Progress" app as a set of agent tools.
// One fetch per turn (memoized in ctx.cache), then all tools are LOCAL pure functions
// over that data. Item URLs already ARE Canvas module pages, so navigation needs no
// extra fetch. Card CONTENTS are built here from authoritative data — the model only
// names which week/item; it can never supply card text.
import { getCurriculumState, deriveState, shortName } from "../myprogress.js";

async function fetch(ctx) {
  const cs = await getCurriculumState(ctx.courseId, ctx.studentId).catch(() => null);
  const status = deriveState(cs);
  return { status, cs, unavailable: status.state === "unknown" };
}

// ---- card builders (shared with the no-key fallback) --------------------------------
export function progressCard(status) {
  return {
    kind: "progress",
    view: status.view,
    label: status.label,
    score: status.score,
    scoreBand: status.scoreBand,
    gate: status.gate,
    passPercent: status.passPercent,
    dueCount: status.dueCount,
    doneCount: status.doneCount,
    rows: status.rows,
    next: status.next,
  };
}
export function nextCard(status) {
  if (!status.next) return null;
  const n = status.next;
  return { kind: "next_step", title: n.title, url: n.url, week: n.week, score: n.score, outOf: n.outOf, needPct: status.passPercent };
}
function weekUrl(cs, week) {
  const w = (cs?.weeks || []).find((x) => x.weekNumber === week);
  if (!w || !w.items.length) return null;
  return (w.items.find((i) => !i.complete && i.url) || w.items.find((i) => i.url) || {}).url || null;
}

// ---- tools --------------------------------------------------------------------------
const tools = [
  {
    def: { name: "get_progress", description: "The student's current progress state (state, label, view, gate, passing cutoff, counts, score). Call this to answer 'how am I doing'.", input_schema: { type: "object", properties: {} } },
    run: (_i, d) => (d.unavailable ? { unavailable: true } : {
      state: d.status.state, label: d.status.label, view: d.status.view, gate: d.status.gate,
      passPercent: d.status.passPercent, dueCount: d.status.dueCount, doneCount: d.status.doneCount,
      score: d.status.score, scoreBand: d.status.scoreBand,
      next: d.status.next ? { title: d.status.next.title, week: d.status.next.week } : null,
    }),
  },
  {
    def: { name: "get_week", description: "The items in one week and how the student did on each (score, out of, submitted, passed). Use to answer 'did I do week N' / 'what's left in week N'.", input_schema: { type: "object", properties: { week: { type: "number" } }, required: ["week"] } },
    run: ({ week }, d) => {
      const w = (d.cs?.weeks || []).find((x) => x.weekNumber === week);
      if (!w) return { found: false };
      return { week, items: w.items.map((i) => ({ name: shortName(i.name), score: i.earnedScore, outOf: i.requiredScore, submitted: i.submitted, complete: i.complete })) };
    },
  },
  {
    def: { name: "find_item", description: "Search the student's tracked items across all weeks by name/keyword.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    run: ({ query }, d) => {
      const q = String(query || "").toLowerCase();
      const hits = [];
      for (const w of d.cs?.weeks || []) for (const i of w.items) if (i.name.toLowerCase().includes(q)) hits.push({ week: w.weekNumber, name: shortName(i.name), complete: i.complete });
      return { matches: hits.slice(0, 12) };
    },
  },
  {
    def: { name: "show_all_weeks", description: "Render the FULL week-by-week list (every module, score/required, clickable). ONLY when the student explicitly asks for the full list / all weeks / to see everything / the details. A general 'how am I doing' should be answered in words, NOT with this.", input_schema: { type: "object", properties: {} } },
    run: (_i, d, cards) => { if (d.unavailable) return { shown: false }; cards.push(progressCard(d.status)); return { shown: true }; },
  },
  {
    def: { name: "show_next_step", description: "Render the single next-step tile (the next unfinished item with its score and passing cutoff). Use when they ask what to do next.", input_schema: { type: "object", properties: {} } },
    run: (_i, d, cards) => { const c = nextCard(d.status); if (!c) return { shown: false }; cards.push(c); return { shown: true }; },
  },
  {
    def: { name: "open_in_canvas", description: "Render a clickable card that opens a week's module page in Canvas (new tab). Use for 'take me to week N' or 'where do I study for this'.", input_schema: { type: "object", properties: { week: { type: "number" } }, required: ["week"] } },
    run: ({ week }, d, cards) => {
      const url = weekUrl(d.cs, week);
      if (!url) return { shown: false };
      cards.push({ kind: "open", title: `Week ${week}`, url, week });
      return { shown: true };
    },
  },
];

export const curriculum = { name: "curriculum", fetch, tools };
