/**
 * Private entry point for app data supervisors. A supervisor that wakes in a fresh isolate loads
 * and initializes only this Worker, not the API with its routes, auth and executor.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import type { WorkerLoader } from "@cloudflare/workers-types";
import { Effect, Layer, Schema } from "effect";
import {
  makeFacetSupervisor,
  FacetInvocation,
  type FacetBundle,
} from "@executor-js/app-data/cloudflare";
import { AppData, runnerReadsBuilds } from "./infrastructure/app-data-worker.ts";
import { AppDataSupervisor, appDataSupervisors } from "./infrastructure/app-data.ts";
import { RuntimeContext } from "alchemy";
import { CacheCommand } from "@executor-js/app-cache/contracts";
import { BlobStore } from "@executor-js/sdk/core";
import { makeAppRunner, serveAppRunner, type RemoteCapabilities } from "@executor-js/sdk/workerd";
import { cloudBuildReader } from "./infrastructure/blobs.ts";
import { cloudOrigin } from "./infrastructure/stage.ts";
import { loadCloudBuildRecord, loadCloudFramework } from "./implementation/build-storage.ts";
import { cachedRuntimeBuilds } from "./implementation/runtime-build-cache.ts";
import { appCredentialOutbound, appOutboundBindings } from "./infrastructure/app-outbound.ts";
import { sentryBindings } from "./infrastructure/sentry.ts";
import { HttpServerResponse } from "effect/http";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";

const NativeLoader = Schema.declare(
  (value): value is Pick<WorkerLoader, "get"> =>
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function",
);

const AppDataSupervisorLive = AppDataSupervisor.make(
  Effect.gen(function* () {
    // Alchemy provisions the binding. Its current wrapper does not expose getDurableObjectClass.
    yield* Cloudflare.WorkerLoader("AppDataLoader");
    const state = yield* Cloudflare.DurableObjectState;
    const environment = yield* Cloudflare.WorkerEnvironment;
    const credentials = yield* appCredentialOutbound;
    return Effect.gen(function* () {
      const loader = yield* Schema.decodeUnknownEffect(NativeLoader)(
        environment.AppDataLoader,
      ).pipe(Effect.orDie);
      // Facets send through this Worker's fetch, specialized for their app.
      const supervisor = yield* makeFacetSupervisor(state.raw, loader, yield* credentials.outbound);
      return {
        cache: supervisor.cache,
        evaluated: supervisor.evaluated,
        invoke: (
          input: typeof FacetInvocation.Type,
          load: () => Promise<typeof FacetBundle.Type>,
          elicitation: ((input: unknown) => Promise<unknown>) | null = null,
          workflows: ((input: unknown) => Promise<unknown>) | null = null,
        ) => supervisor.invoke(input, load, elicitation, workflows),
        cancel: (id: string) => supervisor.cancel(id),
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          // upgrade already accepts the socket; send the initial revision without accepting twice.
          yield* supervisor.initial(socket.ws).pipe(Effect.orDie);
          return response;
        }),
        alarm: () => supervisor.recover.pipe(Effect.orDie),
        // Socket events can wake a hibernated supervisor too, so they count as calls it received.
        webSocketMessage: () => supervisor.enter(Effect.void),
        webSocketClose: (socket: Cloudflare.WebSocket) =>
          supervisor.enter(socket.close(1000, "Closed")),
        webSocketError: (socket: Cloudflare.WebSocket) =>
          supervisor.enter(socket.close(1011, "Reconnect")),
      };
    });
  }),
);

export default AppData.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    return {
      main: import.meta.url,
      ...(yield* cloudObservability),
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      env: {
        ...(yield* telemetryBindings),
        ...(yield* appOutboundBindings),
        [runnerReadsBuilds.name]: runnerReadsBuilds.value,
        // App requests Executor's network could not send are reported.
        ...(yield* sentryBindings).env,
      },
    };
  }),
  Effect.gen(function* () {
    const credentials = yield* appCredentialOutbound;
    const databases = yield* appDataSupervisors;
    const environment = yield* Cloudflare.WorkerEnvironment;
    // The runner reads builds itself, by the ID each invocation names, so callers never load,
    // decode or send app code. The cache keys match the ones a deploy warms.
    const blobs = yield* cloudBuildReader;
    const origin = yield* cloudOrigin.pipe(Effect.orDie);
    // Built for each call, never shared across requests: a fiber woken by another request's
    // shared Effect continues in that request's I/O context, so concurrent calls waiting on one
    // shared build would count their Dynamic Workers against the first caller's limit.
    const runner = Effect.gen(function* () {
      const { waitUntil } = yield* Effect.promise(() => import("cloudflare:workers"));
      const read = cachedRuntimeBuilds(
        origin,
        {
          record: (build) =>
            loadCloudBuildRecord(build).pipe(Effect.provideService(BlobStore, blobs)),
          framework: (identity) =>
            loadCloudFramework(identity).pipe(Effect.provideService(BlobStore, blobs)),
        },
        // A cache write outlives the read that missed; the call's own work does not wait on it.
        (write) =>
          Effect.context<never>().pipe(
            Effect.flatMap((services) =>
              Effect.sync(() => waitUntil(Effect.runPromiseWith(services)(write))),
            ),
          ),
      );
      return serveAppRunner(
        makeAppRunner({
          loader: yield* Schema.decodeUnknownEffect(NativeLoader)(environment.AppDataLoader).pipe(
            Effect.orDie,
          ),
          outbound: yield* credentials.outbound,
          credentialKey: credentials.key,
          data: (app) => {
            const target = databases.getByName(app);
            return {
              invoke: (input, load, elicit, controls) =>
                target
                  .invoke(input, load, elicit, controls)
                  .pipe(Effect.provide(RuntimeContext.phantom)),
              cancel: (id) => target.cancel(id).pipe(Effect.provide(RuntimeContext.phantom)),
              cache: (namespace, command) =>
                Schema.decodeUnknownEffect(CacheCommand)(command).pipe(
                  Effect.tap((parsed) =>
                    Effect.annotateCurrentSpan("cache.operation", parsed.operation),
                  ),
                  Effect.flatMap((parsed) => target.cache(namespace, parsed)),
                  Effect.provide(RuntimeContext.phantom),
                  Effect.withSpan("runtime.cloud.cache"),
                ),
            };
          },
          waitUntil,
        }),
        read,
      );
    });
    return {
      // Only app isolates' outbound requests reach this Worker's fetch; nothing routes to it.
      fetch: credentials.serve(Effect.succeed(HttpServerResponse.empty({ status: 404 }))),
      invoke: (invocation: string, capabilities: RemoteCapabilities) =>
        runner.pipe(Effect.flatMap((served) => served.invoke(invocation, capabilities))),
      declare: (bundle: string, headers: Readonly<Record<string, string>>) =>
        runner.pipe(Effect.flatMap((served) => served.declare(bundle, headers))),
    };
  }).pipe(Effect.provide(Layer.mergeAll(AppDataSupervisorLive, cloudTelemetry))),
);
