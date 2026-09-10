// Connector registry. Each connector is one external data source (an app with edge
// functions) exposing agent tools. The agent loop is source-agnostic: it builds its
// tool list from here and dispatches each tool call to the owning connector.
//
// Adding a source later (e.g. mentor-call attendance, live-session engagement) = write
// lib/connectors/<name>.js with its own fetch + tools, and add it to this array. No
// change to the loop. Each connector fetches its source lazily and memoizes per turn,
// so a turn only pays for the sources whose tools the model actually calls.
import { curriculum } from "./curriculum.js";
import { journey } from "./journey.js";

export const connectors = [curriculum, journey];

// Fresh per-turn context: identity + a per-connector fetch memo.
export function makeToolCtx({ courseId, studentId }) {
  return { courseId, studentId, cache: new Map() };
}

// Anthropic tool schemas from every connector (last one gets a cache breakpoint).
export function toolDefs(list = connectors) {
  const defs = list.flatMap((c) => c.tools.map((t) => t.def));
  if (defs.length) defs[defs.length - 1] = { ...defs[defs.length - 1], cache_control: { type: "ephemeral" } };
  return defs;
}

// Execute one tool call: find its connector, lazy-fetch + memoize its data, run it.
export async function runTool(name, input, ctx, cards, list = connectors) {
  for (const c of list) {
    const tool = c.tools.find((t) => t.def.name === name);
    if (!tool) continue;
    if (!ctx.cache.has(c.name)) ctx.cache.set(c.name, await c.fetch(ctx));
    return tool.run(input || {}, ctx.cache.get(c.name), cards);
  }
  return { error: `unknown tool: ${name}` };
}
