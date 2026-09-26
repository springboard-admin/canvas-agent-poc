// Advising connector — lets the agent hand off to the human advising team WHEN IT DECIDES it's
// out of depth (retake/sponsorship/policy questions, "who's my advisor", "alert them for me",
// anything needing a human). This is the flexible, situation-driven counterpart to the hard
// triage gate (which still catches clear at_risk/crisis before the loop).
import { env } from "../lti.js";

async function fetch() { return {}; } // no data to load

const tools = [
  {
    def: {
      name: "contact_advising",
      description: "Hand the student off to their human advising team. Call when they agree to your offer to have advising email them an answer you do not have, or immediately for retake / exam-sponsorship / program policy, advisor contact, \"alert them\", or a live-session time that still does not work after the recording was offered. Do not call on the first turn you discover you lack a fact — offer first. Pass their question as reason. Returns the advising contact to relay. Mock only — it does not send email.",
      input_schema: { type: "object", properties: { reason: { type: "string", description: "one short phrase — why you're escalating" } } },
    },
    run: ({ reason } = {}) => ({
      email: env("ADVISING_EMAIL", "advising@springboard.com"),
      flagged: true,
      reason: reason || null,
      tell: "Tell the student you've flagged their advising team and they'll reach out, and they can also email them directly at the address above. Warm, brief. Then call save_memory with the WHOLE memory plus a Pending bullet containing this reason, if that pending item is not already there.",
    }),
  },
];

export const advising = { name: "advising", fetch, tools };
