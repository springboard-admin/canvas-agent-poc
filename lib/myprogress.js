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
      next = { title: item.name, url: item.url, week: w.weekNumber, module: w.moduleName };
      break;
    }
  }

  const inGrace = cs.preWeekOne === true || cs.currentWeekNumber <= (cs.focusStartWeek ?? 2);
  let state, label;
  if (inGrace) {
    state = "starting";
    label = "Just getting started";
  } else if (due.length === 0) {
    state = "nothing_due";
    label = "Nothing due yet";
  } else if (outstanding === 0) {
    state = "caught_up";
    label = "All caught up";
  } else if (belowBar) {
    state = "off_track";
    label = "Let's get you back on track";
  } else if (outstanding > 1) {
    state = "behind";
    label = "A bit behind — catch up this week";
  } else {
    state = "on_track";
    label = "On track";
  }

  return {
    state,
    label,
    dueCount: due.length,
    doneCount: done,
    outstanding,
    belowBar,
    next,
    // Rows for the UI — mirrors the student's own view, clickable.
    rows: due.map((w) => ({
      week: w.weekNumber,
      module: w.moduleName,
      done: rowDone(w),
      items: w.items.map((i) => ({ name: i.name, url: i.url, complete: i.complete })),
    })),
  };
}
