// Connector to the "My Progress" app (student-greeting-hub).
// ONE read: phase-config?action=curriculum_state — the same numbers and rows the
// student sees in CurriculumView. We never re-derive progress locally, so the agent
// can't contradict the screen. Returns null on failure → caller degrades honest-blind.
import { env } from "./lti.js";

function base() {
  const url = env("MYPROGRESS_URL", "");
  const key = env("MYPROGRESS_ANON_KEY", "");
  if (!url || !key) return null; // feature-flagged off → honest-blind
  return { url: url.replace(/\/+$/, ""), key };
}

export async function getCurriculumState(courseId, studentId) {
  const b = base();
  if (!b) return null;
  const r = await fetch(
    `${b.url}/functions/v1/phase-config?action=curriculum_state&course_id=${encodeURIComponent(courseId)}&user_id=${encodeURIComponent(studentId)}`,
    { headers: { apikey: b.key, "content-type": "application/json" } },
  );
  if (!r.ok) throw new Error(`curriculum_state ${r.status}`);
  const d = await r.json();
  return d && d.configured ? d : { configured: false };
}

// A row counts as done when every tracked item in it is complete (app's own rule).
const rowDone = (w) => w.items.length > 0 && w.items.every((i) => i.complete);

// Mirror My Progress's display shortening: the long "Graded Quiz: … Grade for Week N …"
// Canvas names collapse to just "Graded Quiz" on screen. Keep other (already short) names.
const shortName = (name) => (name && /graded quiz/i.test(name) ? "Graded Quiz" : name);

// How many more are needed to satisfy the phase's pass gate (varies by config).
function gateRemaining(g) {
  if (!g) return null;
  if (g.type === "all_complete") return Math.max(0, (g.totalCount ?? 0) - (g.passedCount ?? 0));
  if (g.type === "pass_count") return Math.max(0, (g.required ?? 0) - (g.passedCount ?? 0));
  if (g.type === "cumulative") return g.gateMet ? 0 : Math.max(0, (g.passThreshold ?? 0) - (g.cumulativeScore ?? 0));
  return null;
}

// Deterministic state. Pure — no model involved, so it can never drift or hallucinate.
// Two axes, per the agreed model:
//   pace        = due config rows outstanding (NOT calendar weeks — configs have gaps)
//   performance = cumulativeScore vs the course's own focusThreshold
// Pace/performance verdicts are suppressed during the configured grace window.
export function deriveState(cs) {
  if (!cs || !cs.configured) return { state: "unknown", label: "I can't read your progress right now" };

  const due = (cs.weeks || []).filter((w) => w.status !== "future");
  const done = due.filter(rowDone).length;
  const outstanding = due.length - done;
  const belowBar = typeof cs.cumulativeScore === "number" && cs.cumulativeScore < cs.focusThreshold;

  // First unfinished item, in config order — the one concrete next step.
  let next = null;
  for (const w of due) {
    const item = w.items.find((i) => !i.complete);
    if (item) {
      next = { title: shortName(item.name), url: item.url, week: w.weekNumber, module: w.moduleName };
      break;
    }
  }

  const inGrace = cs.preWeekOne === true || cs.currentWeekNumber <= (cs.focusStartWeek ?? 2);

  // The pass GATE is authoritative for "are you passing" — it varies by course
  // (all_complete = every module; pass_count = K of N; cumulative = score >= X). We fall
  // back to "no items outstanding" only when the config carries no gate.
  const g = cs.gate || null;
  const gate = g
    ? { type: g.type, passedCount: g.passedCount, totalCount: g.totalCount, required: g.required ?? null, passThreshold: g.passThreshold ?? null, gateMet: g.gateMet === true, remaining: gateRemaining(g) }
    : null;
  const passing = gate ? gate.gateMet : outstanding === 0;
  // How many remain to pass — the gate's count when we have it, else pace outstanding.
  const remain = gate ? (gate.remaining ?? outstanding) : outstanding;

  // View mirrors My Progress: behind (low score) past the grace window → Focus view, which
  // HIDES the score and shows only the next step. Same primitives the app uses; we never
  // read its internal focus flag.
  const behind = !inGrace && belowBar && !passing;
  const view = behind ? "focus" : "detailed";

  let state, label;
  if (inGrace) {
    state = "starting";
    label = "Just getting started";
  } else if (due.length === 0) {
    state = "nothing_due";
    label = "Nothing due yet";
  } else if (passing) {
    state = "caught_up";
    label = "On track to pass — nice work";
  } else if (behind) {
    state = "off_track";
    label = "A bit behind — but you can still catch up";
  } else if (remain <= 1) {
    state = "on_track";
    label = "On track";
  } else {
    state = "behind";
    label = "Close — a few still to pass";
  }

  // Score shown ONLY in Detailed view (Focus view hides it), with the app's own band.
  const pass = cs.passPercent ?? 80;
  const showScore = view === "detailed" && typeof cs.cumulativeScore === "number";
  const score = showScore ? cs.cumulativeScore : null;
  const scoreBand = showScore ? (score >= pass ? "good" : "warn") : null;

  return {
    state,
    label,
    view,
    gate, // how the phase is passed + how many remain — for gate-aware coaching
    dueCount: due.length,
    doneCount: done,
    outstanding,
    belowBar,
    score,
    scoreBand,
    next,
    // Compact per-week facts for the MODEL to reason over ("did I do week 2?"). Always
    // present, both views. Small. The model reads these; it never recomputes them.
    facts: due.map((w) => ({
      week: w.weekNumber,
      done: rowDone(w),
      items: w.items.map((i) => ({
        name: shortName(i.name),
        complete: i.complete,
        submitted: i.submitted,
        score: i.earnedScore,
        outOf: i.requiredScore,
      })),
    })),
    // Detailed view shows the full week list; Focus view shows only the next step.
    // Each item carries its score/required so the card shows "35 / 100 · need 80%".
    rows: view === "detailed"
      ? due.map((w) => ({
          week: w.weekNumber,
          done: rowDone(w),
          items: w.items.map((i) => ({ name: shortName(i.name), url: i.url, complete: i.complete, score: i.earnedScore, outOf: i.requiredScore })),
        }))
      : [],
    passPercent: cs.passPercent ?? 80,
  };
}
