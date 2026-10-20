// Transport: how sekai reaches the network.
//
//   direct  plain fetch, headers attached locally (Node, scripts)
//   worker  every request goes through a sekai fetch worker, which can set
//           headers a page cannot (Referer, Origin, ...) and is not CORS-bound
//
// Both expose:
//   request(url, opts)  -> Response
//   playback(url, opts) -> { url, headers }   what a player should load

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 20_000;

function resolveFetch(fetchImpl) {
  const impl = fetchImpl || globalThis.fetch;
  if (typeof impl !== "function") throw new Error("no fetch implementation available");
  return impl;
}

export function createDirectTransport({ fetchImpl } = {}) {
  const doFetch = resolveFetch(fetchImpl);
  return {
    kind: "direct",
    async request(url, { method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      return doFetch(String(url), {
        method,
        headers: { "user-agent": BROWSER_UA, ...headers },
        body,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
    },
    playback(url, { headers = {} } = {}) {
      return { url: String(url), headers };
    },
  };
}

export function createWorkerTransport({ endpoint, fetchImpl } = {}) {
  if (typeof endpoint !== "string" || !endpoint) throw new Error("worker endpoint url is required");
  const doFetch = resolveFetch(fetchImpl);
  const base = endpoint.replace(/\?.*$/, "").replace(/\/+$/, "");

  // The worker caches by target url alone, so a plain fetch and a rewritten
  // playback fetch of the same url would share an entry and the player would get
  // back an un-rewritten playlist. Fragments keep the two apart and are never
  // sent upstream.
  const tag = (url, suffix) => {
    const value = String(url);
    return value.includes("#") ? value : value + suffix;
  };

  return {
    kind: "worker",
    endpoint: base,
    async request(url, { method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      // GET with query params only: a simple request never triggers a preflight.
      const params = new URLSearchParams({ url: tag(url, "#sekai-fetch") });
      if (method !== "GET") params.set("method", method);
      if (Object.keys(headers).length) params.set("headers", JSON.stringify(headers));
      if (typeof body === "string") params.set("body", body);
      return doFetch(`${base}/?${params}`, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
    },
    playback(url, { headers = {}, cache } = {}) {
      const params = new URLSearchParams({ url: tag(url, "#sekai-play"), rewrite: "1" });
      if (Object.keys(headers).length) params.set("headers", JSON.stringify(headers));
      if (cache != null) params.set("cache", String(cache));
      return { url: `${base}/?${params}`, headers: {} };
    },
  };
}

export function createTransport({ worker, transport, fetchImpl } = {}) {
  if (transport) return transport;
  return worker ? createWorkerTransport({ endpoint: worker, fetchImpl }) : createDirectTransport({ fetchImpl });
}
