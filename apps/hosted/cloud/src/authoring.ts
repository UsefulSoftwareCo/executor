/**
 * Private holder of the Executor authoring reference: the published skills and the framework
 * reference, about 370 KB of generated data. Here it costs startup only when an isolate first
 * answers a framework lookup or a skills request, not on every API cold start.
 */
import { Effect } from "effect";
import authoring from "../.generated/executor-authoring.json" with { type: "json" };
import { Authoring } from "./infrastructure/authoring-worker.ts";
import { cloudObservability } from "./infrastructure/telemetry.ts";
import { workerBuild } from "./infrastructure/worker-build.ts";

export default Authoring.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    return {
      main: import.meta.url,
      ...(yield* cloudObservability),
      workersDev: false,
      build: workerBuild("authoring"),
      // No placement: a service binding runs this Worker beside its caller, the placed API Worker.
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
    };
  }),
  Effect.succeed(Authoring.of({ files: () => Effect.succeed(authoring) })),
);
