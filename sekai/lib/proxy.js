// Node streaming relay used by the HTTP API: re-fetches CDN urls with the
// headers a player cannot set and rewrites playlists so variants and segments
// keep flowing through the server. In the browser, worker/index.js does the job.

import { Readable } from "node:stream";
import { attachCdnToken, extractPathKey } from "./crypto.js";
import { BROWSER_UA } from "./http.js";

// Responses from these hosts carry a 252-byte prefix that has to be stripped.
const STRIP_HOST_RE = /(^|\.)(ibyteimg\.com|tiktokcdn\.com|ipstatp\.com|yoot\.akirax\.buzz)$/i;
const STRIP_BYTES = 252;

export function encodeUpstream(url) {
  return Buffer.from(String(url), "utf8").toString("base64url");
}

export function decodeUpstream(encoded) {
  const url = Buffer.from(String(encoded), "base64url").toString("utf8");
  if (!/^https?:\/\//i.test(url)) throw new Error("invalid upstream url");
  return url;
}

async function proxify(rawUrl, base, proxyBase) {
  let absolute;
  try {
    absolute = new URL(rawUrl, base).toString();
  } catch {
    return rawUrl;
  }
  const signed = extractPathKey(absolute) ? await attachCdnToken(absolute) : absolute;
  return `${proxyBase}/proxy?u=${encodeURIComponent(encodeUpstream(signed))}`;
}

async function rewritePlaylist(text, upstreamUrl, proxyBase) {
  const base = new URL(upstreamUrl);
  const lines = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      lines.push(line);
    } else if (!trimmed.startsWith("#")) {
      lines.push(await proxify(trimmed, base, proxyBase));
    } else {
      let replaced = line;
      for (const match of line.matchAll(/URI="([^"]+)"/g)) {
        replaced = replaced.replace(match[0], `URI="${await proxify(match[1], base, proxyBase)}"`);
      }
      lines.push(replaced);
    }
  }
  return lines.join("\n");
}

function sendJsonError(res, status, message) {
  const body = Buffer.from(JSON.stringify({ ok: false, error: message }), "utf8");
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": "application/json",
    "content-length": body.length,
  });
  res.end(body);
}

/**
 * Relay an upstream url to the client.
 * @param {object} options { proxyBase, referer, origin, userAgent }
 */
export async function handleStreamProxy(req, res, upstreamUrl, { proxyBase, referer, origin, userAgent = BROWSER_UA }) {
  const headers = {
    "user-agent": userAgent,
    "accept-encoding": "identity",
    ...(referer ? { referer } : {}),
    ...(origin ? { origin } : {}),
    ...(req.headers.range ? { range: req.headers.range } : {}),
  };

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, { headers, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    return sendJsonError(res, 502, `upstream fetch failed: ${err.message}`);
  }
  if (!upstream.ok && upstream.status !== 206) {
    return sendJsonError(res, 502, `upstream responded ${upstream.status}`);
  }

  const contentType = upstream.headers.get("content-type") || "";
  const isPlaylist = /mpegurl/i.test(contentType) || /\.m3u8($|\?)/i.test(upstreamUrl);

  try {
    if (isPlaylist) {
      const body = Buffer.from(await rewritePlaylist(await upstream.text(), upstreamUrl, proxyBase), "utf8");
      res.writeHead(upstream.status, {
        "access-control-allow-origin": "*",
        "content-type": "application/vnd.apple.mpegurl",
        "cache-control": "no-store",
        "content-length": body.length,
      });
      return res.end(body);
    }

    if (STRIP_HOST_RE.test(new URL(upstreamUrl).hostname)) {
      const raw = Buffer.from(await upstream.arrayBuffer());
      const body = raw.length > STRIP_BYTES ? raw.subarray(STRIP_BYTES) : raw;
      res.writeHead(upstream.status, {
        "access-control-allow-origin": "*",
        "content-type": contentType || "application/octet-stream",
        "content-length": body.length,
        ...(upstream.headers.get("content-range") ? { "content-range": upstream.headers.get("content-range") } : {}),
      });
      return res.end(body);
    }

    res.writeHead(upstream.status, {
      "access-control-allow-origin": "*",
      "content-type": contentType || "application/octet-stream",
      ...(upstream.headers.get("content-length") ? { "content-length": upstream.headers.get("content-length") } : {}),
      ...(upstream.headers.get("content-range") ? { "content-range": upstream.headers.get("content-range") } : {}),
      ...(upstream.headers.get("accept-ranges") ? { "accept-ranges": upstream.headers.get("accept-ranges") } : {}),
    });
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (!res.headersSent) return sendJsonError(res, 502, `relay failed: ${err.message}`);
    res.destroy();
  }
}
