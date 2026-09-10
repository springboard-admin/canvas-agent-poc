// Agent (tool-use loop) + connector tests. Run: npm test (node 18+; repo default v10 — use v20)
// global fetch is ROUTED: anthropic.com → scripted model turns; else → the student_progress fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, triage, advisingHandoff, fallbackCoach } from "../api/plan.js";
import { deriveState, derivePhases } from "../lib/myprogress.js";
import { toolDefs, runTool, makeToolCtx } from "../lib/connectors/index.js";

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.MYPROGRESS_URL = "https://example.supabase.co";
process.env.MYPROGRESS_ANON_KEY = "anon-test";

// student_progress fixture (Curriculum phase, cumulative pass rule ≥70).
const SP = () => ({
  configured: true, courseStartAt: "2026-01-01T00:00:00Z", currentPhaseIndex: 0, journeyComplete: false,
  phases: [
    { name: "Curriculum", status: "active", gateMet: false, phaseClearMode: "cumulative", phaseClearThreshold: 70, cumulativeScore: 68, gateType: "all_complete", passedCount: 11, requiredCount: 16, totalCount: 16, items: [
      { title: "Week 1 | Pharm", passed: true, done: true, score: 80, isPage: false, subItems: [{ title: "Graded Quiz: Pharm Week 1", score: 80, points: 100, passed: true, done: true, url: "u1" }] },
      { title: "Week 2 | Pharm", passed: false, done: true, score: 35, isPage: false, subItems: [{ title: "Graded Quiz: Pharm Week 2", score: 35, points: 100, passed: false, done: true, url: "u2" }] },
      { title: "Week 5 | Pharm Law", passed: false, done: false, isPage: false, subItems: [{ title: "Graded Quiz: Law", score: null, points: 100, passed: false, done: false, url: "u5" }] },
    ] },
    { name: "Final Exam", status: "upcoming", gateMet: false, passedCount: 0, requiredCount: 1, totalCount: 1, items: [] },
  ],
});

const toolUse = (name, input, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
const finalText = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
const classify = (label) => ({ content: [{ type: "tool_use", id: "c", name: "classify", input: { label } }], stop_reason: "tool_use" });

function route({ model = [], sp = SP() } = {}) {
  const q = [...model];
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.anthropic.com")) return { ok: true, json: async () => (q.length > 1 ? q.shift() : q[0]), text: async () => "" };
    return { ok: true, status: 200, json: async () => sp, text: async () => "" };
  };
}
const agentArgs = (over = {}) => ({ messages: [{ role: "user", content: "hi" }], mode: "chat", daysAway: null, courseId: "137", studentId: "187", ctx: {}, ...over });

// --- deriveState reads My Progress facts, never recomputes ---

test("deriveState: passing = gateMet (authoritative), never recomputed", () => {
  const s = deriveState(SP());
  assert.equal(s.state, "behind");        // gateMet false
  assert.equal(s.gate.type, "cumulative");
  assert.equal(s.passPercent, 70);        // phaseClearThreshold
  assert.equal(s.score, 68);              // cumulativeScore straight from My Progress
  assert.equal(s.scoreBand, "warn");      // 68 < 70
  assert.equal(s.next.title, "Graded Quiz"); // shortened; week 2 first unfinished
  assert.equal(s.next.week, 2);
});

test("deriveState: gateMet true → caught_up (even if some items unpassed)", () => {
  const sp = SP(); sp.phases[0].gateMet = true;
  assert.equal(deriveState(sp).state, "caught_up");
});

test("derivePhases: whole journey stepper", () => {
  const j = derivePhases(SP());
  assert.equal(j.phases.length, 2);
  assert.equal(j.phases[0].status, "active");
  assert.equal(j.currentPhaseName, "Curriculum");
});

// --- agent loop ---

test("get_week reasons in words, no card", async () => {
  route({ model: [toolUse("get_week", { week: 2 }), finalText("You took it — 35, under the 70 bar, so a retake would count it.")] });
  const out = await runAgent(agentArgs());
  assert.match(out.say, /35/);
  assert.equal(out.cards.length, 0);
});

test("show_next_step renders the authoritative tile", async () => {
  route({ model: [toolUse("show_next_step", {}), finalText("Smallest win:")] });
  const out = await runAgent(agentArgs());
  const tile = out.cards.find((c) => c.kind === "next_step");
  assert.equal(tile.title, "Graded Quiz");
  assert.equal(tile.week, 2);
  assert.equal(tile.score, 35);
  assert.equal(tile.needPct, 70);
});

test("open_in_canvas uses the real module URL from a sub-item", async () => {
  route({ model: [toolUse("open_in_canvas", { week: 2 }), finalText("Here you go.")] });
  const out = await runAgent(agentArgs());
  assert.equal(out.cards.find((c) => c.kind === "open").url, "u2");
});

test("show_phases renders the journey stepper", async () => {
  route({ model: [toolUse("show_phases", {}), finalText("Your journey:")] });
  const out = await runAgent(agentArgs());
  assert.equal(out.cards.find((c) => c.kind === "phases").phases.length, 2);
});

test("distress drops task/open cards, keeps the reply", async () => {
  route({ model: [toolUse("show_next_step", {}), finalText("I hear you.")] });
  const out = await runAgent(agentArgs({ distress: true }));
  assert.equal(out.cards.find((c) => c.kind === "next_step"), undefined);
});

test("unavailable → get_progress reports it, agent still replies", async () => {
  route({ model: [toolUse("get_progress", {}), finalText("I can't read your progress right now.")], sp: { configured: false } });
  const out = await runAgent(agentArgs());
  assert.match(out.say, /can't read/i);
});

test("loop cap: never-stopping model is cut off, no hang", async () => {
  route({ model: [toolUse("get_progress", {})] });
  assert.equal(typeof (await runAgent(agentArgs())).say, "string");
});

// --- safety + fallback + registry ---

test("triage → at_risk; advisingHandoff bakes email into the message, no card", async () => {
  route({ model: [classify("at_risk")] });
  assert.equal(await triage([{ role: "user", content: "i want to quit" }]), "at_risk");
  const out = advisingHandoff("at_risk");
  assert.equal(out.cards.length, 0);
  assert.match(out.say, /@/);
});

test("fallbackCoach: 'how am I doing' words only; full list on explicit ask", () => {
  const status = deriveState(SP());
  assert.equal(fallbackCoach({ messages: [{ role: "user", content: "how am I doing" }], status }).cards.length, 0);
  assert.equal(fallbackCoach({ messages: [{ role: "user", content: "show me everything" }], status }).cards[0].kind, "progress");
});

test("registry: a dropped-in connector contributes its tool and dispatches", async () => {
  const dummy = { name: "dummy", fetch: async () => ({ hi: 1 }), tools: [{ def: { name: "dummy_ping", description: "d", input_schema: { type: "object", properties: {} } }, run: (_i, d) => ({ pong: d.hi }) }] };
  assert.ok(toolDefs([dummy]).some((d) => d.name === "dummy_ping"));
  const res = await runTool("dummy_ping", {}, makeToolCtx({ courseId: "1", studentId: "1" }), [], [dummy]);
  assert.equal(res.pong, 1);
});
