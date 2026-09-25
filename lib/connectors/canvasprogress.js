// Canvas modules connector — fallback when My Progress has no phase config for
// this course. One getModules fetch per turn. Facts are presentation over Canvas
// completion + due dates (deriveCanvasProgress); the model never supplies them.
import { getModules, deriveCanvasProgress } from "../canvas.js";

async function fetch(ctx) {
  try {
    const modules = await getModules(ctx.courseId, ctx.studentId);
    const progress = deriveCanvasProgress(modules);
    if (!progress) return { unavailable: true };
    return { progress };
  } catch {
    return { unavailable: true };
  }
}

const tools = [
  {
    def: {
      name: "get_canvas_progress",
      description: "Module progress from Canvas when My Progress is not configured for this course. Totals, what's already due, what's done, what's left, and the next dated quiz/assignment. onTrack is true only when every item due within the next 3 days is already done. next.dueAt is the deadline to finish that item BEFORE. next.early true means that deadline has not passed. Call ONLY after get_progress returns unavailable. Answer in words: name the item and the date.",
      input_schema: { type: "object", properties: {} },
    },
    run: (_i, d) => (d.unavailable ? { unavailable: true } : d.progress),
  },
];

export const canvasprogress = { name: "canvasprogress", fetch, tools };
