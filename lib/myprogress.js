// Connector to the "My Progress" app (student-greeting-hub): Supabase edge functions
// that compute the SAME progress + health the student already sees on screen. This is
// the single source of truth for progress — the agent must never contradict it.
// Both readers return null on any failure so the caller can degrade "honest-blind".
import { env } from "./lti.js";

function base() {
  const url = env("MYPROGRESS_URL", "");
  const key = env("MYPROGRESS_ANON_KEY", "");
  if (!url || !key) return null; // feature-flagged off → honest-blind
  return { url: url.replace(/\/+$/, ""), key };
}

async function edgeGet(path) {
  const b = base();
  if (!b) return null;
  const r = await fetch(`${b.url}/functions/v1/${path}`, {
    headers: { apikey: b.key, "content-type": "application/json" },
  });
  if (!r.ok) throw new Error(`myprogress ${r.status}`);
  return r.json();
}

// Headline journey — the phase stepper the student sees in My Progress.
// Trimmed to what the coach needs; `focus` replaces the old weekJourney.focusWeek.
export async function getPhaseProgress(courseId, studentId) {
  const data = await edgeGet(
    `phase-config?action=student_progress&course_id=${encodeURIComponent(courseId)}&user_id=${encodeURIComponent(studentId)}`,
  );
  if (!data) return null;
  if (data.configured === false) return { configured: false };
  const phases = Array.isArray(data.phases) ? data.phases : [];
  const active = phases.find((p) => p.status === "active") || null;
  const focus = active
    ? {
        name: active.name,
        items: (active.items || [])
          .filter((it) => !it.passed)
          .map((it) => ({
            title: it.title,
            url: it.url || null,
            isPage: !!it.isPage,
            thresholdType: it.thresholdType,
            passed: !!it.passed,
            done: !!it.done,
          })),
      }
    : null;
  return {
    configured: true,
    journeyComplete: !!data.journeyComplete,
    phasesDone: phases.filter((p) => p.status === "done").length,
    totalPhases: phases.length,
    currentPhaseName: active ? active.name : null,
    focus,
    // Compact per-phase map for the UI status card.
    phaseMap: phases.map((p) => ({
      name: p.name,
      passed: p.status === "done",
      focus: p.status === "active",
    })),
  };
}

// Health signals the phase journey lacks — from the same dashboard the student sees.
export async function getDashboardHealth(courseId, studentId) {
  const data = await edgeGet(
    `canvas-dashboard?userId=${encodeURIComponent(studentId)}&courseId=${encodeURIComponent(courseId)}`,
  );
  if (!data) return null;
  const wb = Array.isArray(data.weeklyBreakdown) ? data.weeklyBreakdown : [];
  const recent = wb
    .slice(-3)
    .map((w) => w.overallHealth)
    .filter((n) => typeof n === "number");
  let weeklyTrend = null;
  if (recent.length >= 2) {
    const d = recent[recent.length - 1] - recent[0];
    weeklyTrend = d > 3 ? "improving" : d < -3 ? "slipping" : "steady";
  }
  return {
    overallHealth: typeof data.overallHealth === "number" ? data.overallHealth : null,
    consistencyScore: data.studyConsistency?.consistencyScore ?? null,
    overdueCount: data.overdueAssignments ?? null,
    upcomingCount: data.upcomingAssignments ?? null,
    weeklyTrend,
  };
}
