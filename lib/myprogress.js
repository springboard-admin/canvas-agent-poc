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

// The pass rule for a unit (a phase module + its graded sub-items). Practice exams are
// "pass K of N, attempt all"; lab skills are "pass all N"; a single-item unit speaks for itself.
function unitRequirement(it, n) {
  if (it.requiredPassCount != null) {
    let r = `pass ${it.requiredPassCount} of ${n}`;
    if (it.requireAllAttempted) r += `, attempt all ${n}`;
    return r;
  }
  return n > 1 ? `pass all ${n}` : null;
}

// The ACTIVE phase (currentPhaseIndex) as the agent's "status" — so the agent follows the
// student past Curriculum into Exam Prep / ExCPT Exam / Externship, not just phase 0. All
// numbers come straight from student_progress; presentation only (week grouping, labels).
export function deriveState(sp) {
  if (!sp || !sp.configured || !Array.isArray(sp.phases) || !sp.phases.length) {
    return { state: "unknown", label: "I can't read your progress right now" };
  }
  const total = sp.phases.length;
  let idx = typeof sp.currentPhaseIndex === "number" ? sp.currentPhaseIndex : sp.phases.findIndex((p) => p.status === "active");
  if (!(idx >= 0 && idx < total)) idx = Math.min(Math.max(idx || 0, 0), total - 1);
  const phase = sp.phases[idx];
  const base = { phaseName: phase.name, phaseIndex: idx, totalPhases: total, journeyComplete: !!sp.journeyComplete };
  const blank = { view: "detailed", gate: null, passPercent: null, dueCount: 0, doneCount: 0, score: null, scoreBand: null, next: null, guidance: null, facts: [], rows: [] };

  // Whole journey finished.
  if (sp.journeyComplete) {
    return { ...base, ...blank, state: "complete", label: "You've finished the whole journey — congratulations" };
  }

  // Informational / no-graded-items phase (e.g. "register for your exam", "watch for the email").
  // The "next step" is the phase's own guidance text, not a quiz.
  const gradedItems = (phase.items || []).filter((it) => !it.isPage);
  if (phase.informationalOnly === true || gradedItems.length === 0) {
    const guidance = phase.informationalContent?.body || phase.comingSoon?.body || null;
    return { ...base, ...blank, state: "informational", label: phase.name, guidance };
  }

  // Graded phase (Curriculum, or any item-based phase) — weekly logic on the ACTIVE phase.
  const cumulative = phase.phaseClearMode === "cumulative";
  const cumulativeScore = typeof phase.cumulativeScore === "number" ? phase.cumulativeScore : null;
  const passPercent = cumulative ? (phase.phaseClearThreshold ?? 80) : 80;
  const passing = phase.gateMet === true;

  // Units = the phase's module items (skip pages), each with its graded sub-items and its own
  // pass rule. Curriculum weeks, practice-exam modules and lab-skill modules all fit here.
  const units = gradedItems
    .map((it) => {
      const items = (it.subItems || []).map((s) => ({
        name: shortName(s.title),
        url: s.url || null,
        complete: s.passed === true,
        submitted: s.done === true,
        score: typeof s.score === "number" ? s.score : null,
        outOf: s.points ?? null,
        need: typeof s.passThreshold === "number" ? s.passThreshold : null, // this item's own pass bar
      }));
      return {
        week: weekNum(it.title),
        name: shortName(it.title),
        requirement: unitRequirement(it, items.length),
        done: it.passed === true,
        passedSubs: items.filter((i) => i.complete).length,
        attemptedSubs: items.filter((i) => i.submitted).length,
        totalSubs: items.length,
        items,
      };
    })
    .filter((u) => u.items.length > 0); // drop empty (catch-up) units

  const guidance = phase.comingSoon?.body || phase.informationalContent?.body || null;
  const dueCount = units.length;
  const doneCount = units.filter((u) => u.done).length;
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
  for (const u of units) {
    const s = u.items.find((i) => !i.complete);
    if (s) { next = { title: s.name, url: s.url, week: u.week, unit: u.name, score: s.score, outOf: s.outOf, need: s.need }; break; }
  }

  let state, label;
  if (passing) { state = "caught_up"; label = "On track to pass — nice work"; }
  else if (!cumulative && phase.passedCount === 0) { state = "starting"; label = "Just getting started"; }
  else if (remaining <= 1) { state = "on_track"; label = "On track"; }
  else { state = "behind"; label = "Close — a bit still to pass"; }

  const scoreBand = cumulativeScore != null ? (cumulativeScore >= passPercent ? "good" : "warn") : null;

  return {
    ...base,
    state, label,
    view: "detailed", // no focus/grace machinery — words-only default handles discouragement
    gate, passPercent,
    dueCount, doneCount,
    score: cumulativeScore, scoreBand,
    guidance,
    next,
    // Compact per-unit summary for the model to state the exact requirement + progress.
    units: units.map((u) => ({ name: u.name, requirement: u.requirement, passed: u.passedSubs, attempted: u.attemptedSubs, total: u.totalSubs, done: u.done })),
    facts: units.map((u) => ({ week: u.week, name: u.name, done: u.done, items: u.items.map((i) => ({ name: i.name, complete: i.complete, submitted: i.submitted, score: i.score, outOf: i.outOf })) })),
    rows: units.map((u) => ({ week: u.week, name: u.name, requirement: u.requirement, done: u.done, items: u.items.map((i) => ({ name: i.name, url: i.url, complete: i.complete, score: i.score, outOf: i.outOf, need: i.need })) })),
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
