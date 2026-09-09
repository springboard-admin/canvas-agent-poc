// Agent (tool-use loop) + connector tests. Run: npm test (node 18+; repo default is v10 — use v20)
// global fetch is stubbed and ROUTED: anthropic.com → scripted model turns; else → the
// curriculum_state edge-fn fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, triage, advisingHandoff, fallbackCoach } from "../api/plan.js";
import { deriveState } from "../lib/myprogress.js";
import { toolDefs, runTool, makeToolCtx } from "../lib/connectors/index.js";

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.MYPROGRESS_URL = "https://example.supabase.co";
process.env.MYPROGRESS_ANON_KEY = "anon-test";

// --- fixtures ---
const CS = () => ({
  configured: true, currentWeekNumber: 18, effectiveCurrentWeek: 18, preWeekOne: false,
  passPercent: 80, focusThreshold: 70, focusStartWeek: 2, cumulativeScore: 80,
  gate: { type: "all_complete", passedCount: 11, totalCount: 16, gateMet: false },
  weeks: [
    { weekNumber: 1, moduleName: "Week 1", status: "past", isCatchUp: false, items: [{ id: 11, name: "Graded Quiz: Pharmacology ... Grade for Week 1", url: "u1", earnedScore: 80, requiredScore: 100, submitted: true, complete: true }] },
    { weekNumber: 2, moduleName: "Week 2", status: "past", isCatchUp: false, items: [{ id: 12, name: "Graded Quiz: Pharmacology ... Grade for Week 2", url: "u2", earnedScore: 35, requiredScore: 100, submitted: true, complete: false }] },
    { weekNumber: 5, moduleName: "Week 5 | Pharm Law", status: "past", isCatchUp: false, items: [{ id: 15, name: "Graded Quiz: Pharmacy Law", url: "u5", earnedScore: null, requiredScore: 100, submitted: false, complete: false }] },
  ],
});

// model turn helpers
const toolUse = (name, input, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
const finalText = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
const classify = (label) => ({ content: [{ type: "tool_use", id: "c", name: "classify", input: { label } }], stop_reason: "tool_use" });

// Route fetch: model turns (from a queue; last repeats) for anthropic, else the cs fixture.
function route({ model = [], cs = CS() } = {}) {
  const q = [...model];
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.anthropic.com")) {
      const next = q.length > 1 ? q.shift() : q[0];
      return { ok: true, json: async () => next, text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => cs, text: async () => "" };
  };
}

const agentArgs = (over = {}) => ({ messages: [{ role: "user", content: "hi" }], mode: "chat", daysAway: null, courseId: "137", studentId: "187", ctx: {}, ...over });

// --- agent loop ---

test("model reasons over get_week and answers in words, no card", async () => {
  route({ model: [toolUse("get_week", { week: 2 }), finalText("You took it — scored 35, under the bar, so a retake would count it.")] });
  const out = await runAgent(agentArgs());
  assert.match(out.say, /35/);
  assert.equal(out.cards.length, 0);
});

test("show_next_step renders the AUTHORITATIVE tile, not the model's words", async () => {
  route({ model: [toolUse("show_next_step", {}), finalText("Here's the smallest win.")] });
  const out = await runAgent(agentArgs());
  const tile = out.cards.find((c) => c.kind === "next_step");
  assert.equal(tile.title, "Graded Quiz"); // shortened + authoritative
  assert.equal(tile.week, 2);
  assert.equal(tile.score, 35);
  assert.equal(tile.needPct, 80);
});

test("open_in_canvas renders a card with the real module URL", async () => {
  route({ model: [toolUse("open_in_canvas", { week: 2 }), finalText("Here you go.")] });
  const out = await runAgent(agentArgs());
  const open = out.cards.find((c) => c.kind === "open");
  assert.equal(open.url, "u2");
  assert.equal(open.week, 2);
});

test("distress drops task/open cards but keeps the reply", async () => {
  route({ model: [toolUse("show_next_step", {}), finalText("I hear you.")] });
  const out = await runAgent(agentArgs({ distress: true }));
  assert.equal(out.cards.find((c) => c.kind === "next_step"), undefined);
  assert.match(out.say, /hear you/i);
});

test("curriculum unavailable → tool reports it, agent still replies", async () => {
  route({ model: [toolUse("get_progress", {}), finalText("I can't read your progress right now.")], cs: { configured: false } });
  const out = await runAgent(agentArgs());
  assert.match(out.say, /can't read/i);
  assert.equal(out.cards.length, 0);
});

test("loop cap: a model that never stops is cut off, no hang", async () => {
  route({ model: [toolUse("get_progress", {})] }); // always tool_use, queue repeats
  const out = await runAgent(agentArgs());
  assert.equal(typeof out.say, "string"); // returns, doesn't hang or throw
});

// --- safety gate + fallback ---

test("triage routes drop/quit talk to at_risk; advisingHandoff deflects, no loop", async () => {
  route({ model: [classify("at_risk")] });
  assert.equal(await triage([{ role: "user", content: "i want to quit" }]), "at_risk");
  const out = advisingHandoff("at_risk");
  assert.equal(out.cards[0].kind, "advising");
  assert.ok(out.cards[0].email.includes("@"));
});

test("fallbackCoach (no key) returns the cards shape", () => {
  const status = deriveState(CS());
  const out = fallbackCoach({ messages: [{ role: "user", content: "how am I doing" }], status });
  assert.equal(out.cards[0].kind, "progress");
});

// --- connector registry extensibility ---

test("registry: a dropped-in connector contributes its tool and dispatches", async () => {
  const dummy = {
    name: "dummy",
    fetch: async () => ({ hi: 1 }),
    tools: [{ def: { name: "dummy_ping", description: "d", input_schema: { type: "object", properties: {} } }, run: (_i, d) => ({ pong: d.hi }) }],
  };
  const list = [dummy];
  assert.ok(toolDefs(list).some((d) => d.name === "dummy_ping"));
  const ctx = makeToolCtx({ courseId: "1", studentId: "1" });
  const res = await runTool("dummy_ping", {}, ctx, [], list);
  assert.equal(res.pong, 1);
});
