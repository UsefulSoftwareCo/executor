import { SourceFormatter } from "@executor-js/app-management/contracts/source-display";
import { traceHeaders } from "@executor-js/telemetry";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import { Formatter } from "./formatter-worker.ts";

export const cloudSourceFormatter = Effect.gen(function* () {
  const formatter = yield* Cloudflare.Workers.bindWorker(Formatter);
  return Layer.effect(
    SourceFormatter,
    Effect.gen(function* () {
      const environment = yield* Cloudflare.WorkerEnvironment;
      return SourceFormatter.of({
        format: (files) =>
          traceHeaders.pipe(
            Effect.flatMap((headers) =>
              formatter.format(
                files.map(({ path, content }) => ({ path, content })),
                Object.fromEntries(Object.entries(headers)),
              ),
            ),
            Effect.provideService(Cloudflare.WorkerEnvironment, environment),
            Effect.catchTag("RpcCallError", (error) =>
              Effect.logWarning(`Source formatting unavailable: ${error.message}`).pipe(
                Effect.as(files),
              ),
            ),
            Effect.withSpan("source.display.format"),
          ),
      });
    }),
  );
});
