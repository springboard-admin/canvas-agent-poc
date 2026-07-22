// Canvas REST API reads for the POC (manual API token).
// Docs: https://canvas.instructure.com/doc/api/modules.html
import { env } from "./lti.js";

function base() {
  return env("CANVAS_BASE_URL").replace(/\/$/, "");
}

async function canvasGet(path) {
  const url = `${base()}/api/v1${path}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${env("CANVAS_API_TOKEN")}` },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Canvas ${r.status} for ${path}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

// Pull modules + their items, plus completion state when available.
// include[]=items gives us items inline; include[]=content_details adds
// due dates / points; student_id lets us read per-student completion.
export async function getModules(courseId, studentId) {
  const parts = [
    "include[]=items",
    "include[]=content_details",
    "per_page=50",
  ];
  if (studentId) parts.push(`student_id=${encodeURIComponent(studentId)}`);
  const q = parts.join("&");
  const modules = await canvasGet(`/courses/${courseId}/modules?${q}`);

  return modules.map((m) => ({
    id: m.id,
    name: m.name,
    position: m.position,
    state: m.state || null, // locked | unlocked | started | completed
    completedAt: m.completed_at || null,
    items: (m.items || []).map((it) => ({
      id: it.id,
      title: it.title,
      type: it.type, // Assignment | Quiz | Page | File | Discussion | ...
      url: it.html_url,
      dueAt: it.content_details?.due_at || null,
      pointsPossible: it.content_details?.points_possible ?? null,
      completed: it.completion_requirement?.completed ?? null,
      requirementType: it.completion_requirement?.type || null,
    })),
  }));
}

// Roll modules into a compact progress read the LLM (or fallback) can reason on.
export function summarizeProgress(modules) {
  let totalItems = 0;
  let doneItems = 0;
  const now = Date.now();
  let overdue = 0;
  const remaining = [];

  for (const m of modules) {
    for (const it of m.items) {
      const gradeable = ["Assignment", "Quiz", "Discussion"].includes(it.type);
      totalItems += 1;
      const done = it.completed === true || m.state === "completed";
      if (done) {
        doneItems += 1;
        continue;
      }
      const due = it.dueAt ? Date.parse(it.dueAt) : null;
      if (due && due < now && gradeable) overdue += 1;
      remaining.push({
        module: m.name,
        title: it.title,
        type: it.type,
        url: it.url,
        dueAt: it.dueAt,
        overdue: due ? due < now : false,
      });
    }
  }

  const pct = totalItems ? Math.round((doneItems / totalItems) * 100) : 0;
  return {
    totalItems,
    doneItems,
    percentComplete: pct,
    overdueCount: overdue,
    onTrack: overdue === 0,
    remaining,
  };
}
