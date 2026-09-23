/** Dynamic app Workers need a real Fetcher; native Workflows cannot lend their implicit network. */
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";

export const AppOutbound = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) return yield* Cloudflare.Worker.ref("AppOutbound");
  return yield* Cloudflare.Worker("AppOutbound", {
    workersDev: false,
    compatibility: { date: "2026-09-08", flags: ["global_fetch_strictly_public"] },
    // This private service has no application bindings or credentials.
    script: `export default {
      fetch(request) { return fetch(request); }
    };`,
  });
});
