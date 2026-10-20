#!/usr/bin/env node
// sekai — megaplay stream sources, by MAL id.
//
//   import sekai from "sekai";
//   await sekai.megaplay.resolve({ malId: 21, episode: 1, type: "dub" });
//
//   import createSekai from "sekai/browser";           // worker-backed client
//
//   node index.js [--port 8787] [--host 127.0.0.1]     // HTTP API

import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "./server/app.js";
import { megaplay } from "./providers/megaplay.js";
import { createSekai } from "./browser.js";
import { VERSION } from "./lib/version.js";

export const version = VERSION;
export { createServer, megaplay, createSekai };
export { MegaplayError } from "./providers/megaplay.js";

export default { name: "sekai", version, megaplay, createSekai, createServer };

function parseArgs(argv) {
  const options = {
    port: Number.parseInt(process.env.PORT || "", 10) || 8787,
    host: process.env.HOST || "127.0.0.1",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") options.port = Number.parseInt(argv[++i], 10) || options.port;
    else if (arg === "--host") options.host = argv[++i] || options.host;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (/^\d+$/.test(arg)) options.port = Number.parseInt(arg, 10);
  }
  return options;
}

const HELP = `sekai v${VERSION}

Usage:
  node index.js [--port 8787] [--host 127.0.0.1]

Routes:
  GET /megaplay/mal/:malId/:episode/:type   direct sources
  GET /megaplay/resolve?url=<stream url>    resolve any megaplay stream url
  GET /megaplay/proxy?u=<base64url>         streaming relay for browsers
  GET /health

Library:
  import sekai from "sekai";
  await sekai.megaplay.resolve({ malId: 21, episode: 1, type: "dub" });`;

function startServer({ port, host }) {
  const server = createServer();
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolvePromise(server));
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
  } else {
    startServer(options)
      .then((server) => {
        const origin = `http://${options.host}:${server.address().port}`;
        console.log(`sekai v${VERSION} listening on ${origin}`);
        console.log(`  demo    node demo/plys.js`);
        console.log(`  sources ${origin}/megaplay/mal/21/1/dub`);
      })
      .catch((err) => {
        console.error(`sekai failed to start: ${err.message}`);
        process.exit(1);
      });
  }
}
