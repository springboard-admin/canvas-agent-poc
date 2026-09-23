// Memory connector — a curated markdown file per student in R2 (Claude-harness style:
// substantial facts only, the model rewrites the whole file, we review it in R2). Keyed
// {userId}/{courseId}.md. The loop preloads the md into context each turn; save_memory
// persists a curated update. Feature-flagged: if R2 isn't configured, everything no-ops.
import { r2Get, r2Put, r2Enabled } from "../r2.js";

const MAX = 8000; // keep memory small; hard cap on what we persist

// Read the student's memory once. Returned as the connector's per-turn data AND used by the
// loop to preload context (the loop primes ctx.cache so we don't read R2 twice).
export async function readMemory(courseId, studentId) {
  const key = `${studentId}/${courseId}.md`;
  let md = "";
  try { md = (await r2Get(key)) ?? ""; } catch { md = ""; }
  return { key, md, enabled: r2Enabled() };
}

async function fetch(ctx) {
  return readMemory(ctx.courseId, ctx.studentId);
}

const tools = [
  {
    def: {
      name: "save_memory",
      description: "Persist a SMALL curated markdown memory about this student — substantial, durable facts only (goals, a commitment like 'study Tue 7pm', what helps them, key context). Rewrite the WHOLE file, pruning stale/trivial lines. Call ONLY when you learn something durable worth recalling next visit — never for routine chat.",
      input_schema: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
    },
    run: async ({ markdown }, d) => {
      if (!d.enabled) return { saved: false, reason: "memory not configured" };
      try { await r2Put(d.key, String(markdown || "").slice(0, MAX)); return { saved: true }; }
      catch (e) { return { saved: false, reason: e.message }; }
    },
  },
];

export const memory = { name: "memory", fetch, tools };
