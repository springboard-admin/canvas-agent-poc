// Shared helpers: env access + a signed session cookie carrying launch context.
import { SignJWT, jwtVerify } from "jose";

const enc = new TextEncoder();

export function env(name, fallback = undefined) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

// ---- signed session cookie ----
export async function makeState(payload, exp = "8h") {
  const secret = enc.encode(env("STATE_SECRET"));
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(secret);
}

export async function readState(token) {
  const secret = enc.encode(env("STATE_SECRET"));
  const { payload } = await jwtVerify(token, secret);
  return payload;
}

// ---- cookie helpers ----
export function setCookie(res, name, value, maxAgeSec = 60 * 60 * 8) {
  res.setHeader("Set-Cookie", [
    `${name}=${value}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAgeSec}`,
  ]);
}

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}
