// Journey connector — the whole multi-phase journey (the PhaseJourney stepper), from the
// same My Progress app's student_progress. Separate connector so it's fetched lazily: a
// plain "how am I doing" (curriculum) never pays for this; only phase/journey questions do.
import { getPhaseJourney } from "../myprogress.js";

async function fetch(ctx) {
  const j = await getPhaseJourney(ctx.courseId, ctx.studentId).catch(() => null);
  return { journey: j, unavailable: !j || j.configured === false };
}

export function phasesCard(journey) {
  return {
    kind: "phases",
    currentPhaseName: journey.currentPhaseName,
    journeyComplete: journey.journeyComplete,
    phases: journey.phases, // [{name, status, passedCount, requiredCount, gateMet}]
  };
}

const tools = [
  {
    def: { name: "get_phases", description: "The student's whole journey across all phases (name, status done/active/upcoming, passed vs required). Use to reason about overall journey / where they are across phases.", input_schema: { type: "object", properties: {} } },
    run: (_i, d) => (d.unavailable ? { unavailable: true } : { currentPhaseName: d.journey.currentPhaseName, journeyComplete: d.journey.journeyComplete, phases: d.journey.phases }),
  },
  {
    def: { name: "show_phases", description: "Render the journey stepper card (all phases, where they are, passed/required). Use for 'show my phases', 'overall progress', 'the whole journey'.", input_schema: { type: "object", properties: {} } },
    run: (_i, d, cards) => { if (d.unavailable) return { shown: false }; cards.push(phasesCard(d.journey)); return { shown: true }; },
  },
];

export const journey = { name: "journey", fetch, tools };
