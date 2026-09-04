# Canvas Study Agent → Student Advisor: Vision & Architecture

**Status:** Draft for discussion · **Date:** 2026-09-04 · **Owner:** Mohit

Goal: turn the current study-coach POC into a **world-class AI learning advisor** that
absorbs the job of the human Student Advisor — starting with **academic pacing** and
**emotional / retention support**, with a deliberate, safe boundary around
"real advising actions" (extensions, escalations, career).

This document is the plan we agree on *before* writing code.

---

## 1. Where we actually are today (honest read)

The POC is a **single stateless Claude call** wrapped in a prompt. One request to
[`api/plan.js`](../api/plan.js) does everything: pulls live Canvas modules, computes a
week-journey progress number, stuffs it all into a ~2,000-word system prompt, asks
Haiku to reply as strict JSON, and renders whatever comes back.

It works when it works — the greeting and the "Week 3" card in the current screenshot
are real, live output. But three structural problems make it feel broken and cap it
far below "advisor":

### 1a. The silent-fallback bug (why the screenshot repeats itself)
[`api/plan.js:295`](../api/plan.js#L295)
```js
say: p.say || "I'm here whenever you want to make a little progress.",
```
The model is asked for **strict JSON**, enforced only by prompt text. Parsing is a
naive first-`{`-to-last-`}` slice (`safeJson`). Any drift — a stray sentence, a
malformed field — fails the parse, returns `{}`, and the code pastes that one canned
line. HTTP 200, no retry, no log, no signal to the user. So three emotionally
different messages ("life hasn't been kind", "what shall I do now?", "what now?") all
collapse to the **same dead sentence**. It reads as the bot ignoring you; it's actually
an unhandled failure being swallowed.

**Worst symptom:** a student in distress ("life hasn't been kind") gets
"make a little progress." That's not a personality problem — it's a swallowed error.

### 1b. Structured output is unenforced
No tool-use / structured-output contract, no response prefill, no retry. Haiku is the
family member most likely to add prose around JSON. The whole reliability of the app
rests on the model never making a formatting mistake — which it will.

### 1c. It's stateless and memoryless
"Memory" = the last 12 chat turns re-sent from the browser
([`public/app.js`](../public/app.js)). No student model, no cross-session memory, no
retrieval, no tools, no verification. It cannot *know* a student across weeks, so it
cannot advise like a person who remembers you.

### 1d. Pacing rules fight the user
`allowNudge()` + "don't push a task early" keep the first turns deliberately vague
("tell me more…"). When someone asks a **direct** question, evasiveness reads as
robotic — exactly the "what shall I do now?" → "I'm here whenever…" moment.

---

## 2. Vision — what "world-class advisor" means

A single presence on the course home page that a student trusts the way they'd trust a
great human advisor. It:

- **Remembers them.** Knows their history, their goals, what they told it last month,
  what they're stuck on, how they tend to fall behind.
- **Reads the moment.** Distinguishes "I need a task" from "I'm drowning and need a
  human." Meets emotion with warmth first, logistics second — never a canned line.
- **Knows the truth.** Grounds every claim in real Canvas data and program policy, and
  never invents a task, a grade, or a deadline.
- **Acts, within bounds.** Does the small safe things itself (build a plan, surface the
  right reading, remind, encourage) and **escalates the rest to a human advisor**
  cleanly, with context, instead of faking authority.
- **Never fails silently.** When it can't answer, it says so or hands off — it never
  pastes filler.

The bar: a student can't tell, most of the time, whether they're talking to a very good
advisor or software.

---

## 3. The emotional / retention layer (this is the hard part)

Pacing is mostly solved-shaped; **retention is where a human advisor earns their
salary**, and where an LLM is most dangerous if naive. Design principles:

- **Warmth before logistics.** On a distress signal, the *first* response is human and
  contains **no task**. A task offered into "life hasn't been kind" is the failure mode
  we're literally looking at now.
- **A real risk model, not vibes.** Track disengagement signals (days away, stalled
  week, missed graded quiz, negative sentiment) as a **student risk state**, and change
  behavior on it — not just react to the current message.
- **Know the edge of your competence.** The agent is a coach, **not a counselor**.
  Crisis / mental-health / financial-hardship language must trigger a **defined
  escalation and resource path**, never improvised advice. This is a safety
  requirement, not a nicety, and needs Springboard sign-off on the exact wording and
  handoff.
- **Honest encouragement.** Frame progress truthfully. No fake cheer, no toxic
  positivity, no "you're so close!" when they're not.

**Open decision (your "not sure yet"):** how far into real advising the agent goes.
My recommendation is a three-tier boundary — see §5.

---

## 4. Recommended architecture

Move from "one prompt" to **a small agent with memory, tools, and a safety spine.**

```
                        ┌───────────────────────────────────┐
   Student ── message ─▶│         Advisor Agent Loop          │
                        │  (Claude, tool-use, verified I/O)   │
                        └───────────────────────────────────┘
                          │        │            │         │
             ┌────────────┘        │            │         └─────────────┐
             ▼                     ▼            ▼                        ▼
      Student Model         Canvas Tools   Program KB            Safety / Triage
      (durable memory)      (live truth)   (retrieval)          (risk + escalation)
      goals, history,       modules,       policies, FAQs,      distress detection,
      risk state, prefs     grades, due    deadlines, advisor   human handoff,
                            dates, ledger  playbooks            resource paths
```

**Core pieces:**

1. **Agent loop, not a single completion.** Claude with **tool use** so it *asks for*
   the data it needs (this student's grades, the program policy) instead of us pre-
   stuffing one giant prompt. Enforce the response shape with a **tool/structured
   output**, not prose parsing. Add a **retry + repair** step so a malformed turn is
   fixed, never swallowed. **This alone kills the §1a/§1b bugs.**

2. **A durable Student Model.** Server-side, per-student: goals, key facts, running
   summary, risk state, last-N sessions. The current 12-turn browser transcript becomes
   a cache, not the memory. This is what makes it feel like it *knows* you. (POC uses
   an in-memory store per [`lib/store.js`](../lib/store.js) — this needs a real datastore.)

3. **Canvas as tools, kept authoritative.** Keep the rule that progress/grades/dates
   come from the server, never the model ([`lib/canvas.js`](../lib/canvas.js),
   [`lib/weeks.js`](../lib/weeks.js)). Expose them as callable tools so the agent pulls
   the specific fact it needs on demand.

4. **Program knowledge base + retrieval.** Policies, deadlines, advisor playbooks,
   common questions. This is what lets it answer real advising questions instead of
   guessing — and what a human advisor actually carries in their head.

5. **Safety / triage spine.** A first-pass classifier on every message: `coach` vs
   `status` vs `at-risk` vs `escalate-now`. Routes distress/crisis away from the task
   engine and into warmth + human handoff. Non-negotiable before this replaces a human.

6. **Model choice.** Haiku is fine for cheap classification and status lookups; the
   advisor's *conversational* turns — especially emotional ones — should run on a
   stronger model (Sonnet/Opus tier). I'll confirm exact current model IDs and pricing
   against the `claude-api` reference before we build.

---

## 5. The escalation boundary (my recommendation for "real advising actions")

Three tiers, so the agent is useful without overstepping:

| Tier | Examples | Who acts |
|------|----------|----------|
| **Green — agent acts** | Build/adjust study plan, surface right reading, explain progress, encourage, remind, answer policy from KB | Agent, autonomously |
| **Yellow — agent drafts, human confirms** | Request an extension, flag "I'm falling behind", career/resume help, schedule an advisor call | Agent prepares + routes; human approves/does |
| **Red — agent hands off immediately** | Crisis, mental health, financial hardship, anything outside program scope | Human, now, with a warm handoff + resources |

Green ships first. Yellow and Red need Springboard policy sign-off — **that's the main
external dependency**, not code.

---

## 6. Roadmap

**Phase 0 — Stop the bleeding (small, do first).**
Kill the silent fallback: enforce structured output, add retry/repair, and when the
agent genuinely has nothing, say something honest — never the canned line. Fixes the
screenshot without waiting for the big build.

**Phase 1 — Memory + tools.**
Durable student model; Canvas facts as tools; agent loop with verified output. Now it
remembers and stops hallucinating structure.

**Phase 2 — Retention brain.**
Risk state, distress-aware routing, warmth-first responses, honest encouragement.
Program KB + retrieval for real questions.

**Phase 3 — Escalation + advisor handoff.**
Green tier fully autonomous; Yellow drafting + routing; Red safe handoff. Springboard
sign-off on wording and resources.

**Phase 4 — Prove it.**
Instrument retention/engagement lift vs. the human-advisor baseline. That's how we know
it earned the word "replace."

---

## 7. Open decisions (need you / Springboard)

1. **Escalation wording + resources** for the Red tier — legal/policy sign-off. Blocker
   for anything past Phase 2.
2. **Where student memory lives** — datastore choice; the POC's in-memory store won't do.
3. **How "replace the advisor" is measured** — retention? advisor-hours saved? student
   satisfaction? This decides what we optimize.
4. **Yellow-tier authority** — can the agent *request* an extension, or only draft one
   for a human?

---

*Next step after we align: I'll write up Phase 0 as a concrete, small change set for
review — still no code until you say go.*
