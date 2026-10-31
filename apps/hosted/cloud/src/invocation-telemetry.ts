/** Native Tail delivery records invocation totals independently of trace sampling. */
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
      // No tail consumer or native trace export here: the receiver must not observe itself.
      ...(yield* platformObservability),
    };
  }),
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker;
    // Each request's host is named by the deployment's own host layout, as the API Worker reads it.
    // Without the layout every host reads as `other`: the records themselves must not stop, so a
    // missing setting and an invalid layout (which the API Worker dies on) are both caught here.
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
