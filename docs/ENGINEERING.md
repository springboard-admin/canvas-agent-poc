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
| **My Progress edge fn ×1** | **every** `/api/plan` turn | `phase-config?action=curriculum_state` on the lovable Supabase project. 1 invocation + server-side Canvas reads (course structure cached 1h there). Was 2 calls in M1-iter1; `canvas-dashboard` and `student_progress` were dropped in iter2. |
| Vercel function invocation | every turn | the `/api/plan` handler itself. |

**No database, no cron, no background jobs, no persistence** in the poc today (stateless).
Memory (M2) will add storage — cost it here when it lands.

### Known frugality trade-offs (open, not yet optimized)

- The edge-fn call fires on **every** turn, even chit-chat that never needs progress.
  Deliberately *not* optimized (conditional fetching = branching for little gain at POC
  traffic). Revisit only if invocation volume becomes a real cost — likeliest lever: a short
  per-session cache once M2 adds a store. Don't add caching machinery before then.
- The coach model now returns only `say`/`intent`/`special` — the next step, item rows and
  status card are built from authoritative data. Smaller output per turn (cheaper) and
  nothing factual can be hallucinated. Keep it that way: don't move facts back into the
  model's output.

### Invariant worth protecting

Progress/health is read from the My Progress app and **never recomputed here**. If the agent
ever disagrees with the student's screen, trust is gone. `lib/myprogress.js` is the only place
that data enters; `deriveState()` is pure and the model never touches the numbers.
