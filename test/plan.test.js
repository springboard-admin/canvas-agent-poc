// M0 unit tests — reliability + warmth. Run: npm test
// The Anthropic call goes through global fetch, which we stub per test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCoach, triage, crisisHandoff, normalize } from "../api/plan.js";

process.env.ANTHROPIC_API_KEY = "test-key"; // callStructured reads this for the header

// Build a fake Anthropic HTTP response whose content is a single tool_use block.
function toolUseResponse(input) {
  return {
    ok: true,
    json: async () => ({ content: [{ type: "tool_use", name: "respond", input }] }),
    text: async () => "",
  };
}
// A response with NO tool_use block (simulates the model failing to produce structure).
function noToolResponse() {
  return {
    ok: true,
    json: async () => ({ content: [{ type: "text", text: "oops, prose not JSON" }] }),
    text: async () => "",
  };
}

// Queue a sequence of fetch responses; each fetch() call shifts the next one.
function stubFetch(responses) {
  const queue = [...responses];
  globalThis.fetch = async () => {
    if (!queue.length) throw new Error("unexpected extra fetch");
    return queue.shift();
  };
}

const baseCoachArgs = () => ({
  messages: [
    { role: "user", content: "i want something to do" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "yeah give me a task" },
  ],
  energy: null,
  mode: "chat",
  daysAway: null,
  progressDelta: null,
  progress: { percentComplete: 20, doneItems: 1, totalItems: 5, unit: "weeks", remaining: [] },
  remaining: [],
  special: [],
  journey: null,
  ctx: {},
});

test("normalize never emits the old cheerful filler", () => {
  const out = normalize({}, { percentComplete: 20 });
  assert.notEqual(out.say, "I'm here whenever you want to make a little progress.");
  assert.equal(typeof out.say, "string");
  assert.equal(out.intent, "chat"); // unknown intent clamps to chat
});

test("crisisHandoff returns a static support block and no task, no model call", () => {
  // No fetch stub installed on purpose — a crisis must never hit the model.
  globalThis.fetch = async () => { throw new Error("crisis must not call the model"); };
  const out = crisisHandoff({ percentComplete: 20 });
  assert.equal(out.source, "crisis");
  assert.equal(out.special.kind, "support");
  assert.equal(out.nextAction, null);
  assert.equal(out.plan, null);
  assert.equal(out.intent, "chat");
});

test("triage returns the model's label", async () => {
  stubFetch([toolUseResponse({ label: "distress" })]);
  const label = await triage([{ role: "user", content: "life has been really hard lately" }]);
  assert.equal(label, "distress");
});

test("triage fails safe to coach on error", async () => {
  globalThis.fetch = async () => { throw new Error("network down"); };
  const label = await triage([{ role: "user", content: "whatever" }]);
  assert.equal(label, "coach");
});

test("distress hard-gates task even when the model returns one", async () => {
  stubFetch([
    toolUseResponse({
      say: "That sounds heavy.",
      intent: "plan",
      nextAction: { title: "Do the quiz", url: "u", minutes: 20 },
      plan: [{ title: "Do the quiz", url: "u", minutes: 20 }],
    }),
  ]);
  const out = await runCoach({ ...baseCoachArgs(), distress: true });
  assert.equal(out.nextAction, null);
  assert.equal(out.plan, null);
  assert.equal(out.intent, "chat");
  assert.equal(out.say, "That sounds heavy.");
});

test("honest snag after both attempts fail — never the filler", async () => {
  stubFetch([noToolResponse(), noToolResponse()]); // first call + one retry both fail
  const out = await runCoach({ ...baseCoachArgs() });
  assert.equal(out.source, "error");
  assert.match(out.say, /snag/i);
  assert.equal(out.nextAction, null);
});
