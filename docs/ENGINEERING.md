# Engineering principles + cost ledger

The contract for this repo. Read this instead of the code to know what it costs.

## Principles (non-negotiable)

1. **Lean.** Only what's required. No speculative abstraction, no unused code, no premature
   optimization. Smallest change that works.
2. **Frugal by default.** Prefer stateless, cacheable, free-tier. Every recurring cost must
   earn its place and be listed below.
3. **Cost called out first.** Anything that spends money / cloud-run / compute is recorded in
   the ledger below *when it's added* — before you'd have to read code to find it.
4. **Scalable across programs.** No per-cohort hardcoding; everything keys on
   `courseId` + `userId`.
5. **Verify.** `npm test` (node 18+; repo default node is v10 — use v20). Ship small.

## Cost ledger (keep current)

Per **one** `POST /api/plan` turn (i.e. each student message; the opening greeting is one too):

| Cost | When | Notes / frugality |
|---|---|---|
| **Anthropic — triage** (Haiku) | every non-greeting turn | ~1 cheap call, tiny in/out (`ANTHROPIC_TRIAGE_MODEL`, default `claude-haiku-4-5`). |
| **Anthropic — agent loop** (`ANTHROPIC_MODEL`, Sonnet 5) | every turn that isn't at_risk/crisis | **2–4 calls/turn** — a tool-use loop (capped at 6 iterations). System prompt + tools are prompt-cached, so each round-trip re-reads the stable prefix at ~10% cost. at_risk/crisis turns make **zero** model calls (static advising handoff). |
| **Connector edge fns** | only when a tool needs them | Each connector fetches its source **lazily** and memoizes per turn — a turn pays only for sources whose tools the model actually calls. Today one connector (`curriculum` → `phase-config?action=curriculum_state`); the mentor-call / live-session connectors will add their own edge fns when they ship. |
| Vercel function invocation | every turn | the `/api/plan` handler itself. |

**No database, no cron, no background jobs, no persistence** in the poc today (stateless).
Memory (M2) will add storage — cost it here when it lands.

### Known frugality trade-offs (open, not yet optimized)

- The edge-fn call fires on **every** turn, even chit-chat that never needs progress.
  Deliberately *not* optimized (conditional fetching = branching for little gain at POC
  traffic). Revisit only if invocation volume becomes a real cost — likeliest lever: a short
  per-session cache once M2 adds a store. Don't add caching machinery before then.
- The coach model returns `say`/`intent`/`special`/`show` — never the item data itself. The
  next step, rows and status card are built from authoritative data; nothing factual can be
  hallucinated. Keep it that way: don't move facts back into the model's output.
- Cards are model-chosen via `show` (none|overview|next), default **none** — conversation is
  the product, a card is the exception. The frontend also de-dupes the same card two turns
  running. Don't reintroduce mechanical per-intent card rendering.
- `weekFacts` (per-week done/submitted/score) are preloaded into grounding so the model can
  answer "did I do week 2?" without dumping the list. Cost: **+~1–2k input tokens/turn** for
  a ~16-week course. Accepted — far cheaper than a tool round-trip, and one source. Revisit
  (move to tools) only when data sources multiply or the payload outgrows preload.

### Connector pattern (extensibility)

The agent is a **tool-use loop** over a **connector registry** (`lib/connectors/`). Each
connector = one external app (fetch + tools). The loop is source-agnostic: adding the
mentor-call or live-session app later = drop in `lib/connectors/<name>.js` and list it in
`index.js` — no loop change. Card **contents** are always built by us from a connector's
authoritative data (the model names a week/item; it never supplies card text). Each new source
app needs its own loose-coupling regression note (as `student-greeting-hub` has).

### Invariant worth protecting

Progress is read from My Progress's **`student_progress`** edge fn — the SAME authoritative
output its own PhaseJourney UI uses — and **never recomputed here**. `gateMet`, `passedCount`,
`cumulativeScore`, per-item score/passed/url all come straight from it. Agent-side logic is
**presentation only** (grouping items into weeks, labels, next step). If a fact isn't exposed,
**expose it from My Progress** — never clone its math (that's how the retired `curriculum_state`
re-implementation drifted). See the `reuse-not-reimplement` memory.

Passing is judged by the course's **gate** (`curriculum_state.gate`: all_complete | pass_count |
cumulative), not a hardcoded rule — a student can be at 80% yet not passing if the gate is
"every module". The agent explains passing by the gate type and mirrors the app's item-name
shortening ("Graded Quiz"). Both are pass-through/derived; no new cost, no My Progress logic
read.

The focus-vs-detailed decision (behind → focus view, which hides the score and shows only the
next step) is re-derived in `deriveState()` from primitives the app already returns
(`cumulativeScore` vs `focusThreshold`, grace window). We deliberately do **not** read My
Progress's internal focus flag — loose coupling by design, so that app can evolve its own view
logic independently. Known small divergence: we don't read `focusModeEnabled`, so a course that
turns focus mode off would still get focus framing from the agent. Accepted; revisit only if it
bites. Any change to the app's scoring/focus logic can make the two disagree — the My Progress
repo carries a memory note to check this app for regressions before shipping such a change.
