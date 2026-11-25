import * as Cloudflare from "alchemy/Cloudflare";
import type { DurableObjectNamespace, WorkerLoader } from "@cloudflare/workers-types";
import { Effect, Layer, Option, Schema } from "effect";
import { EvaluatedSupervisor } from "@executor-js/app-data/evaluated";
import { coloOf } from "./infrastructure/colo.ts";
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
import {
  IsolateStarted,
  makeAppRunner,
  serveAppRunner,
  type AppDataHost,
  type AppRunnerHost,
  type RemoteCapabilities,
} from "@executor-js/sdk/workerd";
import { owned, withRemoteSpan } from "@executor-js/telemetry";
import { cloudBuildReader } from "./infrastructure/blobs.ts";
import { cloudOrigin } from "./infrastructure/stage.ts";
import { loadCloudBuildRecord, loadCloudFramework } from "./implementation/build-storage.ts";
import { cachedRuntimeBuilds } from "./implementation/runtime-build-cache.ts";
import { appCredentialOutbound, appOutboundBindings } from "./infrastructure/app-outbound.ts";
import { sentryBindings } from "./infrastructure/sentry.ts";
import { workerBuild } from "./infrastructure/worker-build.ts";
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
const NativeSupervisors = Schema.declare(
  (value): value is Pick<DurableObjectNamespace, "idFromName"> =>
    typeof value === "object" &&
    value !== null &&
    "idFromName" in value &&
    typeof value.idFromName === "function",
);

const CacheAnswered = Schema.Struct({
  supervisor: Schema.Struct({
    ...EvaluatedSupervisor.fields,
    colo: Schema.String,
    wokeEarlier: Schema.optionalKey(Schema.Boolean),
    wokeByWake: Schema.optionalKey(Schema.Boolean),
    isolateWoke: Schema.optionalKey(Schema.Boolean),
  }),
});
const annotateCacheSupervisor = (reply: unknown) => {
  const answered = Schema.decodeUnknownOption(CacheAnswered)(reply);
  if (Option.isNone(answered))
    return Effect.gen(function* () {
      (yield* IsolateStarted)("unknown");
    });
  const { woke, wokeEarlier, wokeByWake, isolateWoke, instanceMs, isolateMs, colo } =
    answered.value.supervisor;
  return Effect.gen(function* () {
    if (woke || wokeByWake === true) {
      const started = yield* IsolateStarted;
      started("supervisor");
      if (isolateWoke === undefined) started("unknown");
      else if (isolateWoke) started("supervisor-isolate");
    }
    yield* Effect.annotateCurrentSpan({
      "cache.supervisor.woke": woke || wokeByWake === true || wokeEarlier === true,
      ...(woke
        ? { "cache.supervisor.woke_by": "command" }
        : wokeByWake === true
          ? { "cache.supervisor.woke_by": "wake" }
          : wokeEarlier === true
            ? { "cache.supervisor.woke_by": "earlier" }
            : {}),
      "cache.supervisor.instance_ms": instanceMs,
      "cache.supervisor.isolate_ms": isolateMs,
      "cache.supervisor.colo": colo,
    });
  });
};
const WakeAnswered = Schema.Struct({
  supervisor: EvaluatedSupervisor,
  isolateWoke: Schema.Boolean,
});
const annotateWake = (reply: unknown) =>
  Option.match(Schema.decodeUnknownOption(WakeAnswered)(reply), {
    onNone: () => Effect.void,
    onSome: ({ supervisor, isolateWoke }) =>
      Effect.annotateCurrentSpan({
        "executor.supervisor.cold": supervisor.woke,
        "executor.supervisor.isolate_cold": isolateWoke,
      }),
  });
const currentTrace = Effect.currentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.option,
  Effect.map(Option.getOrUndefined),
);

const runnerBindings = Effect.gen(function* () {
  const environment = yield* Cloudflare.WorkerEnvironment;
  const credentials = yield* appCredentialOutbound;
  const blobs = yield* cloudBuildReader;
  const origin = yield* cloudOrigin.pipe(Effect.orDie);
  return (options: {
    readonly data: (app: string) => AppDataHost;
    readonly waitUntil: (task: Promise<unknown>) => void;
    readonly within?: AppRunnerHost["within"];
  }) =>
    Effect.gen(function* () {
      const read = cachedRuntimeBuilds(
        origin,
        {
          record: (build) =>
            loadCloudBuildRecord(build).pipe(Effect.provideService(BlobStore, blobs)),
          framework: (identity) =>
            loadCloudFramework(identity).pipe(Effect.provideService(BlobStore, blobs)),
        },
        (write) =>
          Effect.context<never>().pipe(
            Effect.flatMap((services) =>
              Effect.sync(() => options.waitUntil(Effect.runPromiseWith(services)(write))),
            ),
          ),
      );
      return serveAppRunner(
        makeAppRunner({
          loader: yield* Schema.decodeUnknownEffect(NativeLoader)(environment.AppDataLoader).pipe(
            Effect.orDie,
          ),
          outbound: yield* credentials.outbound,
          outboundGroup: credentials.outboundGroup,
          credentialKey: credentials.key,
          data: options.data,
          waitUntil: options.waitUntil,
          ...(options.within === undefined ? {} : { within: options.within }),
        }),
        read,
      );
    });
});

const AppDataSupervisorLive = AppDataSupervisor.make(
  Effect.gen(function* () {
    yield* Cloudflare.WorkerLoader("AppDataLoader");
    const state = yield* Cloudflare.DurableObjectState;
    const environment = yield* Cloudflare.WorkerEnvironment;
    const credentials = yield* appCredentialOutbound;
    const runnerFor = yield* runnerBindings;
    return Effect.gen(function* () {
      const loader = yield* Schema.decodeUnknownEffect(NativeLoader)(
        environment.AppDataLoader,
      ).pipe(Effect.orDie);
      const supervisors = yield* Schema.decodeUnknownEffect(NativeSupervisors)(
        environment.AppDataSupervisor,
      ).pipe(Effect.orDie);
      const serves = (app: string) => state.raw.id.equals(supervisors.idFromName(app));
      const supervisor = yield* makeFacetSupervisor(
        state.raw,
        loader,
        yield* credentials.outbound,
        serves,
      );
      const local: AppDataHost = {
        invoke: (input, load, elicit, controls) =>
          supervisor
            .invoke(input, load, elicit, controls)
            .pipe(Effect.withSpan("runtime.app.data.invoke")),
        cancel: (id) => supervisor.cancel(id),
        cache: (namespace, command) => supervisor.cache(namespace, command),
      };
      const waitUntil = (task: Promise<unknown>) => state.raw.waitUntil(task);
      const colo = () => coloOf((lookup) => state.raw.waitUntil(Effect.runPromise(lookup)));
      colo();
      return {
        cache: (namespace: string, command: unknown, trace?: string, invocation?: string) =>
          supervisor.observedCache(namespace, command, trace, invocation).pipe(
            Effect.map(({ reply, supervisor: running, wokeEarlier, wokeByWake, isolateWoke }) => ({
              ...reply,
              supervisor: { ...running, wokeEarlier, wokeByWake, isolateWoke, colo: colo() },
            })),
          ),
        evaluated: supervisor.evaluated,
        wake: supervisor.wake,
        invoke: (
          input: typeof FacetInvocation.Type,
          load: () => Promise<typeof FacetBundle.Type>,
          elicitation: ((input: unknown) => Promise<unknown>) | null = null,
          workflows: ((input: unknown) => Promise<unknown>) | null = null,
        ) =>
          supervisor
            .invoke(input, load, elicitation, workflows)
            .pipe(
              withRemoteSpan(
                new Request("https://app-data.internal", { headers: input.headers }),
                "runtime.app.data.invoke",
              ),
            ),
        cancel: (id: string) => supervisor.cancel(id),
        run: (invocation: string, capabilities: RemoteCapabilities) =>
          runnerFor({
            data: () => local,
            waitUntil,
            within: { supervisor: { serves } },
          }).pipe(Effect.flatMap((served) => served.invoke(invocation, capabilities))),
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          yield* supervisor.initial(socket.ws).pipe(Effect.orDie);
          return response;
        }),
        alarm: () => supervisor.recover.pipe(Effect.orDie),
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
      build: workerBuild("app-data"),
      ...(yield* cloudObservability),
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat", "no_brotli_content_encoding"] },
      env: {
        ...(yield* telemetryBindings),
        ...(yield* appOutboundBindings),
        [runnerReadsBuilds.name]: runnerReadsBuilds.value,
        ...(yield* sentryBindings).env,
      },
    };
  }),
  Effect.gen(function* () {
    const credentials = yield* appCredentialOutbound;
    const databases = yield* appDataSupervisors;
    const runnerFor = yield* runnerBindings;
    const runner = Effect.gen(function* () {
      const { waitUntil } = yield* Effect.promise(() => import("cloudflare:workers"));
      return yield* runnerFor({
        waitUntil,
        data: (app) => {
          const target = databases.getByName(app);
          let commands = 0;
          const invocation = crypto.randomUUID();
          const colo = () => coloOf((lookup) => waitUntil(Effect.runPromise(lookup)));
          colo();
          return {
            invoke: (input, load, elicit, controls) =>
              target
                .invoke(input, load, elicit, controls)
                .pipe(Effect.provide(RuntimeContext.phantom)),
            cancel: (id) => target.cancel(id).pipe(Effect.provide(RuntimeContext.phantom)),
            wake: (reason) =>
              currentTrace.pipe(
                Effect.flatMap((trace) => target.wake(trace, invocation)),
                Effect.tap(annotateWake),
                Effect.provide(RuntimeContext.phantom),
                owned("background", "runtime.cloud.wake", {
                  attributes: { "executor.wake.reason": reason },
                }),
              ),
            cache: (namespace, command) =>
              Schema.decodeUnknownEffect(CacheCommand)(command).pipe(
                Effect.tap((parsed) =>
                  Effect.annotateCurrentSpan({
                    "cache.operation": parsed.operation,
                    "cache.command.index": ++commands,
                    ...(parsed.operation === "acquire" && parsed.reads !== undefined
                      ? { "cache.reads": parsed.reads.length }
                      : {}),
                  }),
                ),
                Effect.flatMap((parsed) =>
                  currentTrace.pipe(
                    Effect.flatMap((trace) => target.cache(namespace, parsed, trace, invocation)),
                  ),
                ),
                Effect.tap(annotateCacheSupervisor),
                Effect.tap(() => Effect.annotateCurrentSpan("cache.caller.colo", colo())),
                Effect.provide(RuntimeContext.phantom),
                Effect.withSpan("runtime.cloud.cache", {
                  attributes: { "executor.app.id": app },
                }),
              ),
          };
        },
      });
    });
    return {
      fetch: credentials.serve(Effect.succeed(HttpServerResponse.empty({ status: 404 }))),
      invoke: (invocation: string, capabilities: RemoteCapabilities) =>
        runner.pipe(Effect.flatMap((served) => served.invoke(invocation, capabilities))),
      declare: (bundle: string, headers: Readonly<Record<string, string>>) =>
        runner.pipe(Effect.flatMap((served) => served.declare(bundle, headers))),
    };
  }).pipe(Effect.provide(Layer.mergeAll(AppDataSupervisorLive, cloudTelemetry))),
);
