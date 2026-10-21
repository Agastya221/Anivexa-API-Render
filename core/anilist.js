const __name = (fn, _) => fn;
import { redisConfigured, redisRaw } from "./smartcache.js";

var resolved = new Map();
var inflight = new Map();
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var ARM = "https://arm.haglund.dev/api/v2/ids";
var ANILIST_WEB = "https://anilist.co";

const AL_STATUS_MAP = {
  RELEASING: "RELEASING",
  FINISHED: "FINISHED",
  NOT_YET_RELEASED: "NOT_YET_RELEASED",
  CANCELLED: "FINISHED",
  HIATUS: "HIATUS",
};

function cookiesFromHeaders(headers) {
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")].filter(Boolean);
  return values.map((value) => String(value).split(";")[0]).join("; ");
}

async function mediaFromResponse(res) {
  if (!res?.ok) return null;
  try {
    const json = await res.json();
    return json.data?.Media ?? null;
  } catch {
    return null;
  }
}

async function fetchFromAniListWeb(body) {
  const home = await fetch(`${ANILIST_WEB}/`, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  }).catch(() => null);
  if (!home?.ok) return null;
  const html = await home.text();
  const token = html.match(/window\.al_token\s*=\s*"([^"]+)"/)?.[1];
  const cookie = cookiesFromHeaders(home.headers);
  if (!token || !cookie) return null;
  const res = await fetch(`${ANILIST_WEB}/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
      Referer: `${ANILIST_WEB}/home`,
      "x-csrf-token": token,
      schema: "default",
      Cookie: cookie,
    },
    body,
  }).catch(() => null);
  return mediaFromResponse(res);
}

async function fetchFromAniList(id) {
  const fullQuery = `query($id:Int){Media(id:$id,type:ANIME){id idMal title{english romaji native} status format episodes seasonYear startDate{year} genres synonyms nextAiringEpisode{episode airingAt timeUntilAiring}}}`;
  const body = JSON.stringify({ query: fullQuery, variables: { id } });
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA },
    body,
  }).catch(() => null);
  return await mediaFromResponse(res) ?? fetchFromAniListWeb(body);
}

// ── Keeping lookups alive when AniList is down ──────────────────────────────
//
// Every stream lookup starts here, so an AniList outage used to fail every show not already in
// memory ("No data found for AniList ID ..."). 2026-10-22: AniList answered 403 "temporarily
// disabled due to severe stability issues" and 19 of 20 popular shows failed while their streams
// were fine. Now:
//   1. a successful AniList answer is also kept in Redis (14 days), so a restart or an outage
//      can fall back to it;
//   2. with no AniList and no saved copy, the show is built from ani.zip (titles, MAL id, type,
//      episode dates; it answers when AniList does not). That copy is kept only briefly, so the
//      real AniList data replaces it as soon as AniList is back.
// The fallback never invents an airing schedule: ani.zip's dates come from TheTVDB and can be a
// week off AniList's, which would wrongly block an episode that has aired.

const MEDIA_KEY = (id) => `al-media:v1:${id}`;
const MEDIA_REDIS_TTL = 14 * 24 * 60 * 60;
const FALLBACK_MEMORY_MS = 30 * 60 * 1000;
const ANIZIP = "https://api.ani.zip/mappings";
const fallbackExpiry = new Map();

async function readSavedMedia(id) {
  if (!redisConfigured()) return null;
  const raw = await redisRaw(["GET", MEDIA_KEY(id)]);
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveMedia(id, media) {
  if (!redisConfigured()) return;
  redisRaw(["SET", MEDIA_KEY(id), JSON.stringify(media), "EX", MEDIA_REDIS_TTL]).catch(() => {});
}

/** An AniList-shaped record built from ani.zip, or null when ani.zip has nothing either. */
async function fetchFromAniZip(id) {
  const res = await fetch(`${ANIZIP}?anilist_id=${id}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const data = await res.json().catch(() => null);
  const titles = data?.titles ?? {};
  const english = titles.en ?? null;
  const romaji = titles["x-jat"] ?? null;
  if (!english && !romaji) return null;

  const now = Date.now();
  const dates = Object.values(data.episodes ?? {})
    .filter((episode) => Number(episode?.episodeNumber) > 0)
    .map((episode) => Date.parse(episode.airDate || episode.airdate || ""))
    .filter((time) => Number.isFinite(time))
    .sort((left, right) => left - right);
  const aired = dates.filter((time) => time <= now).length;
  const count = Number(data.episodeCount) > 0 ? Number(data.episodeCount) : null;
  const status = dates.length > 0 && aired === 0
    ? "NOT_YET_RELEASED"
    : count && aired >= count && dates.length >= count
      ? "FINISHED"
      : "RELEASING";
  const first = dates.length ? new Date(dates[0]) : null;

  return {
    idMal: Number(data.mappings?.mal_id) || null,
    title: { english, romaji, native: titles.ja ?? null },
    status,
    format: data.mappings?.type ?? null,
    episodes: status === "FINISHED" ? count : null,
    seasonYear: first ? first.getUTCFullYear() : null,
    startDate: first ? { year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, day: first.getUTCDate() } : null,
    nextAiringEpisode: null,
    genres: [],
    synonyms: [titles["x-kot"], titles.fr].filter((title) => title && title !== english && title !== romaji),
  };
}

function toMedia(id, al, arm) {
  return {
    id,
    idMal: al.idMal ?? arm?.myanimelist ?? null,
    title: {
      english: al.title?.english ?? null,
      romaji: al.title?.romaji ?? null,
      native: al.title?.native ?? null,
    },
    status: AL_STATUS_MAP[al.status] ?? "RELEASING",
    format: al.format ?? null,
    episodes: al.episodes ?? null,
    seasonYear: al.seasonYear ?? null,
    startDate: al.startDate ?? null,
    nextAiringEpisode: al.nextAiringEpisode ?? null,
    genres: Array.isArray(al.genres) ? al.genres : [],
    synonyms: Array.isArray(al.synonyms) ? al.synonyms : [],
  };
}

async function getMedia(anilistId) {
  const id = Number(anilistId);
  if (resolved.has(id)) {
    const expiresAt = fallbackExpiry.get(id);
    if (!expiresAt || expiresAt > Date.now()) return resolved.get(id);
    // A fallback record has had its turn: ask AniList again.
    resolved.delete(id);
    fallbackExpiry.delete(id);
  }
  if (inflight.has(id)) return inflight.get(id);
  const promise = (async () => {
    const [arm, al] = await Promise.all([
      fetch(`${ARM}?source=anilist&id=${id}`, {
        headers: { "User-Agent": UA, "Accept": "application/json" }
      }).then((r) => {
        if (!r.ok) return null;
        return r.json();
      }).catch(() => null),
      fetchFromAniList(id).catch(() => null),
    ]);

    let media;
    if (al) {
      media = toMedia(id, al, arm);
      saveMedia(id, media);
      fallbackExpiry.delete(id);
    } else {
      // AniList did not answer: the last good AniList copy, then ani.zip.
      const saved = await readSavedMedia(id);
      if (saved) {
        media = saved;
        console.warn(`[anilist] AniList unavailable; using the saved copy for ${id}`);
      } else {
        const fromAniZip = await fetchFromAniZip(id).catch(() => null);
        if (!fromAniZip) throw new Error(`No data found for AniList ID ${id}`);
        media = { id, ...fromAniZip, idMal: fromAniZip.idMal ?? arm?.myanimelist ?? null };
        console.warn(`[anilist] AniList unavailable; built ${id} from ani.zip ("${media.title.english || media.title.romaji}")`);
      }
      fallbackExpiry.set(id, Date.now() + FALLBACK_MEMORY_MS);
    }
    resolved.set(id, media);
    inflight.delete(id);
    return media;
  })().catch((e) => {
    inflight.delete(id);
    throw e;
  });
  inflight.set(id, promise);
  return promise;
}
__name(getMedia, "getMedia");

function forgetMedia(anilistId) {
  resolved.delete(Number(anilistId));
}

export { getMedia, forgetMedia };
