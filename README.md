# Canvas Study Agent — Lite POC (LTI 1.1)

A clean, futuristic AI study coach that launches as an **LTI 1.1** tool inside a
Canvas course (same install tactic as your "My Progress" app — paste an XML
config). When a student says how much time they have, it builds a **time-boxed
study plan** from that course's real **Modules**, tells them **how they're
doing** and **what to catch up on**.

> Scope note: this is an exploration POC, not production. It uses a single manual
> Canvas API token, an in-memory session store, and a signed session cookie.
> Good enough to demo in a test course; not hardened for scale.

## What's in the box

```
public/config.xml   LTI 1.1 XML config cartridge (paste into Canvas)
api/launch.js        LTI 1.1 launch: verifies OAuth1 signature, renders the agent UI
api/plan.js          Reads Modules + asks Claude for a time-boxed plan (rule-based fallback)
lib/oauth1.js        OAuth 1.0 HMAC-SHA1 signature verification
lib/lti.js           env + signed session cookie helpers
lib/canvas.js        Canvas REST reads + progress summary
lib/store.js         Tiny session store
public/              The agent frontend (vanilla JS/CSS, no build step)
```

## How the pieces talk

1. Student opens the course nav item → Canvas **form-POSTs** an OAuth-signed
   launch to `/api/launch`, including the custom fields
   (`$Canvas.course.id`, `$Canvas.user.id`, `$Canvas.user.loginId`).
2. We verify the signature with the shared secret, stash course/user in a signed
   cookie, and serve the agent SPA.
3. Student asks something → SPA POSTs to `/api/plan` → we read that course's
   Modules via the Canvas API token, summarize progress, and (if
   `ANTHROPIC_API_KEY` is set) ask Claude to build the plan from only real module
   items. No key = deterministic rule-based fallback.

## 1. Deploy to Vercel

Frontend-only isn't enough — the backend verifies the launch signature and keeps
your Canvas token + Anthropic key server-side. The `api/` serverless functions
handle that.

```bash
npm i
npx vercel        # first deploy → gives you https://YOUR-APP.vercel.app
```

Set the env vars from `.env.example` in the Vercel dashboard
(Project → Settings → Environment Variables), then redeploy.

- `LTI_CONSUMER_KEY` — you pick it (e.g. `study-agent`).
- `LTI_SHARED_SECRET` — you pick it (a long random string).
- `STATE_SECRET` — any long random string.
- `CANVAS_BASE_URL`, `CANVAS_API_TOKEN` (Account → Settings → New Access Token).
- `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` (defaults `claude-sonnet-5`). Leave the
  key blank to demo the rule-based fallback.

## 2. Update the XML config

Open `public/config.xml`, replace `YOUR-APP.vercel.app` in `<blti:launch_url>`
with your Vercel domain. After deploy it's also served at
`https://YOUR-APP.vercel.app/config.xml`. The custom fields already match your
"My Progress" app (`userId`, `courseId`, `auth0_id`).

## 3. Install in your test course (same tactic as your other LTIs)

Course → **Settings → Apps → + App**. Configuration Type:

- **By URL**: paste `https://YOUR-APP.vercel.app/config.xml`, or
- **Paste XML**: paste the contents of `config.xml`.

Then enter:

| Field | Value |
|---|---|
| Consumer Key | your `LTI_CONSUMER_KEY` |
| Shared Secret | your `LTI_SHARED_SECRET` |

Submit. "My Progress" appears in course navigation. (To make it the landing
page, Course → Settings → Choose Home Page, if your Canvas allows an app there;
otherwise the nav item is the POC entry point.)

## 4. Give it something to recommend

Build some **Modules** with items (Assignments/Quizzes/Pages) and a few due
dates. Mark some complete and let a couple go past due so the "slightly behind"
state shows.

## Local sanity check

```bash
npm run check     # node syntax-checks every source file
```

## Known limits (by design, for a POC)

- One shared Canvas token, not per-student OAuth. Per-student progress uses the
  launch `userId` when the token has permission; otherwise it reflects module
  completion state.
- In-memory session store won't persist across serverless cold starts; the
  signed `sa_session` cookie carries context so the UI still works.
- LTI 1.1 (OAuth 1.0) is deprecated by IMS in favor of 1.3, but it's the
  simplest path for a test-course POC and matches your existing install flow.
- No rate limiting, no persistence of plans, no analytics.
