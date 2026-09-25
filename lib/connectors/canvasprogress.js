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
      description: "Module progress from Canvas when My Progress is not configured for this course. Totals, what's due so far, what's done, what's left, on track, and the next dated quiz/assignment. Call ONLY after get_progress returns unavailable. Answer in words.",
      input_schema: { type: "object", properties: {} },
    },
    run: (_i, d) => (d.unavailable ? { unavailable: true } : d.progress),
  },
];

export const canvasprogress = { name: "canvasprogress", fetch, tools };
