// My Progress connector — the one external source today. One student_progress fetch per turn
// backs every tool. All facts come from My Progress (deriveState/derivePhases read it; they
// never recompute its scoring). Card contents are built here from that authoritative data —
// the model only names a week/item; it never supplies card text.
import { getStudentProgress, deriveState, derivePhases, weekUrl, shortName } from "../myprogress.js";

async function fetch(ctx) {
  const sp = await getStudentProgress(ctx.courseId, ctx.studentId).catch(() => null);
  const status = deriveState(sp);
  return { sp, status, journey: derivePhases(sp), unavailable: status.state === "unknown" };
}

// ---- card builders (shared with the no-key fallback) --------------------------------
export function progressCard(status) {
  return { kind: "progress", view: status.view, label: status.label, score: status.score, scoreBand: status.scoreBand, gate: status.gate, passPercent: status.passPercent, dueCount: status.dueCount, doneCount: status.doneCount, rows: status.rows, next: status.next };
}
export function nextCard(status) {
  if (!status.next) return null;
  const n = status.next;
  // Item-level cutoff (the quiz's own pass bar), not the phase cumulative bar.
  return { kind: "next_step", title: n.title, url: n.url, week: n.week, score: n.score, outOf: n.outOf, needPct: n.need ?? status.passPercent };
}
function phasesCard(journey) {
  return { kind: "phases", currentPhaseName: journey.currentPhaseName, journeyComplete: journey.journeyComplete, phases: journey.phases };
}

const tools = [
  {
    def: { name: "get_progress", description: "Current progress: state, gate, passing cutoff, counts, cumulative score. For 'how am I doing' — answer in WORDS, don't dump the list.", input_schema: { type: "object", properties: {} } },
    run: (_i, d) => (d.unavailable ? { unavailable: true } : { state: d.status.state, label: d.status.label, gate: d.status.gate, passPercent: d.status.passPercent, dueCount: d.status.dueCount, doneCount: d.status.doneCount, score: d.status.score, scoreBand: d.status.scoreBand, next: d.status.next ? { title: d.status.next.title, week: d.status.next.week } : null }),
  },
  {
    def: { name: "get_week", description: "One week's items and how they did (score/out of/submitted/passed). For 'did I do week 2?', 'what's left in week 3?'.", input_schema: { type: "object", properties: { week: { type: "number" } }, required: ["week"] } },
    run: ({ week }, d) => { const w = (d.status.rows || []).find((x) => x.week === week); return w ? { week, items: w.items.map((i) => ({ name: i.name, score: i.score, outOf: i.outOf, complete: i.complete })) } : { found: false }; },
  },
  {
    def: { name: "find_item", description: "Search the student's items across weeks by name/keyword.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    run: ({ query }, d) => { const q = String(query || "").toLowerCase(); const hits = []; for (const w of d.status.rows || []) for (const i of w.items) if (i.name.toLowerCase().includes(q)) hits.push({ week: w.week, name: i.name, complete: i.complete }); return { matches: hits.slice(0, 12) }; },
  },
  {
    def: { name: "get_phases", description: "The whole journey across all phases (name, status, passed/required). For overall-journey reasoning.", input_schema: { type: "object", properties: {} } },
    run: (_i, d) => (d.journey.configured ? { currentPhaseName: d.journey.currentPhaseName, journeyComplete: d.journey.journeyComplete, phases: d.journey.phases } : { unavailable: true }),
  },
  {
    def: { name: "show_all_weeks", description: "Render the FULL week-by-week list (every item, score/required, clickable). ONLY when the student explicitly asks for the full list / all weeks / everything / details. NEVER for a general 'how am I doing'.", input_schema: { type: "object", properties: {} } },
    run: (_i, d, cards) => { if (d.unavailable) return { shown: false }; cards.push(progressCard(d.status)); return { shown: true }; },
  },
  {
    def: { name: "show_next_step", description: "Render the single next-step tile (next unfinished item + score + cutoff). ONLY when they ask what to do / for a task.", input_schema: { type: "object", properties: {} } },
    run: (_i, d, cards) => { const c = nextCard(d.status); if (!c) return { shown: false }; cards.push(c); return { shown: true }; },
  },
  {
    def: { name: "open_in_canvas", description: "Render a clickable card opening a week's Canvas module page in a new tab. For 'take me to week N', 'where do I study', 'open the module'.", input_schema: { type: "object", properties: { week: { type: "number" } }, required: ["week"] } },
    run: ({ week }, d, cards) => { const url = weekUrl(d.sp, week); if (!url) return { shown: false }; cards.push({ kind: "open", title: `Week ${week}`, url, week }); return { shown: true }; },
  },
  {
    def: { name: "show_phases", description: "Render the journey stepper (all phases, where they are, passed/required). For 'show my phases', 'overall journey'.", input_schema: { type: "object", properties: {} } },
    run: (_i, d, cards) => { if (!d.journey.configured) return { shown: false }; cards.push(phasesCard(d.journey)); return { shown: true }; },
  },
];

export const myprogress = { name: "myprogress", fetch, tools };
