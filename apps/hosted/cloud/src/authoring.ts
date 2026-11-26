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
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat", "no_brotli_content_encoding"] },
    };
  }),
  Effect.succeed(Authoring.of({ files: () => Effect.succeed(authoring) })),
);
