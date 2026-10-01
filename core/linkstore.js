// POST /linkstore — authenticated key/value store for the site's resolved stream links.
//
// The site stores a stream link the first time an episode is resolved and reuses it until it
// stops working (see lib/stream-store.ts in the site repo). That store used Cloudflare KV, which
// allows only 1,000 writes a day on the free plan; this keeps the links in the Redis this service
// already uses, which has no daily write cap. The Worker reaches it through here so no Redis
// credentials ever leave this service.
//
// Not an open Redis proxy: every request needs the shared x-proxy-key, keys and prefixes must
// begin with "stream-link:", and prefixes may not contain glob characters.
import { redisConfigured, redisRaw } from "./smartcache.js";
import { authorizeProxyRequest, proxyReply as reply } from "./anilist-proxy.js";

const KEY_PREFIX = "stream-link:";
const MAX_KEY_CHARS = 300;
const MAX_VALUE_CHARS = 256 * 1024;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 90 * 24 * 60 * 60;
const SCAN_PAGE = 200;
const SCAN_PAGES_MAX = 50;

const validKey = (key) =>
  typeof key === "string" && key.startsWith(KEY_PREFIX) && key.length <= MAX_KEY_CHARS && !/[\s*?[\]\\]/.test(key);

export async function handleLinkStore(request, env) {
  const denied = await authorizeProxyRequest(request, env);
  if (denied) return denied;

  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return reply({ error: "Invalid JSON" }, 400);
  }
  const op = body?.op;
  // Checked after the input is validated, so bad requests are rejected the same everywhere.
  const unavailable = () => (redisConfigured() ? null : reply({ error: "Redis is not configured", disabled: true }, 503));

  if (op === "get") {
    if (!validKey(body.key)) return reply({ error: "Invalid key" }, 400);
    const down = unavailable();
    if (down) return down;
    const value = await redisRaw(["GET", body.key]);
    return reply({ value: typeof value === "string" ? value : null });
  }

  if (op === "set") {
    if (!validKey(body.key)) return reply({ error: "Invalid key" }, 400);
    if (typeof body.value !== "string" || !body.value || body.value.length > MAX_VALUE_CHARS) {
      return reply({ error: "Invalid value" }, 400);
    }
    const down = unavailable();
    if (down) return down;
    const ttl = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(Number(body.ttlSeconds) || MAX_TTL_SECONDS)));
    const result = await redisRaw(["SET", body.key, body.value, "EX", ttl]);
    return reply({ ok: result === "OK" });
  }

  if (op === "del") {
    if (!validKey(body.key)) return reply({ error: "Invalid key" }, 400);
    const down = unavailable();
    if (down) return down;
    await redisRaw(["DEL", body.key]);
    return reply({ ok: true });
  }

  if (op === "delprefix") {
    if (!validKey(body.prefix)) return reply({ error: "Invalid prefix" }, 400);
    const down = unavailable();
    if (down) return down;
    let cursor = "0";
    let deleted = 0;
    for (let page = 0; page < SCAN_PAGES_MAX; page += 1) {
      const result = await redisRaw(["SCAN", cursor, "MATCH", `${body.prefix}*`, "COUNT", SCAN_PAGE]);
      if (!Array.isArray(result)) break;
      const [next, keys] = result;
      if (Array.isArray(keys) && keys.length) {
        await redisRaw(["DEL", ...keys]);
        deleted += keys.length;
      }
      cursor = String(next);
      if (cursor === "0") break;
    }
    return reply({ ok: true, deleted });
  }

  return reply({ error: "Unknown op" }, 400);
}
