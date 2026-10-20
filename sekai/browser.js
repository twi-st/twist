// sekai browser entry: everything runs client-side through a fetch worker,
// because a page cannot set the headers some sources and CDNs require.
//
//   import createSekai from "sekai/browser";
//   const sekai = createSekai({ worker: "https://cors.example.com" });
//   const source = await sekai.megaplay.resolve({ malId: 21, episode: 1, type: "dub" });
//   hls.loadSource(source.playback.url);

import { createTransport } from "./lib/transport.js";
import { VERSION } from "./lib/version.js";
import { createMegaplay } from "./providers/megaplay.js";

export function createSekai({ worker, transport, fetchImpl } = {}) {
  const activeTransport = createTransport({ worker, transport, fetchImpl });
  return {
    name: "sekai",
    version: VERSION,
    transport: activeTransport,
    megaplay: createMegaplay({ transport: activeTransport }),
  };
}

export default createSekai;
export { MegaplayError } from "./providers/megaplay.js";
