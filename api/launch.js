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
    if (req.method !== "POST") {
      // A GET here is usually someone opening the URL directly, not a launch.
      res.status(405).send("This endpoint expects an LTI POST launch.");
      return;
    }

    const p = normalizeBody(req.body);

    // ---- verify OAuth 1.0 signature ----
    const key = p.oauth_consumer_key;
    if (key !== env("LTI_CONSUMER_KEY")) {
      res.status(401).send("Unknown oauth_consumer_key");
      return;
    }
    const { ok } = verify(
      "POST",
      launchUrl(req),
      p,
      env("LTI_SHARED_SECRET")
    );
    if (!ok) {
      res.status(401).send("Invalid LTI signature");
      return;
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function renderShell(ctx, sessionToken) {
  const bootstrap = JSON.stringify({
    name: ctx.givenName || ctx.name,
    course: ctx.contextTitle,
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
