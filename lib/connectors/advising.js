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
      description: "Hand the student off to their human advising team. Use WHENEVER you can't answer from your other tools and a human should: retake / exam-sponsorship / program-policy questions, they ask for their advisor or the advisor's contact, they want someone alerted on their behalf, or they're stuck in a way your progress tools can't resolve. Returns the advising contact to relay.",
      input_schema: { type: "object", properties: { reason: { type: "string", description: "one short phrase — why you're escalating" } } },
    },
    run: ({ reason } = {}) => ({
      email: env("ADVISING_EMAIL", "advising@springboard.com"),
      flagged: true,
      reason: reason || null,
      tell: "Tell the student you've flagged their advising team and they'll reach out, and they can also email them directly at the address above. Warm, brief.",
    }),
  },
];

export const advising = { name: "advising", fetch, tools };
