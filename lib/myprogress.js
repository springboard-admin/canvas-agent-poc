// Single source of truth = the My Progress app's student_progress edge fn — the SAME
// authoritative output its own PhaseJourney UI uses. We read facts (gateMet, passedCount,
// cumulativeScore, per-item score/passed/url); we NEVER recompute its scoring or pass rules.
// Agent-side logic here is presentation only (grouping items into weeks, labels, next step).
import { env } from "./lti.js";

function base() {
  const url = env("MYPROGRESS_URL", "");
  const key = env("MYPROGRESS_ANON_KEY", "");
  if (!url || !key) return null; // feature-flagged off → honest-blind
  return { url: url.replace(/\/+$/, ""), key };
}

// One read: the whole journey (all phases) with per-item + per-subitem detail.
export async function getStudentProgress(courseId, studentId) {
  const b = base();
  if (!b) return null;
  const r = await fetch(
    `${b.url}/functions/v1/phase-config?action=student_progress&course_id=${encodeURIComponent(courseId)}&user_id=${encodeURIComponent(studentId)}`,
    { headers: { apikey: b.key, "content-type": "application/json" } },
  );
  if (!r.ok) throw new Error(`student_progress ${r.status}`);
  const d = await r.json();
  return d && d.configured ? d : { configured: false };
}

// Mirror My Progress's display shortening: long "Graded Quiz: … Grade for Week N" → "Graded Quiz".
export const shortName = (name) => (name && /graded quiz/i.test(name) ? "Graded Quiz" : name);
const weekNum = (title) => { const m = String(title || "").match(/week\s*(\d+)/i); return m ? parseInt(m[1], 10) : null; };

// The Curriculum phase (phase 0) as the agent's "status". All numbers here come straight from
// student_progress — passing, counts, cumulative score. Presentation only: week grouping, labels.
export function deriveState(sp) {
  if (!sp || !sp.configured || !Array.isArray(sp.phases) || !sp.phases.length) {
    return { state: "unknown", label: "I can't read your progress right now" };
  }
  const phase = sp.phases[0];
  const cumulative = phase.phaseClearMode === "cumulative";
  const cumulativeScore = typeof phase.cumulativeScore === "number" ? phase.cumulativeScore : null;
  const passPercent = cumulative ? (phase.phaseClearThreshold ?? 80) : 80;
  const passing = phase.gateMet === true;

  // Weeks = the phase's module items (skip pages); each carries its graded sub-items.
  const weeks = (phase.items || [])
    .filter((it) => !it.isPage)
    .map((it) => ({
      week: weekNum(it.title),
      moduleName: it.title,
      done: it.passed === true,
      items: (it.subItems || []).map((s) => ({
        name: shortName(s.title),
        url: s.url || null,
        complete: s.passed === true,
        submitted: s.done === true,
        score: typeof s.score === "number" ? s.score : null,
        outOf: s.points ?? null,
        need: typeof s.passThreshold === "number" ? s.passThreshold : null, // this item's own pass bar
      })),
    }))
    .filter((w) => w.items.length > 0); // drop empty (catch-up) weeks

  const dueCount = weeks.length;
  const doneCount = weeks.filter((w) => w.done).length;
  const passedCount = phase.passedCount ?? doneCount;
  const totalCount = (cumulative ? null : phase.requiredCount) ?? phase.totalCount ?? dueCount;
  const remaining = cumulative
    ? (passing ? 0 : Math.max(0, passPercent - (cumulativeScore ?? 0)))
    : Math.max(0, (totalCount ?? 0) - passedCount);

  const gate = {
    type: cumulative ? "cumulative" : (phase.gateType || "all_complete"),
    passedCount, totalCount, passThreshold: cumulative ? passPercent : null,
    gateMet: passing, remaining,
  };

  // First unfinished sub-item, in order — the one concrete next step (with its URL).
  let next = null;
  for (const w of weeks) {
    const s = w.items.find((i) => !i.complete);
    if (s) { next = { title: s.name, url: s.url, week: w.week, score: s.score, outOf: s.outOf, need: s.need }; break; }
  }

  let state, label;
  if (passing) { state = "caught_up"; label = "On track to pass — nice work"; }
  else if (!cumulative && phase.passedCount === 0) { state = "starting"; label = "Just getting started"; }
  else if (remaining <= 1) { state = "on_track"; label = "On track"; }
  else { state = "behind"; label = "Close — a bit still to pass"; }

  const scoreBand = cumulativeScore != null ? (cumulativeScore >= passPercent ? "good" : "warn") : null;

  return {
    state, label,
    view: "detailed", // no focus/grace machinery — words-only default handles discouragement
    gate, passPercent,
    dueCount, doneCount,
    score: cumulativeScore, scoreBand,
    next,
    facts: weeks.map((w) => ({ week: w.week, done: w.done, items: w.items.map((i) => ({ name: i.name, complete: i.complete, submitted: i.submitted, score: i.score, outOf: i.outOf })) })),
    rows: weeks.map((w) => ({ week: w.week, done: w.done, items: w.items.map((i) => ({ name: i.name, url: i.url, complete: i.complete, score: i.score, outOf: i.outOf, need: i.need })) })),
  };
}

// The whole journey (all phases) — for the phase stepper.
export function derivePhases(sp) {
  if (!sp || !sp.configured || !Array.isArray(sp.phases)) return { configured: false };
  const idx = typeof sp.currentPhaseIndex === "number" ? sp.currentPhaseIndex : sp.phases.findIndex((p) => p.status === "active");
  return {
    configured: true,
    journeyComplete: !!sp.journeyComplete,
    currentPhaseName: sp.phases[idx]?.name || null,
    phases: sp.phases.map((p, i) => ({
      name: p.name,
      status: p.status === "done" ? "done" : i === idx ? "active" : (p.status || "upcoming"),
      passedCount: p.passedCount ?? null,
      requiredCount: p.requiredCount ?? p.totalCount ?? null,
      gateMet: p.gateMet === true,
    })),
  };
}

// A week's module URL for "take me there" — the first sub-item's URL (the module page).
export function weekUrl(sp, week) {
  const phase = sp?.phases?.[0];
  const it = (phase?.items || []).find((x) => weekNum(x.title) === week);
  const s = (it?.subItems || []).find((x) => x.url);
  return s ? s.url : null;
}
