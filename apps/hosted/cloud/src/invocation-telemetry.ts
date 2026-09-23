/** Native Tail delivery records invocation totals independently of trace sampling. */
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import { InvocationTelemetry } from "./infrastructure/invocation-telemetry.ts";
import { cloudTelemetry, telemetryBindings } from "./infrastructure/telemetry.ts";
import { recordInvocations } from "./implementation/invocation-summary.ts";

export default InvocationTelemetry.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    return {
      main: import.meta.url,
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      env: yield* telemetryBindings,
      // No tail consumer or native trace export here: the receiver must not observe itself.
    };
  }),
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker;
    yield* worker.listen((event: unknown) =>
      Cloudflare.Workers.isWorkerEvent(event) && event.type === "tail"
        ? recordInvocations(event.input)
        : undefined,
    );
    return {};
  }).pipe(Effect.provide(cloudTelemetry)),
);
