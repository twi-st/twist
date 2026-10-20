// megaplay.buzz provider: stream page -> data-id -> getSources -> decrypt ->
// signed m3u8 url. All network access goes through a transport, so the same code
// runs in Node and, via a fetch worker, in the browser.

import { fetchJson, fetchText, HttpError } from "../lib/http.js";
import { BROWSER_UA, createTransport } from "../lib/transport.js";
import { decryptSourcesPayload, attachCdnToken, CDN_TOKEN_TTL_SECONDS } from "../lib/crypto.js";
import { TtlCache } from "../lib/cache.js";

const BASE_URL = "https://megaplay.buzz";
const PLAYER_REFERER = "https://megaplay.buzz/";
const PLAYER_ORIGIN = "https://megaplay.buzz";
const STREAM_TYPES = ["sub", "dub", "hsub"];

// The stream page only requires some non-empty referer.
const PAGE_REFERER = "https://example.com/";

const LABEL_LANGS = {
  arabic: "ar",
  english: "en",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  russian: "ru",
  spanish: "es",
};

const FILE_LANGS = { ara: "ar", eng: "en", fre: "fr", ger: "de", ita: "it", por: "pt", rus: "ru", spa: "es" };

export class MegaplayError extends Error {
  constructor(message, { status = 500, cause } = {}) {
    super(message, { cause });
    this.name = "MegaplayError";
    this.status = status;
  }
}

function normalizeType(type) {
  const value = String(type || "sub").toLowerCase();
  if (!STREAM_TYPES.includes(value)) {
    throw new MegaplayError(`unsupported type "${type}" (expected ${STREAM_TYPES.join(", ")})`, { status: 400 });
  }
  return value;
}

function guessLanguage(label, file) {
  const name = String(label || "")
    .toLowerCase()
    .replace(/\s*\(.*$/, "")
    .trim();
  if (LABEL_LANGS[name]) return LABEL_LANGS[name];
  const code = String(file || "")
    .split("/")
    .pop()
    .split(".")[0]
    .split("-")[0]
    .toLowerCase();
  return FILE_LANGS[code] || code || "und";
}

function buildStreamUrl({ malId, episode, type = "sub" }) {
  const mal = Number.parseInt(malId, 10);
  const ep = Number.parseInt(episode, 10);
  if (!Number.isFinite(mal) || mal <= 0) throw new MegaplayError("malId must be a positive integer", { status: 400 });
  if (!Number.isFinite(ep) || ep <= 0) throw new MegaplayError("episode must be a positive integer", { status: 400 });
  return `${BASE_URL}/stream/mal/${mal}/${ep}/${normalizeType(type)}`;
}

/** Accepts { malId, episode, type }, a full url, or a path like /stream/s-2/136372/sub. */
function normalizeInput(input) {
  if (typeof input === "string") {
    const url = input.startsWith("/") ? `${BASE_URL}${input}` : input;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new MegaplayError(`invalid stream url: ${input}`, { status: 400 });
    }
    if (!/(^|\.)megaplay\.buzz$/i.test(parsed.hostname)) {
      throw new MegaplayError(`not a megaplay url: ${input}`, { status: 400 });
    }
    const parts = parsed.pathname.split("/").filter(Boolean); // stream / mal / 21 / 1 / dub
    const isMal = parts[1] === "mal";
    return {
      streamUrl: url,
      type: parts.at(-1) || "sub",
      malId: isMal ? Number.parseInt(parts[2], 10) : null,
      episode: isMal ? Number.parseInt(parts[3], 10) : null,
    };
  }
  if (input && typeof input === "object") {
    if (input.url) return normalizeInput(input.url);
    return {
      streamUrl: buildStreamUrl(input),
      type: normalizeType(input.type),
      malId: Number.parseInt(input.malId, 10),
      episode: Number.parseInt(input.episode, 10),
    };
  }
  throw new MegaplayError("resolve() expects { malId, episode, type } or a stream url", { status: 400 });
}

/** Renditions advertised by an HLS master playlist, highest bandwidth first. */
function parseMasterPlaylist(text, baseUrl) {
  const lines = String(text).split(/\r?\n/);
  const renditions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const uri = (lines[i + 1] || "").trim();
    if (!uri || uri.startsWith("#")) continue;
    const attr = (name) => line.match(new RegExp(`${name}=("[^"]*"|[^,]*)`))?.[1]?.replace(/"/g, "") ?? null;
    const bandwidth = Number.parseInt(attr("BANDWIDTH") || attr("AVERAGE-BANDWIDTH") || "", 10) || null;
    const resolution = attr("RESOLUTION");
    const height = resolution ? Number.parseInt(resolution.split("x")[1], 10) : NaN;
    renditions.push({
      url: new URL(uri, baseUrl).toString(),
      bandwidth,
      resolution: resolution || null,
      height: Number.isFinite(height) ? height : null,
      frame_rate: Number.parseFloat(attr("FRAME-RATE") || "") || null,
      label: Number.isFinite(height) && height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)}kbps` : "auto",
    });
  }
  return renditions.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
}

/**
 * @param {object} [options]
 * @param {object} [options.transport]    network backend (default: direct fetch)
 * @param {number} [options.tokenTtlSeconds]
 * @param {string} [options.pageReferer]  referer used for the stream page
 * @param {number} [options.pageTtlMs]    stream page cache
 * @param {number} [options.sourcesTtlMs] getSources cache
 */
export function createMegaplay({
  transport = createTransport(),
  tokenTtlSeconds = CDN_TOKEN_TTL_SECONDS,
  pageReferer = PAGE_REFERER,
  pageTtlMs = 10 * 60_000,
  sourcesTtlMs = 45_000,
} = {}) {
  const pageCache = new TtlCache({ ttlMs: pageTtlMs });
  const sourcesCache = new TtlCache({ ttlMs: sourcesTtlMs, max: 1000 });
  const playlistCache = new TtlCache({ ttlMs: 5 * 60_000 });

  async function getStreamPage(streamUrl) {
    return pageCache.remember(streamUrl, async () => {
      let html;
      try {
        html = await fetchText(streamUrl, { headers: { referer: pageReferer }, transport });
      } catch (err) {
        throw new MegaplayError(`stream page failed: ${err.message}`, {
          status: err instanceof HttpError ? err.status || 502 : 502,
          cause: err,
        });
      }
      const dataId = html.match(/data-id="([^"]+)"/)?.[1];
      if (!dataId) throw new MegaplayError("stream id not found on page (invalid route or blocked)", { status: 404 });
      return { dataId, type: html.match(/type:\s*'([^']+)'/)?.[1] ?? null };
    });
  }

  async function getSources(dataId) {
    return sourcesCache.remember(dataId, async () => {
      const url = `${BASE_URL}/stream/getSources?id=${encodeURIComponent(dataId)}&platform=OTHER&_=${Date.now()}`;
      let json;
      try {
        json = await fetchJson(url, {
          headers: { "x-requested-with": "XMLHttpRequest", referer: `${BASE_URL}/` },
          transport,
        });
      } catch (err) {
        throw new MegaplayError(`getSources failed: ${err.message}`, {
          status: err instanceof HttpError ? err.status || 502 : 502,
          cause: err,
        });
      }
      if (json.error) throw new MegaplayError(json.message || String(json.error), { status: 404 });

      let payload;
      if (json.enc) {
        try {
          payload = await decryptSourcesPayload(json.enc);
        } catch (err) {
          throw new MegaplayError(`could not decrypt sources: ${err.message}`, { status: 502, cause: err });
        }
      } else {
        payload = json.sources;
      }
      if (!payload || typeof payload.file !== "string") {
        throw new MegaplayError("sources response did not contain a file url", { status: 502 });
      }
      return {
        file: payload.file,
        tracks: Array.isArray(json.tracks) ? json.tracks : Array.isArray(payload.tracks) ? payload.tracks : [],
        intro: json.intro ?? null,
        outro: json.outro ?? null,
        server: json.server ?? null,
      };
    });
  }

  async function getRenditions(file) {
    return playlistCache.remember(file, async () => {
      try {
        const text = await fetchText(file, {
          headers: { referer: PLAYER_REFERER, origin: PLAYER_ORIGIN },
          transport,
        });
        return parseMasterPlaylist(text, file);
      } catch {
        return [];
      }
    });
  }

  /**
   * Resolve a stream to direct playable sources.
   * @param {{ malId, episode, type }|string} input
   * @param {{ tokenTtlSeconds?: number, qualities?: boolean }} [options]
   */
  async function resolve(input, { tokenTtlSeconds: ttl = tokenTtlSeconds, qualities: withQualities = true } = {}) {
    const { streamUrl, type, malId, episode } = normalizeInput(input);
    const page = await getStreamPage(streamUrl);
    const sources = await getSources(page.dataId);

    const headers = { Referer: PLAYER_REFERER, Origin: PLAYER_ORIGIN, "User-Agent": BROWSER_UA };
    const m3u8 = await attachCdnToken(sources.file, { ttlSeconds: ttl });
    const renditions = withQualities ? await getRenditions(sources.file) : [];

    const playback = (url) => transport.playback(url, { headers });

    return {
      provider: "megaplay",
      stream_url: streamUrl,
      mal_id: malId,
      episode,
      type: page.type || type,
      data_id: page.dataId,
      server: sources.server,
      m3u8,
      multi_quality: renditions.length > 1,
      qualities: await Promise.all(
        renditions.map(async (rendition) => {
          const url = await attachCdnToken(rendition.url, { ttlSeconds: ttl });
          return {
            label: rendition.label,
            resolution: rendition.resolution,
            bandwidth: rendition.bandwidth,
            frame_rate: rendition.frame_rate,
            url,
            playback: playback(url),
          };
        }),
      ),
      referer: PLAYER_REFERER,
      origin: PLAYER_ORIGIN,
      playback: { mode: transport.kind, ...playback(m3u8) },
      subtitles: sources.tracks.map((track) => ({
        url: track.file,
        label: track.label || "Unknown",
        language: guessLanguage(track.label, track.file),
        default: Boolean(track.default),
        playback: playback(track.file),
      })),
      intro: sources.intro,
      outro: sources.outro,
      token_expires_in: ttl,
      fetched_at: new Date().toISOString(),
    };
  }

  return {
    name: "megaplay",
    baseUrl: BASE_URL,
    referer: PLAYER_REFERER,
    origin: PLAYER_ORIGIN,
    transport,
    buildStreamUrl,
    getStreamPage,
    getSources,
    resolve,
  };
}

export const megaplay = createMegaplay();
