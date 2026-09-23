import { Runtime, layerLocalRuntime } from "@alchemy.run/cloudflare-runtime/core";
import { Json, Workflows } from "@alchemy.run/cloudflare-runtime/core/bindings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { ConfigProvider, Console, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { recoveryWorker } from "./workflow-recovery-worker.mjs";

const [storage, upstream] = process.argv.slice(2);
if (!storage || !upstream) throw new Error("Expected storage directory and upstream URL");
const runtime = layerLocalRuntime({
  directory: storage,
}).pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({ CLOUDFLARE_RUNTIME_HOME: `${storage}/runtime` }),
    ),
  ),
);
NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const engine = yield* Runtime;
      const ready = yield* engine.start({
        name: "executor-workflow-recovery",
        compatibilityDate: "2026-07-30",
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: recoveryWorker }],
        workflows: [{ workflowName: "recovery-probe", className: "RecoveryProbe" }],
        bindings: [
          Workflows.local({
            binding: "PROBE",
            workflowName: "recovery-probe",
            className: "RecoveryProbe",
          }),
          Json.local("UPSTREAM", upstream),
        ],
      });
      yield* Console.log(JSON.stringify({ ready: String(ready) }));
      yield* Effect.never;
    }),
  ).pipe(Effect.provide(runtime)),
);
