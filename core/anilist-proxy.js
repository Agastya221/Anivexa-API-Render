// POST /anilist — authenticated relay to AniList's GraphQL API.
//
// Why it exists: AniList blocks Cloudflare Workers' shared egress IPs, so a site hosted on
// Workers cannot reach it directly. This service runs on a different network, so the Worker
// sends its GraphQL requests here instead.
//
// Not an open relay: every request must carry the shared secret in `x-proxy-key`, matching
// the ANILIST_PROXY_KEY environment variable. With that variable unset the route is off.
import { getAsync, setAsync, isFresh } from "./smartcache.js";

const ANILIST_URL         = "https://graphql.anilist.co";
const MAX_BODY_CHARS      = 32 * 1024;
const CACHE_TTL_MS        = 15 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 15_000;

// Concurrent identical queries share one upstream request.
const inflight = new Map();

function readEnv(env, name) {
  const fromEnv = env?.[name];
  const value = fromEnv ?? (typeof process !== "undefined" ? process.env?.[name] : undefined);
  return typeof value === "string" ? value.trim() : "";
}

function reply(body, status = 200, extraHeaders = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function sha256Hex(text) {
  return Array.from(await sha256(text), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Compares fixed-length digests without an early exit, so timing does not leak how much of
// the secret matched.
async function sameSecret(provided, expected) {
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function fetchUpstream(body, authorization) {
  const response = await fetch(ANILIST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Tatakai-AniList-Proxy/1.0",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  return {
    status: response.status,
    text: await response.text(),
    retryAfter: response.headers.get("retry-after"),
  };
}

export async function handleAnilistProxy(request, env) {
  const secret = readEnv(env, "ANILIST_PROXY_KEY");
  if (!secret) return reply({ error: "AniList proxy is not configured" }, 503);

  const provided = request.headers.get("x-proxy-key") || "";
  if (!provided || !(await sameSecret(provided, secret))) return reply({ error: "Unauthorized" }, 401);

  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return reply({ error: "Request too large" }, 413);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return reply({ error: "Invalid JSON" }, 400);
  }
  if (!payload || typeof payload.query !== "string" || !payload.query.trim()) {
    return reply({ error: "Missing GraphQL query" }, 400);
  }

  const authorization = request.headers.get("authorization") || "";
  const body = JSON.stringify({ query: payload.query, variables: payload.variables ?? undefined });

  // Only anonymous reads are cached. Anything carrying a user's token, and every mutation,
  // is per-user or has side effects and must always reach AniList.
  const isMutation = /^\s*mutation\b/i.test(payload.query);
  const cacheable = !authorization && !isMutation;
  const cacheKey = cacheable ? `anilist-proxy:v1:${await sha256Hex(body)}` : null;

  if (cacheKey) {
    const entry = await getAsync(cacheKey);
    if (entry && isFresh(entry)) {
      return reply(entry.data.text, entry.data.status, { "X-AniList-Proxy": "hit" });
    }
  }

  try {
    let pending = cacheKey ? inflight.get(cacheKey) : null;
    if (!pending) {
      pending = fetchUpstream(body, authorization);
      if (cacheKey) {
        inflight.set(cacheKey, pending);
        pending.finally(() => inflight.delete(cacheKey)).catch(() => {});
      }
    }
    const result = await pending;

    if (cacheKey && result.status === 200) {
      let hasErrors = true;
      try { hasErrors = Boolean(JSON.parse(result.text)?.errors); } catch { /* not cacheable */ }
      if (!hasErrors) await setAsync(cacheKey, { status: 200, text: result.text }, CACHE_TTL_MS);
    }

    return reply(result.text, result.status, {
      "X-AniList-Proxy": "miss",
      ...(result.retryAfter ? { "Retry-After": result.retryAfter } : {}),
    });
  } catch (error) {
    return reply({ error: `AniList request failed: ${error?.message || "unknown error"}` }, 502);
  }
}

// POST /anilist/token — authenticated relay for AniList's OAuth token exchange.
//
// Signing in with AniList ends with the site's server swapping the one-time `code` for an
// access token at anilist.co. From a Cloudflare Worker that request is blocked for the same
// reason as the GraphQL ones above, so the sign-in fails. The Worker sends it here instead.
//
// Same protection as /anilist: the shared `x-proxy-key` is required. On top of that this only
// forwards the authorization-code grant, with exactly the fields that grant uses, so it cannot
// be used as a general-purpose relay to anilist.co.
const ANILIST_TOKEN_URL = "https://anilist.co/api/v2/oauth/token";
const TOKEN_FIELDS = ["grant_type", "client_id", "client_secret", "redirect_uri", "code"];

export async function handleAnilistTokenProxy(request, env) {
  const secret = readEnv(env, "ANILIST_PROXY_KEY");
  if (!secret) return reply({ error: "AniList proxy is not configured" }, 503);

  const provided = request.headers.get("x-proxy-key") || "";
  if (!provided || !(await sameSecret(provided, secret))) return reply({ error: "Unauthorized" }, 401);

  const raw = await request.text();
  if (raw.length > 4 * 1024) return reply({ error: "Request too large" }, 413);

  // Auth.js sends the form-encoded body OAuth specifies; accept JSON as well.
  let fields;
  try {
    const type = request.headers.get("content-type") || "";
    fields = type.includes("application/json")
      ? JSON.parse(raw)
      : Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return reply({ error: "Invalid body" }, 400);
  }
  if (!fields || typeof fields !== "object" || fields.grant_type !== "authorization_code") {
    return reply({ error: "Only the authorization_code grant is relayed" }, 400);
  }
  const body = new URLSearchParams();
  for (const name of TOKEN_FIELDS) {
    if (typeof fields[name] === "string" && fields[name]) body.set(name, fields[name]);
  }
  if (!body.get("code") || !body.get("client_id") || !body.get("redirect_uri")) {
    return reply({ error: "Missing code, client_id or redirect_uri" }, 400);
  }

  try {
    const upstream = await fetch(ANILIST_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "Tatakai-AniList-Proxy/1.0",
      },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return reply(await upstream.text(), upstream.status);
  } catch (error) {
    return reply({ error: `AniList token request failed: ${error?.message || "unknown error"}` }, 502);
  }
}

// Shared by the other proxy routes (core/linkstore.js): null when the request carries the
// right x-proxy-key, otherwise the error response to send.
export async function authorizeProxyRequest(request, env) {
  const secret = readEnv(env, "ANILIST_PROXY_KEY");
  if (!secret) return reply({ error: "Proxy is not configured" }, 503);
  const provided = request.headers.get("x-proxy-key") || "";
  if (!provided || !(await sameSecret(provided, secret))) return reply({ error: "Unauthorized" }, 401);
  return null;
}

export { reply as proxyReply };
