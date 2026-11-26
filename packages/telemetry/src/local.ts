import { Deferred, Effect, Layer, Logger, Path, Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { CurrentTelemetryClient } from "./transport.ts";
import { telemetryConfig } from "./config.ts";
import { startCollector } from "./collector.ts";
import { rotatingJsonLogger } from "./files.ts";
import { telemetryLayer } from "./layer.ts";
import { startProcessMetrics } from "./process.ts";

export interface LocalTelemetryOptions {
  readonly stderr?: boolean | undefined;
  readonly collectorScope?: Effect.Effect<Scope.Scope> | undefined;
}

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
        return telemetryLayer(
          { ...config, traces: { url: `${origin}/v1/traces` }, logs: { url: `${origin}/v1/logs` } },
          "process",
          logger,
          { traces: "250 millis", logs: "250 millis" },
        ).pipe(Layer.provideMerge(Layer.succeed(CurrentTelemetryClient, transport)));
      }).pipe(Effect.provide(Logger.layer([logger])));
      return Layer.effectDiscard(startProcessMetrics(service)).pipe(Layer.provideMerge(telemetry));
    }),
  );
