// Engagement connector — reuses My Progress's canvas-dashboard (study consistency, overdue,
// upcoming, recent health trend). Lazy: only fetched when get_engagement is called. This is
// the seed of the future disengagement signal for proactive outreach.
import { env } from "../lti.js";

async function fetch(ctx) {
  const url = env("MYPROGRESS_URL", "");
  const key = env("MYPROGRESS_ANON_KEY", "");
  if (!url || !key) return { unavailable: true };
  try {
    const r = await globalThis.fetch(
      `${url.replace(/\/+$/, "")}/functions/v1/canvas-dashboard?userId=${encodeURIComponent(ctx.studentId)}&courseId=${encodeURIComponent(ctx.courseId)}`,
      { headers: { apikey: key, "content-type": "application/json" } },
    );
    if (!r.ok) throw new Error(`canvas-dashboard ${r.status}`);
    const d = await r.json();
    const wb = Array.isArray(d.weeklyBreakdown) ? d.weeklyBreakdown : [];
    const recent = wb.slice(-3).map((w) => w.overallHealth).filter((n) => typeof n === "number");
    let trend = null;
    if (recent.length >= 2) { const x = recent[recent.length - 1] - recent[0]; trend = x > 3 ? "improving" : x < -3 ? "slipping" : "steady"; }
    return { engagement: { consistencyScore: d.studyConsistency?.consistencyScore ?? null, overdue: d.overdueAssignments ?? null, upcoming: d.upcomingAssignments ?? null, trend } };
  } catch {
    return { unavailable: true };
  }
}

const tools = [
  {
    def: { name: "get_engagement", description: "How engaged the student is: study consistency (0-100), overdue/upcoming counts, recent momentum trend. For 'how engaged am I' and gauging whether they're slipping.", input_schema: { type: "object", properties: {} } },
    run: (_i, d) => (d.unavailable ? { unavailable: true } : d.engagement),
  },
];

export const engagement = { name: "engagement", fetch, tools };
