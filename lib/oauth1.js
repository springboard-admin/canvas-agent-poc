// Minimal OAuth 1.0 (HMAC-SHA1) verification for LTI 1.1 launches.
// Canvas signs the form-POST body with a shared secret; we recompute the
// signature and compare. Reference: LTI 1.1 uses OAuth 1.0 body signing.
import crypto from "node:crypto";

// RFC 3986 percent-encoding (stricter than encodeURIComponent).
function enc(v) {
  return encodeURIComponent(String(v)).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// Reconstruct the launch URL as Canvas saw it (behind Vercel's proxy).
export function launchUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const path = (req.url || "/api/launch").split("?")[0];
  return `${proto}://${host}${path}`;
}

// params: all POST body params (already parsed to an object of strings).
// Returns { ok, expected, provided }.
export function verify(method, url, params, consumerSecret, tokenSecret = "") {
  const provided = params.oauth_signature;
  const base = Object.entries(params)
    .filter(([k]) => k !== "oauth_signature")
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const baseString = `${method.toUpperCase()}&${enc(url)}&${enc(base)}`;
  const signingKey = `${enc(consumerSecret)}&${enc(tokenSecret)}`;
  const expected = crypto
    .createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  const ok =
    !!provided &&
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

  return { ok, expected, provided };
}
