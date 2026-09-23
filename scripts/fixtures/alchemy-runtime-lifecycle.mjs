import assert from "node:assert/strict";
import { Runtime, layerLocalRuntime } from "@alchemy.run/cloudflare-runtime/core";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Expected storage directory");
const runtime = layerLocalRuntime({ directory }).pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        CLOUDFLARE_RUNTIME_HOME: `${directory}/runtime`,
      }),
    ),
  ),
);
// No runMain/process.exit: only scoped cleanup may release the process.
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const engine = yield* Runtime;
      const origin = yield* engine.start({
        name: "lifecycle-probe",
        compatibilityDate: "2026-07-30",
        modules: [
          {
            name: "main.js",
            type: "ESModule",
            content: "export default { fetch() { return Response.json({ok:true}); } };",
          },
        ],
        bindings: [],
      });
      yield* Effect.promise(async () => {
        const response = await fetch(origin);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
      });
    }),
  ).pipe(Effect.provide(runtime)),
);
console.log("runtime closed");
