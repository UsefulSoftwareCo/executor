/**
 * Private entry point for app data supervisors. A supervisor that wakes in a fresh isolate loads
 * and initializes only this Worker, not the API with its routes, auth and executor.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import type { WorkerLoader } from "@cloudflare/workers-types";
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
import { durableNamespace } from "./infrastructure/jurisdiction.ts";
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

/**
 * How the supervisor ran when it answered a cache command. Supervisors before it send none;
 * `wokeEarlier` is absent from supervisors that did not compare traces.
 */
const CacheAnswered = Schema.Struct({
  supervisor: Schema.Struct({
    ...EvaluatedSupervisor.fields,
    colo: Schema.String,
    wokeEarlier: Schema.optionalKey(Schema.Boolean),
    wokeByWake: Schema.optionalKey(Schema.Boolean),
    isolateWoke: Schema.optionalKey(Schema.Boolean),
  }),
});
/**
 * `cache.supervisor.woke` is whether this request woke the supervisor: this command, this
 * invocation's wake, or an earlier call of the same trace, such as the evaluated listing read or
 * another invocation's wake, which `woke_by` tells apart. Only the first two are this call's start.
 * A colo reads `pending` while its isolate's one lookup has not answered yet, which happens only
 * on the first commands of a fresh isolate; see `coloOf`.
 */
const annotateCacheSupervisor = (reply: unknown) => {
  const answered = Schema.decodeUnknownOption(CacheAnswered)(reply);
  // A supervisor that predates this reports nothing, so whether it started is unknown.
  if (Option.isNone(answered))
    return Effect.gen(function* () {
      (yield* IsolateStarted)("unknown");
    });
  const { woke, wokeEarlier, wokeByWake, isolateWoke, instanceMs, isolateMs, colo } =
    answered.value.supervisor;
  return Effect.gen(function* () {
    // This command, or its call's wake, woke the supervisor; its isolate started too when it is
    // the isolate's first.
    if (woke || wokeByWake === true) {
      const started = yield* IsolateStarted;
      started("supervisor");
      // One that predates `isolateWoke` cannot say whether its isolate started too.
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
/**
 * How the supervisor ran when a cold call's wake reached it, in the attributes its invocation span
 * uses: whether the wake started its object, and its isolate. A supervisor from before `wake`
 * fails the wake instead, which the runner ignores.
 */
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
/** The current trace's ID, which a supervisor compares with the call that woke it. */
const currentTrace = Effect.currentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.option,
  Effect.map(Option.getOrUndefined),
);

/** What every runner in this Worker reads builds from and loads app code with. */
const runnerBindings = Effect.gen(function* () {
  const environment = yield* Cloudflare.WorkerEnvironment;
  const credentials = yield* appCredentialOutbound;
  // The runner reads builds itself, by the ID each invocation names, so callers never load,
  // decode or send app code. The cache keys match the ones a deploy warms.
  const blobs = yield* cloudBuildReader;
  const origin = yield* cloudOrigin.pipe(Effect.orDie);
  /**
   * A runner for one call. Built for each call, never shared across requests: a fiber woken by
   * another request's shared Effect continues in that request's I/O context, so concurrent calls
   * waiting on one shared build would count their Dynamic Workers against the first caller's limit.
   */
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
        // A cache write outlives the read that missed; the call's own work does not wait on it.
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
    // Alchemy provisions the binding. Its current wrapper does not expose getDurableObjectClass.
    yield* Cloudflare.WorkerLoader("AppDataLoader");
    const state = yield* Cloudflare.DurableObjectState;
    const environment = yield* Cloudflare.WorkerEnvironment;
    const credentials = yield* appCredentialOutbound;
    const runnerFor = yield* runnerBindings;
    const namespace = yield* durableNamespace("AppDataSupervisor");
    return Effect.gen(function* () {
      const loader = yield* Schema.decodeUnknownEffect(NativeLoader)(
        environment.AppDataLoader,
      ).pipe(Effect.orDie);
      // Each supervisor is named by its app's immutable ID. Its own object ID, not a caller, says
      // which app that is: the ID `getByName` derives from that name. Derived locally, no I/O.
      const supervisors = yield* namespace;
      const serves = (app: string) => state.raw.id.equals(supervisors.idFromName(app));
      // Facets send through this Worker's fetch, specialized for their app.
      const supervisor = yield* makeFacetSupervisor(
        state.raw,
        loader,
        yield* credentials.outbound,
        serves,
      );
      // A database call's runner runs here, beside the facet it calls: the caller reaches this
      // object directly instead of through a runner isolate that would only forward the call.
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
      // Start this isolate's colo lookup as the instance starts, ahead of its first reply.
      colo();
      return {
        // The reply carries how the supervisor ran, for the runner's span; the runner's reply
        // decoder ignores the extra field, so runners from before it read the reply unchanged.
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
          supervisor.invoke(input, load, elicitation, workflows).pipe(
            // The runner's trace context travels in the invocation's headers, so the supervisor's
            // part of a database call joins the tool call's trace.
            withRemoteSpan(
              new Request("https://app-data.internal", { headers: input.headers }),
              "runtime.app.data.invoke",
            ),
          ),
        cancel: (id: string) => supervisor.cancel(id),
        /**
         * Run a database call (see `runsInFacet`) with its runner in this object. Only this
         * object's own app is served: the runner refuses an invocation of any other app, or one
         * that is not a database call, before it reads a build or loads code. The object's own ID,
         * not the caller, says which app that is (`serves`).
         */
        run: (invocation: string, capabilities: RemoteCapabilities) =>
          runnerFor({
            data: () => local,
            waitUntil,
            within: { supervisor: { serves } },
          }).pipe(Effect.flatMap((served) => served.invoke(invocation, capabilities))),
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
      build: workerBuild("app-data"),
      ...(yield* cloudObservability),
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat", "no_brotli_content_encoding"] },
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
    const runnerFor = yield* runnerBindings;
    const runner = Effect.gen(function* () {
      const { waitUntil } = yield* Effect.promise(() => import("cloudflare:workers"));
      return yield* runnerFor({
        waitUntil,
        data: (app) => {
          const target = databases.getByName(app);
          // Commands this invocation sent its supervisor so far; the first also opens the stub.
          let commands = 0;
          // The runner asks for this per invocation. One trace can carry several invocations,
          // such as an execution's tool calls, and only the one whose wake started the
          // supervisor paid for that start. Opaque and never reported.
          const invocation = crypto.randomUUID();
          const colo = () => coloOf((lookup) => waitUntil(Effect.runPromise(lookup)));
          // Start this isolate's colo lookup with the invocation, ahead of its first command.
          colo();
          return {
            invoke: (input, load, elicit, controls) =>
              target
                .invoke(input, load, elicit, controls)
                .pipe(Effect.provide(RuntimeContext.phantom)),
            cancel: (id) => target.cancel(id).pipe(Effect.provide(RuntimeContext.phantom)),
            // No caller waits on it, so it is background work, not the call's Executor time. It
            // carries the invocation, so this call's commands report the start it made.
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
                // Read after the reply, so a fresh isolate's lookup had the round trip to answer.
                Effect.tap(() => Effect.annotateCurrentSpan("cache.caller.colo", colo())),
                Effect.provide(RuntimeContext.phantom),
                Effect.withSpan("runtime.cloud.cache"),
              ),
          };
        },
      });
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
