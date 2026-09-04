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
| **Anthropic — coach** (`ANTHROPIC_MODEL`, Sonnet 5) | every turn that isn't crisis | 1 call. Crisis turns make **zero** model calls (static handoff). Retry adds ≤1 more only on a malformed reply. |
| **My Progress edge fns ×2** | **every** `/api/plan` turn | `phase-config` + `canvas-dashboard` on the lovable Supabase project. = 2 Supabase function invocations + server-side Canvas API reads, per turn. **This is the main added recurring compute in M1.** Free-tier fine at POC traffic; revisit if turns scale. |
| Vercel function invocation | every turn | the `/api/plan` handler itself. |

**No database, no cron, no background jobs, no persistence** in the poc today (stateless).
Memory (M2) will add storage — cost it here when it lands.

### Known frugality trade-off (open, not yet optimized)

The 2 edge-fn calls fire on **every** turn, even pure chit-chat that never needs progress.
Deliberately *not* optimized yet (conditional fetching adds branching = fat for little gain at
POC traffic). Revisit only if invocation volume becomes a real cost — likeliest lever: a short
per-session cache once M2 adds a store. Do not add caching machinery before then.
