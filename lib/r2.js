// Minimal Cloudflare R2 client (S3 API, SigV4) — GET/PUT a single object. Zero deps:
// signs with node:crypto. Feature-flagged: if any R2_* env is missing, calls no-op (null),
// so the agent runs memoryless without crashing. Used for the per-student memory markdown.
import { createHash, createHmac } from "node:crypto";
import { env } from "./lti.js";

function cfg() {
  const account = env("R2_ACCOUNT_ID", "");
  const bucket = env("R2_BUCKET", "");
  const ak = env("R2_ACCESS_KEY_ID", "");
  const sk = env("R2_SECRET_ACCESS_KEY", "");
  if (!account || !bucket || !ak || !sk) return null;
  return { account, bucket, ak, sk, host: `${account}.r2.cloudflarestorage.com`, region: "auto", service: "s3" };
}
export function r2Enabled() { return cfg() != null; }

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const hmac = (key, s) => createHmac("sha256", key).update(s).digest();
const encPath = (key, bucket) => "/" + bucket + "/" + String(key).split("/").map(encodeURIComponent).join("/");

async function r2Fetch(method, key, body) {
  const c = cfg();
  if (!c) return null;
  const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const datestamp = amzdate.slice(0, 8);
  const uri = encPath(key, c.bucket);
  const payloadHash = sha256hex(body ?? "");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `host:${c.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzdate}\n`;
  const canonicalRequest = [method, uri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${datestamp}/${c.region}/${c.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzdate, scope, sha256hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + c.sk, datestamp), c.region), c.service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${c.ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  // `host` is set by the runtime from the URL (undici forbids setting it) — it still matches
  // the signed host, so the signature validates.
  const headers = { "x-amz-date": amzdate, "x-amz-content-sha256": payloadHash, authorization };
  if (body != null) headers["content-type"] = "text/markdown; charset=utf-8";
  return fetch(`https://${c.host}${uri}`, { method, headers, body: body ?? undefined });
}

// Returns the object text, "" if it doesn't exist yet, or null if R2 is not configured.
export async function r2Get(key) {
  const r = await r2Fetch("GET", key, null);
  if (!r) return null;
  if (r.status === 404) return "";
  if (!r.ok) throw new Error(`r2 GET ${r.status}`);
  return r.text();
}

// Overwrites the object. Returns true, or false if R2 is not configured.
export async function r2Put(key, text) {
  const r = await r2Fetch("PUT", key, text ?? "");
  if (!r) return false;
  if (!r.ok) throw new Error(`r2 PUT ${r.status}`);
  return true;
}
