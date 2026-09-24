/** Local composition owns persistent files and its optional bundled collector. */
import { Config, Effect, Layer, Logger, Path } from "effect";
import { OtlpExporter } from "effect/unstable/observability";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";
import { CurrentTelemetryClient } from "./transport.ts";
import { telemetryConfig } from "./config.ts";
import { startCollector } from "./collector.ts";
import { rotatingJsonLogger } from "./files.ts";
import { telemetryLayer } from "./layer.ts";
import { startProcessMetrics } from "./process.ts";

/** Local hosts keep JSONL logs; absent explicit exporters, they own a loopback Motel process. */
export const localTelemetry = (directory: string, service: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const disabled = yield* Config.Boolean("EXECUTOR_DISABLE_LOCAL_TELEMETRY").pipe(
        Config.withDefault(false),
      );
      if (disabled) return OtlpExporter.layerFlusher;
      const path = yield* Path.Path;
      const diagnostics = path.resolve(directory, "diagnostics");
      const file = yield* rotatingJsonLogger(diagnostics, service);
      const stderr = Logger.withConsoleError(Logger.formatJson);
      const logger = Logger.make((options) => {
        stderr.log(options);
        file.log(options);
      });
      const telemetry = yield* Effect.gen(function* () {
        const config = yield* telemetryConfig(service);
        if (config.traces !== undefined || config.logs !== undefined)
          return telemetryLayer(config, "process", logger);
        const defaultBundle = yield* path.fromFileUrl(new URL("../dist/motel", import.meta.url));
        const bundle = yield* Config.String("EXECUTOR_MOTEL_BUNDLE").pipe(
          Config.withDefault(defaultBundle),
        );
        const ready = yield* startCollector(
          diagnostics,
          bundle,
          path.sep === "\\" ? "bun.exe" : "bun",
        );
        const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
        // This internal address never reaches the network. Resolve only telemetry
        // requests after readiness; native exporter buffers/timeouts own delivery.
        const origin = "http://motel.internal";
        const transport = client.pipe(
          HttpClient.mapRequestEffect((request) => {
            if (new URL(request.url).origin !== origin) return Effect.succeed(request);
            return ready.pipe(
              Effect.timeout("3 seconds"),
              Effect.map((url) =>
                HttpClientRequest.setUrl(request, new URL(new URL(request.url).pathname, url)),
              ),
              Effect.mapError(
                (cause) =>
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request, cause }),
                  }),
              ),
            );
          }),
        );
        return telemetryLayer(
          { ...config, traces: { url: `${origin}/v1/traces` }, logs: { url: `${origin}/v1/logs` } },
          "process",
          logger,
        ).pipe(Layer.provideMerge(Layer.succeed(CurrentTelemetryClient, transport)));
      }).pipe(Effect.provide(Logger.layer([logger])));
      // The sampler uses the same exporters and registry as product operations.
      return Layer.effectDiscard(startProcessMetrics(service)).pipe(Layer.provideMerge(telemetry));
    }),
  );
