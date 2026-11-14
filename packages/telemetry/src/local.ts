/** Local composition owns persistent files and its optional bundled collector. */
import { Deferred, Effect, Layer, Logger, Path, Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { CurrentTelemetryClient } from "./transport.ts";
import { telemetryConfig } from "./config.ts";
import { startCollector } from "./collector.ts";
import { rotatingJsonLogger } from "./files.ts";
import { telemetryLayer } from "./layer.ts";
import { startProcessMetrics } from "./process.ts";

/** How one local host keeps its diagnostics. */
export interface LocalTelemetryOptions {
  /** Also write each log line to stderr; on by default. A background server's has no reader. */
  readonly stderr?: boolean | undefined;
  /**
   * Start the bundled collector in the scope this yields, once it yields one. A host that can lose
   * the race for its data directory yields the scope that holds the directory, so a collector runs
   * only while its host owns that data. Logs reach the JSONL file from the start; exports wait for
   * the collector as they do while it starts.
   */
  readonly collectorScope?: Effect.Effect<Scope.Scope> | undefined;
}

/** Local hosts keep JSONL logs; absent explicit exporters, they own a loopback collector. */
export const localTelemetry = (
  directory: string,
  service: string,
  options: LocalTelemetryOptions = {},
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const diagnostics = path.resolve(directory, "diagnostics");
      const { logger: file } = yield* rotatingJsonLogger(diagnostics, service);
      const stderr =
        options.stderr === false ? undefined : Logger.withConsoleError(Logger.formatJson);
      const logger = Logger.make((log) => {
        stderr?.log(log);
        file.log(log);
      });
      const telemetry = yield* Effect.gen(function* () {
        const config = yield* telemetryConfig(service);
        if (config.traces !== undefined || config.logs !== undefined)
          return telemetryLayer(config, "process", logger);
        // The collector's build (`collector:build`) and the viewer's, beside this package's source.
        const files = {
          executable: yield* path.fromFileUrl(
            new URL(
              `../dist/collector/executor-collector${process.platform === "win32" ? ".exe" : ""}`,
              import.meta.url,
            ),
          ),
          viewer: yield* path.fromFileUrl(new URL("../dist/viewer", import.meta.url)),
        };
        const ready = yield* Deferred.make<string>();
        const start = startCollector(diagnostics, files).pipe(
          Effect.flatMap((address) => Deferred.completeWith(ready, address)),
        );
        if (options.collectorScope === undefined) yield* start;
        else
          yield* options.collectorScope.pipe(
            Effect.flatMap((scope) => start.pipe(Scope.provide(scope))),
            Effect.catchCause((cause) =>
              Effect.logWarning("Local telemetry collector failed", cause),
            ),
            Effect.forkScoped,
          );
        const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
        // This internal address never reaches the network. Resolve only telemetry
        // requests after readiness; native exporter buffers/timeouts own delivery.
        const origin = "http://collector.internal";
        const transport = client.pipe(
          HttpClient.mapRequestEffect((request) => {
            if (new URL(request.url).origin !== origin) return Effect.succeed(request);
            return Deferred.await(ready).pipe(
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
        // A terminal's Ctrl+C and the desktop's stop signal this process's whole group, so the
        // bundled collector usually stops at the same moment as this process. Its final flush
        // then has no listener, and the exporter's retries would hold shutdown for the default
        // three seconds. A loopback collector that is still running answers within milliseconds.
        // Metrics are never bundled: an operator's metrics endpoint is remote and keeps the
        // default bound for its final batch.
        return telemetryLayer(
          { ...config, traces: { url: `${origin}/v1/traces` }, logs: { url: `${origin}/v1/logs` } },
          "process",
          logger,
          { traces: "250 millis", logs: "250 millis" },
        ).pipe(Layer.provideMerge(Layer.succeed(CurrentTelemetryClient, transport)));
      }).pipe(Effect.provide(Logger.layer([logger])));
      // The sampler uses the same exporters and registry as product operations.
      return Layer.effectDiscard(startProcessMetrics(service)).pipe(Layer.provideMerge(telemetry));
    }),
  );
