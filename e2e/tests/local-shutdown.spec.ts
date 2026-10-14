import { expect, layer } from "@effect/vitest";
import { Duration, Effect, Exit, FileSystem, Layer, Redacted, Schema, Scope } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api, body, SessionClients } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { delayedCollector } from "../support/delayed-collector.ts";
import { Evidence } from "../support/evidence.ts";
import { startManagedServer } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { freePort } from "../support/ports.ts";
import { serverControl } from "../support/server-control.ts";

const App = Schema.Struct({ id: Schema.String, name: Schema.String });
const source = `import { defineApp, object, query, router } from "apps";
const ping = query({ input: object({}) }, async () => "ok");
export default defineApp({}, async () => ({ tools: router({ ping }) }));`;

layer(TestLive, { excludeTestServices: true })("Local shutdown", (it) => {
  it.effect(scenarios.localShutdown.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          evidence = yield* Evidence,
          target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        yield* Effect.addFinalizer(() => serverControl("start").pipe(Effect.orDie));
        // The last write before the stop must survive it.
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: "Shutdown fixture",
            files: [{ path: "index.ts", content: source }, appsManifest],
          },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app } = yield* body(Schema.Struct({ app: App }), deployed);
        // The runner stops the product by signalling its whole process group, as a terminal's
        // Ctrl+C and the desktop's quit do. The telemetry collector is in that group too.
        const [elapsed] = yield* Effect.timed(serverControl("stop"));
        yield* evidence.json("shutdown.json", { milliseconds: Duration.toMillis(elapsed) });
        expect(Duration.toMillis(elapsed)).toBeLessThan(1_500);
        yield* serverControl("start");
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const ready = yield* api.request(session, "GET", "/auth/session");
        expect(ready.status).toBe(200);
        const stored = yield* session.send("GET", `/v1/apps/${app.id}`, undefined, headers);
        expect(stored.status, "the app deployed just before the stop is still there").toBe(200);
        expect((yield* body(App, stored)).name).toBe("Shutdown fixture");
      }),
    ),
  );

  it.effect(scenarios.localShutdownRemoteMetrics.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          evidence = yield* Evidence,
          target = yield* Target;
        // Slower than the bound for the bundled loopback collector, well inside the default.
        const collector = yield* delayedCollector("1 second");
        const directory = yield* fs.makeTempDirectory({
          directory: target.directory,
          prefix: "remote-metrics-",
        });
        const origin = `http://127.0.0.1:${yield* freePort}`;
        // Only metrics go to the operator's collector; traces and logs stay with the bundled one.
        const product = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(product, Exit.void));
        yield* startManagedServer(
          { ...target, directory, metadata: { ...target.metadata, origin, target: "local" } },
          "product",
          { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${collector.origin}/v1/metrics` },
        ).pipe(Scope.provide(product));
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        expect((yield* api.request(yield* api.session(), "GET", "/auth/session")).status).toBe(200);
        const [elapsed] = yield* Effect.timed(Scope.close(product, Exit.void));
        const exports = yield* collector.exports;
        yield* evidence.json("remote-metrics.json", {
          milliseconds: Duration.toMillis(elapsed),
          exports: exports.map(({ path, outcome }) => ({ path, outcome })),
        });
        // Metrics export every 30 seconds, so the batch sent while stopping is the last one.
        const final = exports.filter(({ path }) => path === "/v1/metrics").at(-1);
        expect(final, "the final metrics batch reached the collector").toBeDefined();
        expect(final?.outcome, "the collector acknowledged it before the product exited").toBe(
          "acknowledged",
        );
      }),
    ),
  );
});
