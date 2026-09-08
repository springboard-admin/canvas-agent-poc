// M0 + M1 unit tests. Run: npm test  (node 18+; repo default node is v10, use v20)
// The Anthropic + edge-fn calls go through global fetch, which we stub per test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCoach, triage, crisisHandoff, normalize } from "../api/plan.js";
import { getCurriculumState, deriveState } from "../lib/myprogress.js";

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

// Shape mirrors the real curriculum_state payload (course 137 / user 187).
const csFixture = (over = {}) => ({
  configured: true,
  currentWeekNumber: 18,
  effectiveCurrentWeek: 18,
  preWeekOne: false,
  focusThreshold: 70,
  focusStartWeek: 2,
  cumulativeScore: 68,
  weeks: [
    { weekNumber: 1, moduleName: "Week 1 | Pharm", status: "past", isCatchUp: false, items: [{ name: "Quiz 1", url: "u1", complete: true }] },
    { weekNumber: 2, moduleName: "Week 2 | Pharm", status: "past", isCatchUp: false, items: [{ name: "Quiz 2", url: "u2", complete: false }] },
    { weekNumber: 9, moduleName: "Week 9 | Later", status: "future", isCatchUp: false, items: [{ name: "Quiz 9", url: "u9", complete: false }] },
  ],
  ...over,
});

const coachArgs = () => ({
  messages: [
    { role: "user", content: "i want something to do" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "yeah give me a task" },
  ],
  energy: null, mode: "chat", daysAway: null,
  status: deriveState(csFixture()),
  progressUnavailable: false,
  special: [], ctx: {},
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

test("distress forces show:none and no next step", async () => {
  stubFetch([toolUseResponse({ say: "That sounds heavy.", intent: "plan", show: "next" })]);
  const out = await runCoach({ ...coachArgs(), distress: true });
  assert.equal(out.show, "none");
  assert.equal(out.nextAction, null);
});

test("honest snag after both attempts fail — never the filler", async () => {
  stubFetch([noToolResponse(), noToolResponse()]);
  const out = await runCoach({ ...coachArgs() });
  assert.equal(out.source, "error");
  assert.match(out.say, /snag/i);
  assert.equal(out.nextAction, null);
});

// ---- M1: single-source state ----

test("show:next uses the authoritative item, never the model's", async () => {
  stubFetch([toolUseResponse({ say: "do this", intent: "plan", show: "next", nextAction: { title: "HALLUCINATED", url: "bad" } })]);
  const out = await runCoach({ ...coachArgs() });
  assert.equal(out.show, "next");
  assert.equal(out.nextAction.title, "Quiz 2");
  assert.equal(out.nextAction.url, "u2");
});

test("default show is none — no card unless the model asks", async () => {
  stubFetch([toolUseResponse({ say: "you took it, just under the bar", intent: "chat" })]);
  const out = await runCoach({ ...coachArgs() });
  assert.equal(out.show, "none");
  assert.equal(out.nextAction, null);
});

test("progressUnavailable forces show:none and no next step", async () => {
  stubFetch([toolUseResponse({ say: "Here's a task.", intent: "plan", show: "next" })]);
  const out = await runCoach({ ...coachArgs(), status: deriveState(null), progressUnavailable: true });
  assert.equal(out.show, "none");
  assert.equal(out.nextAction, null);
});

test("weekFacts carry per-item submitted/score for the model to reason over", () => {
  const s = deriveState(csFixture());
  const wk2 = s.facts.find((w) => w.week === 2);
  assert.equal(wk2.items[0].submitted, undefined); // fixture omits it → undefined ok
  assert.equal(wk2.done, false);
  assert.equal(s.facts.length, 2); // future week excluded
});

test("deriveState: due rows only, next = first unfinished item", () => {
  const s = deriveState(csFixture());
  assert.equal(s.dueCount, 2);      // future week excluded
  assert.equal(s.doneCount, 1);
  assert.equal(s.outstanding, 1);
  assert.equal(s.next.title, "Quiz 2");
  assert.equal(s.next.week, 2);
  assert.equal(s.belowBar, true);   // 68 < focusThreshold 70
  assert.equal(s.state, "off_track");
});

test("deriveState: above the bar and one outstanding = on_track", () => {
  const s = deriveState(csFixture({ cumulativeScore: 90 }));
  assert.equal(s.belowBar, false);
  assert.equal(s.state, "on_track");
});

test("deriveState: behind = focus view, score hidden, no rows", () => {
  const s = deriveState(csFixture({ cumulativeScore: 68 })); // < focusThreshold 70
  assert.equal(s.view, "focus");
  assert.equal(s.score, null);       // focus view hides the score, like the screen
  assert.equal(s.scoreBand, null);
  assert.equal(s.rows.length, 0);    // focus view shows only "next", not the list
  assert.ok(s.next);
});

test("deriveState: detailed view shows the score with the app's band", () => {
  const warn = deriveState(csFixture({ cumulativeScore: 75, passPercent: 80 }));
  assert.equal(warn.view, "detailed"); // 75 >= focusThreshold 70
  assert.equal(warn.score, 75);
  assert.equal(warn.scoreBand, "warn"); // 75 < passPercent 80
  const good = deriveState(csFixture({ cumulativeScore: 85, passPercent: 80 }));
  assert.equal(good.scoreBand, "good");
  assert.ok(good.rows.length > 0);
});

test("deriveState: grace window suppresses any verdict", () => {
  const s = deriveState(csFixture({ currentWeekNumber: 2 }));
  assert.equal(s.state, "starting");
});

test("deriveState: nothing outstanding = caught_up", () => {
  const cs = csFixture();
  cs.weeks[1].items[0].complete = true;
  const s = deriveState({ ...cs, cumulativeScore: 90 });
  assert.equal(s.state, "caught_up");
  assert.equal(s.next, null);
});

test("deriveState: unreadable progress = unknown", () => {
  assert.equal(deriveState(null).state, "unknown");
  assert.equal(deriveState({ configured: false }).state, "unknown");
});

test("getCurriculumState throws on non-2xx so the caller degrades honest-blind", async () => {
  stubFetch([jsonResponse({ error: "boom" }, false, 500)]);
  await assert.rejects(() => getCurriculumState("137", "187"));
});
