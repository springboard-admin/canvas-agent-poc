// M0 + M1-iter1 unit tests. Run: npm test  (node 18+; repo default node is v10, use v20)
// The Anthropic + edge-fn calls go through global fetch, which we stub per test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCoach, triage, crisisHandoff, normalize } from "../api/plan.js";
import { getPhaseProgress, getDashboardHealth } from "../lib/myprogress.js";

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.MYPROGRESS_URL = "https://example.supabase.co";
process.env.MYPROGRESS_ANON_KEY = "anon-test";

function toolUseResponse(input) {
  return { ok: true, json: async () => ({ content: [{ type: "tool_use", name: "respond", input }] }), text: async () => "" };
}
function noToolResponse() {
  return { ok: true, json: async () => ({ content: [{ type: "text", text: "prose not JSON" }] }), text: async () => "" };
}
function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => "" };
}
function stubFetch(responses) {
  const queue = [...responses];
  globalThis.fetch = async () => {
    if (!queue.length) throw new Error("unexpected extra fetch");
    return queue.shift();
  };
}

const coachArgs = () => ({
  messages: [
    { role: "user", content: "i want something to do" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "yeah give me a task" },
  ],
  energy: null,
  mode: "chat",
  daysAway: null,
  phase: { configured: true, journeyComplete: false, phasesDone: 1, totalPhases: 4, currentPhaseName: "Phase 2", focus: { name: "Phase 2", items: [] } },
  health: { overallHealth: 70, consistencyScore: 50, overdueCount: 0, upcomingCount: 2, weeklyTrend: "steady" },
  progressUnavailable: false,
  special: [],
  ctx: {},
});

// ---- M0 reliability + warmth ----

test("normalize never emits the old cheerful filler", () => {
  const out = normalize({});
  assert.notEqual(out.say, "I'm here whenever you want to make a little progress.");
  assert.equal(out.intent, "chat");
});

test("crisisHandoff returns a static support block, no task, no model call", () => {
  globalThis.fetch = async () => { throw new Error("crisis must not call the model"); };
  const out = crisisHandoff();
  assert.equal(out.source, "crisis");
  assert.equal(out.special.kind, "support");
  assert.equal(out.nextAction, null);
  assert.equal(out.plan, null);
  assert.equal(out.intent, "chat");
});

test("triage returns the model's label", async () => {
  stubFetch([toolUseResponse({ label: "distress" })]);
  assert.equal(await triage([{ role: "user", content: "life has been hard" }]), "distress");
});

test("triage fails safe to coach on error", async () => {
  globalThis.fetch = async () => { throw new Error("network down"); };
  assert.equal(await triage([{ role: "user", content: "whatever" }]), "coach");
});

test("distress hard-gates task even when the model returns one", async () => {
  stubFetch([toolUseResponse({ say: "That sounds heavy.", intent: "plan", nextAction: { title: "x", url: "u" }, plan: [{ title: "x" }] })]);
  const out = await runCoach({ ...coachArgs(), distress: true });
  assert.equal(out.nextAction, null);
  assert.equal(out.plan, null);
  assert.equal(out.intent, "chat");
});

test("honest snag after both attempts fail — never the filler", async () => {
  stubFetch([noToolResponse(), noToolResponse()]);
  const out = await runCoach({ ...coachArgs() });
  assert.equal(out.source, "error");
  assert.match(out.say, /snag/i);
  assert.equal(out.nextAction, null);
});

// ---- M1 iteration 1: single-source connectors ----

test("progressUnavailable gates the task even if the model returns one", async () => {
  stubFetch([toolUseResponse({ say: "Here's a task.", intent: "plan", nextAction: { title: "x", url: "u" } })]);
  const out = await runCoach({ ...coachArgs(), phase: null, health: null, progressUnavailable: true });
  assert.equal(out.nextAction, null);
  assert.equal(out.intent, "chat");
});

test("getPhaseProgress trims to headline + active-phase not-passed items", async () => {
  stubFetch([jsonResponse({
    configured: true,
    journeyComplete: false,
    phases: [
      { name: "P1", status: "done", items: [] },
      { name: "P2", status: "active", items: [
        { title: "Read A", url: "a", isPage: true, passed: false, done: false, thresholdType: "attempt" },
        { title: "Quiz A", url: "q", isPage: false, passed: false, done: false, thresholdType: "score" },
        { title: "Done B", url: "b", isPage: false, passed: true, done: true, thresholdType: "score" },
      ] },
      { name: "P3", status: "future", items: [] },
    ],
  })]);
  const p = await getPhaseProgress("c1", "u1");
  assert.equal(p.configured, true);
  assert.equal(p.phasesDone, 1);
  assert.equal(p.totalPhases, 3);
  assert.equal(p.currentPhaseName, "P2");
  assert.equal(p.focus.items.length, 2); // passed item excluded
  assert.equal(p.focus.items[0].title, "Read A");
  assert.equal(p.phaseMap.length, 3);
});

test("getPhaseProgress passes through configured:false", async () => {
  stubFetch([jsonResponse({ configured: false })]);
  assert.deepEqual(await getPhaseProgress("c1", "u1"), { configured: false });
});

test("getDashboardHealth exposes only the whitelisted keys", async () => {
  stubFetch([jsonResponse({
    user: { id: 1 }, courses: [], overallHealth: 82, completedItems: 9, totalItems: 20,
    overdueAssignments: 1, upcomingAssignments: 3,
    studyConsistency: { consistencyScore: 64, weeks: [] },
    weeklyBreakdown: [{ overallHealth: 70 }, { overallHealth: 76 }, { overallHealth: 82 }],
  })]);
  const h = await getDashboardHealth("c1", "u1");
  assert.deepEqual(Object.keys(h).sort(), ["consistencyScore", "overallHealth", "overdueCount", "upcomingCount", "weeklyTrend"]);
  assert.equal(h.overallHealth, 82);
  assert.equal(h.weeklyTrend, "improving"); // 70 -> 82
  assert.equal(h.completedItems, undefined); // headline % never leaks
});

test("connectors throw on non-2xx so the caller degrades honest-blind", async () => {
  // Readers throw; the handler wraps each in .catch(() => null) → honest-blind.
  stubFetch([jsonResponse({ error: "boom" }, false, 500)]);
  await assert.rejects(() => getPhaseProgress("c1", "u1"));
  stubFetch([jsonResponse({ error: "boom" }, false, 500)]);
  await assert.rejects(() => getDashboardHealth("c1", "u1"));
});
