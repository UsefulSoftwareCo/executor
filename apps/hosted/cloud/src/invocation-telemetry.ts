import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option } from "effect";
import { InvocationTelemetry } from "./infrastructure/invocation-telemetry.ts";
import {
  cloudTelemetry,
  platformObservability,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";
import { cloudHosts } from "./infrastructure/stage.ts";
import { recordInvocations } from "./implementation/invocation-summary.ts";

export default InvocationTelemetry.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    return {
      main: import.meta.url,
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat", "no_brotli_content_encoding"] },
      env: yield* telemetryBindings,
      ...(yield* platformObservability),
    };
  }),
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker;
    const hosts = yield* cloudHosts.pipe(
      Effect.map(Option.some),
      Effect.catchCause(() =>
        Effect.as(
          Effect.logWarning("Invocation records name no host role: the host layout did not load"),
          Option.none(),
        ),
      ),
    );
    yield* worker.listen((event: unknown) =>
      Cloudflare.Workers.isWorkerEvent(event) && event.type === "tail"
        ? recordInvocations(hosts, event.input)
        : undefined,
    );
    return {};
  }).pipe(Effect.provide(cloudTelemetry)),
);
