// Tiny in-memory session store for the POC.
// NOTE: Vercel serverless instances are ephemeral and not shared, so this is
// only "good enough" for a single-user demo. For anything beyond a POC, swap
// for Vercel KV / Upstash Redis. The launch flow also embeds the session id in
// a signed cookie, so the frontend works even if this map is cold.
const sessions = new Map();

export function putSession(id, data) {
  sessions.set(id, { ...data, ts: Date.now() });
}

export function getSession(id) {
  return sessions.get(id);
}
