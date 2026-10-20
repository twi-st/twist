# sekai

Resolves `megaplay.buzz` streams to direct playable `m3u8` sources — by MAL id —
with the headers a player needs, subtitles, renditions and intro/outro markers.

The same provider code runs two ways:

- **Node** — plain `fetch`, plus a streaming relay (`/megaplay/proxy`) for
  browser playback.
- **Browser** — entirely client-side through a Cloudflare fetch worker, which is
  not CORS-bound and can set headers a page cannot.

## Run

```bash
bash sekai.sh          # Node API on http://127.0.0.1:8787
node demo/plys.js      # worker-backed demo on http://127.0.0.1:8000/plyr.html
```

## Library

```js
import sekai from "sekai";

const source = await sekai.megaplay.resolve({ malId: 21, episode: 1, type: "dub" });

source.m3u8;          // master.m3u8 url (token signed)
source.playback;      // { mode, url, headers } — what a player should load
source.qualities;     // [{ label: "1080p", resolution, bandwidth, url, playback }]
source.multi_quality; // more than one rendition advertised
source.subtitles;     // [{ url, label, language, default, playback }]
source.referer;       // "https://megaplay.buzz/"
source.origin;        // "https://megaplay.buzz"
source.intro;         // { start, end } | null
```

A raw stream url works too:

```js
await sekai.megaplay.resolve("https://megaplay.buzz/stream/s-2/136372/sub");
```

### Playing

The CDN only answers requests with `Referer: https://megaplay.buzz/`, which a
page cannot set. Native players can:

```bash
mpv --http-header-fields="Referer: https://megaplay.buzz/,Origin: https://megaplay.buzz" "<m3u8>"
```

Browsers must go through the Node relay (`/megaplay/proxy`) or the worker.

## Browser (fetch worker)

```bash
npx wrangler deploy -c worker/wrangler.toml
```

```js
import createSekai from "sekai/browser";

const sekai = createSekai({ worker: "https://cors.chatbook.ink" });
const source = await sekai.megaplay.resolve({ malId: 21, episode: 1, type: "dub" });
hls.loadSource(source.playback.url); // header-free, CORS-enabled, playlists rewritten
```

See [`worker/README.md`](worker/README.md) for the worker surface and caching.

## HTTP API

| route                                       | description                     |
| ------------------------------------------- | ------------------------------- |
| `GET /megaplay/mal/:malId/:episode/:type`   | direct sources + relay urls     |
| `GET /megaplay/resolve?url=<stream url>`    | resolve any megaplay stream url |
| `GET /megaplay/proxy?u=<base64url>`         | streaming relay                 |
| `GET /health`                               | liveness                        |

```jsonc
// GET /megaplay/mal/21/1/dub
{
  "ok": true,
  "data": {
    "provider": "megaplay",
    "mal_id": 21, "episode": 1, "type": "dub", "server": 4,
    "m3u8": "https://fetch.nexabloom.top/anime/<32hex>/<32hex>/master.m3u8?token=...",
    "referer": "https://megaplay.buzz/", "origin": "https://megaplay.buzz",
    "qualities": [{ "label": "1080p", "url": "...", "proxy_url": "..." }],
    "subtitles": [{ "label": "English", "language": "en", "url": "...", "proxy_url": "..." }],
    "intro": { "start": 31, "end": 111 }, "outro": null,
    "token_expires_in": 90
  }
}
```

## How it works

1. `GET /stream/mal/{malid}/{ep}/{type}` — scrape the internal `data-id`.
2. `GET /stream/getSources?id={data-id}&platform=OTHER` with
   `X-Requested-With: XMLHttpRequest` → `{ enc, tracks, intro, outro }`.
3. AES-256-CBC decrypt `enc` → `{ file: "<master.m3u8>" }`.
4. Parse renditions and sign a CDN `token` (HMAC-SHA256) onto the urls.

Plain `fetch` + WebCrypto; no browser automation. Crypto lives in
`lib/crypto.js` and runs on `globalThis.crypto.subtle` in both runtimes.

## Layout

```
index.js            library entry + CLI server
browser.js          createSekai({ worker }) — 100% client-side
sekai.sh            shell wrapper for the CLI
providers/megaplay.js
lib/                transport, http, crypto, cache, node streaming relay
server/app.js       HTTP routes (node:http, no dependencies)
worker/             Cloudflare fetch worker
demo/               Plyr + hls.js demo and its static server
```

No runtime dependencies. Node >= 18.17.
