// Week-by-week journey model — ported from the Springboard canvas-dashboard edge
// function (student-greeting-hub) so this agent uses the SAME mappings/hardcodings.
// Rule (per product owner): a week is "passed" when EVERY non-practice graded item
// in its module scores >= 70% (practice items only need an attempt). Module-item
// engagement/completion is irrelevant to pass/fail — only graded quiz scores matter.
import { env } from "./lti.js";

const PASS_FRACTION = 0.7; // curriculum-config.ts passFraction

function base() {
  return env("CANVAS_BASE_URL").replace(/\/$/, "");
}

// Fetch with Bearer token + follow Canvas Link-header pagination.
async function fetchAllPages(path) {
  const token = env("CANVAS_API_TOKEN");
  let url = `${base()}/api/v1${path}`;
  const out = [];
  for (let guard = 0; guard < 20 && url; guard++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`Canvas ${r.status} for ${path}: ${t.slice(0, 160)}`);
    }
    const page = await r.json();
    if (Array.isArray(page)) out.push(...page);
    url = nextLink(r.headers.get("link"));
  }
  return out;
}

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

// ---- ported helpers ----
function extractWeekNumber(moduleName) {
  const combined = moduleName.match(/^Weeks?\s+(\d+)\s*\+\s*(\d+)/i);
  if (combined) return { weekNumber: parseInt(combined[1], 10), isCombined: true };
  const single = moduleName.match(/^Weeks?\s+(\d+)(?:\s*[|\-:]|$|\s)/i);
  if (single) return { weekNumber: parseInt(single[1], 10), isCombined: false };
  return null;
}
function isCatchUpModule(name) {
  return name.toLowerCase().includes("catch");
}
function isLiveSessionAssignment(a) {
  const n = (a.name || "").toLowerCase();
  return (
    n.includes("live session") ||
    n.includes("attendance") ||
    n.includes("attend ") ||
    n.includes("zoom session") ||
    a.points_possible === 1
  );
}
function isGradedItemType(item) {
  return item.type === "Assignment" || item.type === "Quiz";
}
function isGradedAssignment(a) {
  return (a.points_possible ?? 0) > 0;
}
function isPracticeItem(name) {
  return (name || "").toLowerCase().includes("practice");
}
// Canvas sometimes puts the graded value in `grade` (percent/letter) not `score`.
function effectiveScore(score, grade, pointsPossible) {
  if (score !== null && score !== undefined) return score;
  if (grade === null || grade === undefined) return null;
  const g = String(grade).trim();
  if (g === "") return null;
  if (g.endsWith("%")) {
    const pct = parseFloat(g.slice(0, -1));
    if (!isFinite(pct)) return null;
    return (pct / 100) * (pointsPossible ?? 100);
  }
  const num = parseFloat(g);
  if (isFinite(num) && /^-?\d*\.?\d+$/.test(g)) return num;
  return null;
}

// Reading = the module's non-graded, consumable items (textbook pages, D2L links, files).
function isReadingItem(item) {
  return ["Page", "ExternalUrl", "ExternalTool", "File"].includes(item.type);
}

// Main: build the week journey for a student.
export async function getWeekJourney(courseId, studentId) {
  const [modules, rawAssignments, submissions] = await Promise.all([
    fetchAllPages(`/courses/${courseId}/modules?include[]=items&student_id=${studentId}&per_page=100`),
    fetchAllPages(`/courses/${courseId}/assignments?per_page=100`),
    fetchAllPages(`/courses/${courseId}/students/submissions?student_ids[]=${studentId}&per_page=100`).catch(() => []),
  ]);

  // Merge submissions into assignments.
  const subByAssignment = new Map();
  submissions.forEach((s) => subByAssignment.set(s.assignment_id, s));
  const assignments = rawAssignments.map((a) => {
    const sub = subByAssignment.get(a.id);
    return sub ? { ...a, submission: { score: sub.score, grade: sub.grade, submitted_at: sub.submitted_at } } : { ...a };
  });

  const byId = new Map();
  const byQuizId = new Map();
  const byName = new Map();
  assignments.forEach((a) => {
    byId.set(a.id, a);
    if (a.quiz_id) byQuizId.set(a.quiz_id, a);
    byName.set((a.name || "").toLowerCase().trim(), a);
  });

  const canvasBase = base();
  const sorted = [...modules].sort((a, b) => (a.position || 0) - (b.position || 0));
  let lastSeenWeek = 0;
  const weeks = [];

  for (const module of sorted) {
    const isCatchUp = isCatchUpModule(module.name);
    const wr = extractWeekNumber(module.name);
    if (wr === null && !isCatchUp) continue;
    const weekNumber = wr ? wr.weekNumber : lastSeenWeek + 0.5;
    const isCombined = wr ? wr.isCombined : false;
    if (wr) lastSeenWeek = isCombined ? wr.weekNumber + 1 : wr.weekNumber;

    const items = module.items || [];
    const gradedItems = [];
    const reading = [];

    for (const item of items) {
      if (isReadingItem(item)) {
        reading.push({ title: item.title, url: item.html_url, type: item.type });
        continue;
      }
      let a;
      if (item.content_id) {
        a = byId.get(item.content_id);
        if (!a && item.type === "Quiz") a = byQuizId.get(item.content_id);
      }
      if (!a) a = byName.get((item.title || "").toLowerCase().trim());

      if (isGradedItemType(item) && a && !isLiveSessionAssignment(a) && isGradedAssignment(a)) {
        const maxScore = a.points_possible ?? 100;
        const score = effectiveScore(a.submission?.score, a.submission?.grade, a.points_possible);
        const percentage = score !== null ? (score / maxScore) * 100 : null;
        gradedItems.push({
          title: item.title,
          percentage,
          isPractice: isPracticeItem(item.title),
          url: `${canvasBase}/courses/${courseId}/assignments/${a.id}`,
        });
      }
    }

    if (gradedItems.length === 0 && !isCatchUp) continue;

    // Pass = every non-practice graded item >= 70%; practice items just need an attempt.
    const passed =
      gradedItems.length > 0 &&
      gradedItems.every((g) =>
        g.isPractice ? g.percentage !== null : g.percentage !== null && g.percentage >= PASS_FRACTION * 100
      );

    weeks.push({
      weekNumber,
      moduleName: isCombined ? `Week ${weekNumber} + ${weekNumber + 1}` : module.name,
      passed,
      isCatchUp,
      reading,
      quizzes: gradedItems.filter((g) => !g.isPractice),
      gradedItems,
    });
  }

  weeks.sort((a, b) => a.weekNumber - b.weekNumber);

  const trackable = weeks.filter((w) => w.gradedItems.length > 0);
  const weeksPassed = trackable.filter((w) => w.passed).length;
  const totalWeeks = trackable.length;
  const focus = weeks.find((w) => !w.passed && w.gradedItems.length > 0) || null;

  return {
    weeks,
    totalWeeks,
    weeksPassed,
    percentComplete: totalWeeks ? Math.round((weeksPassed / totalWeeks) * 100) : 0,
    focusWeek: focus
      ? {
          weekNumber: focus.weekNumber,
          moduleName: focus.moduleName,
          reading: focus.reading,
          quiz: focus.quizzes[0] || null,
          quizzesPassed: focus.quizzes.every((q) => q.percentage !== null && q.percentage >= PASS_FRACTION * 100),
        }
      : null,
    passThresholdPercent: PASS_FRACTION * 100,
  };
}
