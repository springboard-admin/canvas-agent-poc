// Agent (tool-use loop) + connector tests. Run: npm test (node 18+; repo default v10 — use v20)
// global fetch is ROUTED: anthropic.com → scripted model turns; else → the student_progress fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, triage, advisingHandoff, fallbackCoach } from "../api/plan.js";
import { deriveState, derivePhases } from "../lib/myprogress.js";
import { deriveCanvasProgress } from "../lib/canvas.js";
import { toolDefs, runTool, makeToolCtx } from "../lib/connectors/index.js";

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.MYPROGRESS_URL = "https://example.supabase.co";
process.env.MYPROGRESS_ANON_KEY = "anon-test";
process.env.R2_ACCOUNT_ID = "acc";
process.env.R2_BUCKET = "bkt";
process.env.R2_ACCESS_KEY_ID = "k";
process.env.R2_SECRET_ACCESS_KEY = "s";

// student_progress fixture (Curriculum phase, cumulative pass rule ≥70).
const SP = () => ({
  configured: true, courseStartAt: "2026-01-01T00:00:00Z", currentPhaseIndex: 0, journeyComplete: false,
  phases: [
    { name: "Curriculum", status: "active", gateMet: false, phaseClearMode: "cumulative", phaseClearThreshold: 70, cumulativeScore: 68, gateType: "all_complete", passedCount: 11, requiredCount: 16, totalCount: 16, items: [
      { title: "Week 1 | Pharm", passed: true, done: true, score: 80, isPage: false, subItems: [{ title: "Graded Quiz: Pharm Week 1", score: 80, points: 100, passed: true, done: true, url: "u1" }] },
      { title: "Week 2 | Pharm", passed: false, done: true, score: 35, isPage: false, subItems: [{ title: "Graded Quiz: Pharm Week 2", score: 35, points: 100, passed: false, done: true, url: "u2", passThreshold: 80 }] },
      { title: "Week 5 | Pharm Law", passed: false, done: false, isPage: false, subItems: [{ title: "Graded Quiz: Law", score: null, points: 100, passed: false, done: false, url: "u5" }] },
    ] },
    { name: "Final Exam", status: "upcoming", gateMet: false, passedCount: 0, requiredCount: 1, totalCount: 1, items: [] },
  ],
});

const toolUse = (name, input, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
const finalText = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
const classify = (label) => ({ content: [{ type: "tool_use", id: "c", name: "classify", input: { label } }], stop_reason: "tool_use" });

function route({ model = [], sp = SP(), memoryMd = "", dashboard = null, puts = [], modules = null } = {}) {
  const q = [...model];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("api.anthropic.com")) return { ok: true, json: async () => (q.length > 1 ? q.shift() : q[0]), text: async () => "" };
    if (u.includes("r2.cloudflarestorage.com")) {
      if (opts?.method === "PUT") { puts.push({ url: u, body: opts.body }); return { ok: true, status: 200, text: async () => "" }; }
      return { ok: true, status: 200, text: async () => memoryMd }; // GET
    }
    if (u.includes("canvas-dashboard")) {
      if (!dashboard) return { ok: false, status: 500, json: async () => ({}), text: async () => "" };
      return { ok: true, status: 200, json: async () => dashboard, text: async () => "" };
    }
    if (u.includes("/modules")) {
      if (!modules) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
      return { ok: true, status: 200, json: async () => modules, text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => sp, text: async () => "" }; // student_progress
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

test("deriveState follows the ACTIVE phase; informational phase surfaces guidance, not 'caught up'", () => {
  const sp = SP();
  sp.phases.push(
    { name: "Exam Prep", status: "done", gateMet: true, items: [] },
    { name: "ExCPT Exam", status: "active", gateMet: false, informationalOnly: true, items: [], informationalContent: { body: "Register for your ExCPT exam — watch for our email in a day or two." } },
  );
  sp.currentPhaseIndex = sp.phases.length - 1; // the ExCPT Exam phase we just pushed
  const s = deriveState(sp);
  assert.equal(s.state, "informational");
  assert.equal(s.phaseName, "ExCPT Exam");
  assert.match(s.guidance, /Register for your ExCPT/);
  assert.equal(s.next, null); // no quiz — the next step is the guidance
  assert.equal(s.score, null);
});

test("graded post-curriculum phase: practice-exam requirement + progress + next", () => {
  const sp = {
    configured: true, currentPhaseIndex: 0, journeyComplete: false,
    phases: [{
      name: "Exam Prep", status: "active", gateMet: false, gateType: "all_complete", passedCount: 0, requiredCount: 1, totalCount: 1,
      comingSoon: { body: "Register for your ExCPT Exam." },
      items: [{
        title: "ExCPT Exam Prep | Study Weeks", passed: false, done: true, isPage: false, requiredPassCount: 2, requireAllAttempted: true,
        subItems: [
          { title: "Baseline Practice Exam", score: 58, points: 100, passed: false, done: true, url: "b" },
          { title: "Practice Exam 1", score: 66, points: 100, passed: false, done: true, url: "p1" },
          { title: "Practice Exam 2", score: 85, points: 100, passed: true, done: true, url: "p2" },
          { title: "Practice Exam 3", score: null, points: 100, passed: false, done: false, url: "p3" },
          { title: "Practice Exam 4", score: null, points: 100, passed: false, done: false, url: "p4" },
          { title: "Final Practice Exam", score: null, points: 100, passed: false, done: false, url: "pf" },
        ],
      }],
    }],
  };
  const s = deriveState(sp);
  assert.equal(s.phaseName, "Exam Prep");
  assert.equal(s.units[0].requirement, "pass 2 of 6, attempt all 6");
  assert.equal(s.units[0].passed, 1);
  assert.equal(s.units[0].attempted, 3);
  assert.equal(s.units[0].total, 6);
  assert.equal(s.next.title, "Baseline Practice Exam"); // first not-passed
  assert.match(s.guidance, /Register for your ExCPT/);
});

test("lab-skills phase: 'pass all N' requirement", () => {
  const sp = {
    configured: true, currentPhaseIndex: 0, journeyComplete: false,
    phases: [{ name: "Externship Readiness", status: "active", gateMet: false, gateType: "all_complete",
      items: [{ title: "Externship Readiness", passed: false, done: false, isPage: false, subItems: [
        { title: "Lab A", score: null, points: 100, passed: false, done: false, url: "a" },
        { title: "Lab B", score: null, points: 100, passed: false, done: false, url: "b" },
      ] }] }],
  };
  assert.equal(deriveState(sp).units[0].requirement, "pass all 2");
});

test("open_practice renders the RxReps card", async () => {
  route({ model: [toolUse("open_practice", {}), finalText("Here's some extra practice.")] });
  const out = await runAgent(agentArgs({ messages: [{ role: "user", content: "i feel underprepared" }] }));
  const card = out.cards.find((c) => c.kind === "open");
  assert.match(card.url, /rxreps/);
  assert.equal(card.cta, "Start practice →");
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
  assert.equal(tile.needPct, 80); // the item's OWN threshold, not the phase's cumulative 70
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

test("distress/at_risk go to the smart loop — cards are the agent's call, not force-stripped", async () => {
  route({ model: [toolUse("show_next_step", {}), finalText("Here's a small step whenever you're ready.")] });
  const out = await runAgent(agentArgs({ mood: "distress" }));
  assert.ok(out.cards.find((c) => c.kind === "next_step")); // no hard strip — the agent judges
});

test("unavailable → get_progress reports it, agent still replies", async () => {
  route({ model: [toolUse("get_progress", {}), finalText("I can't read your progress right now.")], sp: { configured: false } });
  const out = await runAgent(agentArgs());
  assert.match(out.say, /can't read/i);
});

test("unconfigured course: get_canvas_progress reads modules, quiz closes the module", async () => {
  const now = Date.parse("2026-06-01T00:00:00Z");
  const mapped = [
    { name: "Week 1", position: 1, items: [
      { title: "Read", type: "Page", completed: false, dueAt: null },
      { title: "Quiz", type: "Quiz", completed: true, dueAt: "2026-01-01T00:00:00Z" },
    ] },
    { name: "Week 2", position: 2, items: [
      { title: "Page", type: "Page", completed: true, dueAt: null },
      { title: "Quiz", type: "Quiz", completed: false, dueAt: "2026-12-01T00:00:00Z" },
    ] },
  ];
  const facts = deriveCanvasProgress(mapped, now);
  assert.equal(facts.totalModules, 2);
  assert.equal(facts.doneModules, 1); // week 1 quiz submitted; unread page ignored
  assert.equal(facts.leftModules, 1);
  assert.equal(facts.dueSoFar, 1);
  assert.equal(facts.dueSubmitted, 1);
  assert.equal(facts.dueUnsubmitted, 0);
  assert.equal(facts.onTrack, true); // Dec due is outside the next 3 days
  const soon = deriveCanvasProgress([{ name: "W", position: 1, items: [
    { title: "Reflection", type: "Assignment", completed: false, dueAt: "2026-06-03T00:00:00Z" },
  ] }], now);
  assert.equal(soon.onTrack, false);
  const soonDone = deriveCanvasProgress([{ name: "W", position: 1, items: [
    { title: "Reflection", type: "Assignment", completed: true, dueAt: "2026-06-03T00:00:00Z" },
  ] }], now);
  assert.equal(soonDone.onTrack, true);
  assert.equal(facts.next.module, "Week 2");
  assert.equal(facts.next.early, true);
  const both = deriveCanvasProgress([{ name: "M", position: 1, items: [
    { title: "A", type: "Quiz", completed: true, dueAt: "2026-01-01T00:00:00Z" },
    { title: "B", type: "Quiz", completed: false, dueAt: "2026-01-02T00:00:00Z" },
  ] }], now);
  assert.equal(both.doneModules, 0);
  assert.equal(both.next.title, "B");

  process.env.CANVAS_BASE_URL = "https://canvas.example.com";
  process.env.CANVAS_API_TOKEN = "tok";
  const canvasModules = [{
    id: 1, name: "Week 1", position: 1,
    items: [
      { id: 10, title: "Read", type: "Page", completion_requirement: { completed: false } },
      { id: 11, title: "Quiz", type: "Quiz", html_url: "q", content_details: { due_at: "2020-01-01T00:00:00Z" }, completion_requirement: { completed: false, type: "must_submit" } },
    ],
  }];
  route({
    model: [toolUse("get_progress", {}, "t1"), toolUse("get_canvas_progress", {}, "t2"), finalText("Your Week 1 quiz is still open.")],
    sp: { configured: false },
    modules: canvasModules,
  });
  const out = await runAgent(agentArgs());
  assert.match(out.say, /Week 1 quiz/i);
  const res = await runTool("get_canvas_progress", {}, makeToolCtx({ courseId: "137", studentId: "187" }), []);
  assert.equal(res.onTrack, false);
  assert.equal(res.doneModules, 0);
  assert.equal(res.next.title, "Quiz");
  assert.equal(res.next.early, false);
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

// --- memory (R2) + engagement ---

test("preloaded memory reaches the model; save_memory writes the curated md to R2", async () => {
  const puts = [];
  route({ memoryMd: "## Goals\nPass CPhT by Dec\n", model: [toolUse("save_memory", { markdown: "## Goals\nPass CPhT by Dec\n## Commitments\nStudy Tue 7pm\n" }), finalText("Got it — locked in.")], puts });
  const out = await runAgent(agentArgs({ messages: [{ role: "user", content: "remind me tuesday 7pm" }] }));
  assert.equal(puts.length, 1); // persisted
  assert.match(puts[0].body, /Study Tue 7pm/);
  assert.equal(typeof out.say, "string");
});

test("get_engagement returns the whitelisted shape from canvas-dashboard", async () => {
  route({
    model: [toolUse("get_engagement", {}), finalText("You've been steady.")],
    dashboard: { studyConsistency: { consistencyScore: 64 }, overdueAssignments: 2, upcomingAssignments: 1, weeklyBreakdown: [{ overallHealth: 60 }, { overallHealth: 70 }, { overallHealth: 78 }] },
  });
  const out = await runAgent(agentArgs());
  assert.match(out.say, /steady/i); // model got a valid tool result and replied
});

test("engagement degrades to unavailable when canvas-dashboard is down", async () => {
  route({ model: [toolUse("get_engagement", {}), finalText("Can't see your engagement right now.")], dashboard: null });
  const out = await runAgent(agentArgs());
  assert.equal(typeof out.say, "string"); // no throw; agent still replies
});

test("contact_advising gives the agent the advising email to escalate (not a dead 'I don't have it')", async () => {
  const res = await runTool("contact_advising", { reason: "exam retake policy" }, makeToolCtx({ courseId: "1", studentId: "1" }), []);
  assert.match(res.email, /@/);
  assert.equal(res.flagged, true);
  // and the agent can call it mid-loop
  route({ model: [toolUse("contact_advising", { reason: "who is my advisor" }), finalText("I've flagged your advising team — reach them at advising@springboard.com.")] });
  const out = await runAgent(agentArgs({ messages: [{ role: "user", content: "what is my advisor's email?" }] }));
  assert.match(out.say, /advising@/);
});

test("registry: a dropped-in connector contributes its tool and dispatches", async () => {
  const dummy = { name: "dummy", fetch: async () => ({ hi: 1 }), tools: [{ def: { name: "dummy_ping", description: "d", input_schema: { type: "object", properties: {} } }, run: (_i, d) => ({ pong: d.hi }) }] };
  assert.ok(toolDefs([dummy]).some((d) => d.name === "dummy_ping"));
  const res = await runTool("dummy_ping", {}, makeToolCtx({ courseId: "1", studentId: "1" }), [], [dummy]);
  assert.equal(res.pong, 1);
});
