// LTI 1.1 launch endpoint.
// Canvas form-POSTs the launch here (URL from config.xml). We verify the
// OAuth 1.0 (HMAC-SHA1) signature with our shared secret, read the custom
// fields ($Canvas.course.id, $Canvas.user.id, loginId), stash them in a signed
// cookie, and render the agent SPA.
import { env, makeState, setCookie } from "../lib/lti.js";
import { verify, launchUrl } from "../lib/oauth1.js";

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  try {
    // DEMO ONLY: standalone launch without Canvas/LTI, so we can test with a real student's
    // data outside the embedded course. Unauthenticated by design (experimental, URL not
    // shared, no real students). DO NOT expose this to real students / production.
    if (req.method === "GET") {
      const userId = strParam(req.query?.userId);
      const courseId = strParam(req.query?.courseId);
      if (!userId || !courseId) {
        res.status(400).send("Standalone launch needs ?userId=&courseId=. (Normally opened via Canvas LTI.)");
        return;
      }
      const name = await fetchCanvasName(userId).catch(() => "there");
      const ctx = { userId, courseId, loginId: "", name, givenName: name, contextTitle: "", roles: "", isStudent: true };
      const sessionToken = await makeState({ ctx });
      setCookie(res, "sa_session", sessionToken);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(renderShell(ctx, sessionToken));
      return;
    }
    if (req.method !== "POST") {
      res.status(405).send("This endpoint expects an LTI POST launch.");
      return;
    }

    const p = normalizeBody(req.body);

    // ---- verify OAuth 1.0 signature (optional) ----
    // If LTI_SHARED_SECRET is set, we verify the launch signature. If it's not
    // set, we skip verification — matching the simpler org flow where any
    // throwaway key/secret is entered in Canvas. Fine for a test-course POC;
    // set the secret for anything real.
    const secret = env("LTI_SHARED_SECRET", "");
    if (secret) {
      const expectedKey = env("LTI_CONSUMER_KEY", "");
      if (expectedKey && p.oauth_consumer_key !== expectedKey) {
        res.status(401).send("Unknown oauth_consumer_key");
        return;
      }
      const { ok } = verify("POST", launchUrl(req), p, secret);
      if (!ok) {
        res.status(401).send("Invalid LTI signature");
        return;
      }
    } else {
      console.warn("LTI_SHARED_SECRET not set — skipping signature verification (POC mode).");
    }

    // ---- pull the bits we care about ----
    const ctx = {
      userId: p.custom_userid || p.custom_userId || p.user_id || "",
      courseId: p.custom_courseid || p.custom_courseId || "",
      loginId: p.custom_auth0_id || "",
      name:
        p.lis_person_name_given ||
        p.lis_person_name_full ||
        "there",
      givenName: p.lis_person_name_given || "",
      contextTitle: p.context_title || "",
      roles: p.roles || "",
      isStudent: /Learner|Student/i.test(p.roles || ""),
    };
    if (!ctx.courseId) {
      res
        .status(400)
        .send("Launch missing custom courseId — check config custom_fields.");
      return;
    }

    const sessionToken = await makeState({ ctx });
    setCookie(res, "sa_session", sessionToken);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(renderShell(ctx, sessionToken));
  } catch (e) {
    res.status(500).send(`Launch failed: ${escapeHtml(e.message)}`);
  }
}

// Vercel gives parsed form bodies as objects; be defensive about array values.
function normalizeBody(body) {
  const out = {};
  Object.entries(body || {}).forEach(([k, v]) => {
    out[k] = Array.isArray(v) ? v[0] : v;
  });
  return out;
}

const strParam = (v) => (Array.isArray(v) ? v[0] : v) || "";

// Fetch the student's given name from Canvas for the standalone (non-LTI) launch.
async function fetchCanvasName(userId) {
  const baseUrl = env("CANVAS_BASE_URL", "");
  const token = env("CANVAS_API_TOKEN", "");
  if (!baseUrl || !token) return "there";
  const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/v1/users/${encodeURIComponent(userId)}/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return "there";
  const p = await r.json();
  return (p.short_name || p.name || "there").split(/\s+/)[0];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function renderShell(ctx, sessionToken) {
  const bootstrap = JSON.stringify({
    name: ctx.givenName || ctx.name,
    course: ctx.contextTitle,
    uid: ctx.userId || "anon",
    isStudent: ctx.isStudent,
    sessionToken,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>My Progress</title>
<link rel="stylesheet" href="/app.css"/>
</head>
<body>
<div id="root"></div>
<script>window.__BOOT__ = ${bootstrap};</script>
<script src="/app.js"></script>
</body>
</html>`;
}
