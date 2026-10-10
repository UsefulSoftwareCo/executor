/**
 * The one app Worker runner. It runs beside the Worker Loader on every host: in the Cloud API
 * Worker, and in the trusted apps Worker of self-host and local. It names each Worker, loads it,
 * wraps the authored modules and delivers each call's accounts, run, approval, replay and deadline.
 * Secret fields of providers that declare hosts, and every string of a managed account, leave the
 * runner only as sealed handles: `bundleAccounts` is the one path from the host's accounts to the
 * accounts a bundle reads.
 * A host supplies only its bindings and, per invocation, a build loader that the runner calls from
 * the Worker Loader's cold-start callback, so a warm call reads and transfers no code. Every
 * request and reply passes through the adapter of the protocol the build's framework speaks.
 */
import type { Fetcher, WorkerLoader } from "@cloudflare/workers-types";
import { Clock, Effect, Exit, Option, Redacted, Result, Schema, Semaphore } from "effect";
import {
  ElicitationReply,
  type HostRequest,
  type HostAccounts,
  type InvocationDeadline,
  type ResolvedAccounts,
  type TrustedToolApproval,
  type WorkflowExecution,
  WorkflowFailure,
  type WorkflowReplay,
} from "apps/contracts";
import { AppDatabaseError } from "@executor-js/app-data/contracts";
import {
  facetIdentity,
  failedColdStart,
  FacetResult,
  loadWorker,
  type FacetBundle,
  type FacetInvocation,
} from "@executor-js/app-data/cloudflare";
import { reachableModules, workerModules } from "@executor-js/app-data/worker-bundle";
import {
  CacheCommand,
  CacheError,
  CacheReply,
  type CacheTransport,
} from "@executor-js/app-cache/contracts";
import { holdLeases } from "@executor-js/app-cache";
import { discardsEvaluated } from "@executor-js/app-cache/changes";
import {
  describeBuildCause,
  RuntimeProtocolFailed,
  runtimeFailures,
  type RuntimeFailure,
} from "../contracts/runtime.ts";
import type { LoadedWorkerBuild, WorkerBundle } from "../contracts/worker-build.ts";
import { appProtocol, type AppProtocol } from "./app-protocols.ts";
import { appFacetBridge, appNetworkModuleName, appRpcBridge } from "./worker-bridge.ts";
import { appNetworkModule } from "./app-network.ts";
import { sealAccounts, unsealedAccounts } from "./credential-handles.ts";
import { AppRpcEntrypoint, AppRpcInvocation } from "./worker-elicitation.ts";
import { invocationWorkflow } from "./worker-workflow-rpc.ts";
import { type AppWorkerResidency, namedWorker } from "./app-worker-residency.ts";

type Callback = (input: unknown) => Promise<unknown>;

/** One app's data supervisor. It owns the facet and its database; the runner only calls it. */
export interface AppDataHost {
  readonly invoke: (
    input: typeof FacetInvocation.Type,
    load: () => Promise<typeof FacetBundle.Type>,
    elicit: Callback | null,
    controls: Callback | null,
  ) => Effect.Effect<unknown, unknown>;
  readonly cancel: (id: string) => Effect.Effect<void, unknown>;
  readonly cache: (namespace: string, command: unknown) => Effect.Effect<unknown, unknown>;
}

/** Host bindings. None of them reaches authored code except the outbound network. */
export interface AppRunnerHost {
  readonly loader: Pick<WorkerLoader, "get">;
  /**
   * The network an app's isolates use for global `fetch`, bound to that app. It opens the
   * credential handles the runner seals with `credentialKey`; see credential-handles.ts.
   */
  readonly outbound: (app: string) => Fetcher;
  /** Seals the secret fields of providers that declare hosts. App code never holds it. */
  readonly credentialKey: Effect.Effect<CryptoKey>;
  readonly data: (app: string) => AppDataHost;
  /** Keep a successful call's release, including its cache refreshes, alive after it returns. */
  readonly waitUntil: (task: Promise<unknown>) => void;
  /**
   * The bound on named Workers kept loaded, for a host whose process never unloads them itself.
   * Shared by every runner in the process.
   */
  readonly residency?: AppWorkerResidency;
  /**
   * Unload an app's facet Worker for one execution context when it is idle, so facet Workers count
   * against the residency's limit. True once it is unloaded. Supplied with a residency.
   */
  readonly unloadFacet?: (app: string, identity: string) => Effect.Effect<boolean, unknown>;
}

/** The authorized call. Credentials travel here, never in a Worker name or retained code. */
export interface AppInvocation {
  readonly app: string;
  readonly build: string;
  readonly database: boolean;
  readonly command: HostRequest;
  readonly accounts: HostAccounts;
  readonly approval?: typeof TrustedToolApproval.Type;
  readonly replay?: typeof WorkflowReplay.Type;
  readonly deadline?: typeof InvocationDeadline.Type;
  /** The scheduled run the invocation serves, for telemetry; see `InvocationRun`. */
  readonly run?: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Capabilities owned by one invocation and released with it. */
export interface AppCapabilities {
  /**
   * Read this invocation's build. Only the Worker Loader's cold-start callback, inside the runner
   * or the trusted data supervisor, calls it. Authored code never receives it.
   */
  readonly load: () => Promise<LoadedWorkerBuild>;
  readonly elicit: Callback | null;
  readonly controls: Callback | null;
  readonly workflow?: WorkflowExecution;
}

/** Operations an app with a database serves from its data facet, with its storage. */
const dataOperations: ReadonlySet<HostRequest["operation"]> = new Set([
  "migrate",
  "call",
  "query",
  "mutate",
  "webhooks",
  "webhook-validate",
  "webhook-complete",
  "webhook-register",
  "webhook-handle",
  "webhook-unregister",
]);
const writeOperations: ReadonlySet<HostRequest["operation"]> = new Set([
  "migrate",
  "mutate",
  "webhook-register",
  "webhook-handle",
  "webhook-unregister",
]);
const compatibilityDate = "2026-07-30";
/** The longest a call's release, including its cache refreshes, may keep running. */
const releaseLimit = "35 seconds";

/**
 * In-flight cache commands from one call to its app's store. On Cloudflare, Workers RPC
 * occasionally never delivered one of four or more concurrent calls to the same Durable Object
 * while an immediate repeat arrived, which stalled the loader holding the key. Two lanes keep a
 * load's writes parallel without that burst. Lanes belong to one call: workerd forbids a request
 * from resuming another request's I/O, so they are never shared across calls.
 */
const cacheLanes = 2;

/** A cold start's modules: only those its entry can import, out of the build's `total`. */
const loadedModules = <Module>(main: string, modules: Readonly<Record<string, Module>>) => ({
  modules: reachableModules(main, modules),
  total: Object.keys(modules).length,
});
const annotateLoaded = ({ modules, total }: ReturnType<typeof loadedModules>) =>
  Effect.annotateCurrentSpan({
    "executor.worker.modules": Object.keys(modules).length,
    "executor.worker.modules_total": total,
  });

/** One call's cache channel and the leases it owns until the call's release has finished. */
interface CacheSession {
  readonly callback: Callback;
  readonly close: Effect.Effect<void>;
}

/** Platform failures by the text the runtime reports them with, most specific first. */
const platformFailures: ReadonlyArray<readonly [RegExp, RuntimeFailure]> = [
  [/exceeded (its )?memory limit/i, "memory"],
  [/exceeded (its )?CPU time limit/i, "cpu"],
  [/timed out|exceeded (a |its )?(time limit|timeout|wall)/i, "timeout"],
  [/overloaded/i, "overloaded"],
  [/Durable Object reset|object to be reset|code (was|has been) updated/i, "reset"],
  [/Network connection lost/i, "disconnected"],
  [/will never generate a response|Promise will never complete/i, "hung"],
  [/^(\w+: )?internal error/i, "internal"],
];
/**
 * The kind of a failed call. App code can throw anything, a rejected call carries it, and a decode
 * failure names paths in the app's output, so a cause's text is matched here and goes no further.
 */
const classify = (cause: unknown): RuntimeFailure => {
  if (Schema.isSchemaError(cause)) return "invalid-reply";
  if (failedColdStart(cause)) return "cold-start";
  const text = describeBuildCause(cause);
  // A reply the Worker's framework could not decode crosses Workers RPC as a plain Error.
  if (/^(\w+: )?SchemaError\b/.test(text)) return "invalid-reply";
  return platformFailures.find(([pattern]) => pattern.test(text))?.[1] ?? "unrecognized";
};
/**
 * Fail a call with its kind, the only part telemetry records. `explain` keeps the cause in the
 * app's own terms for a deploy's declaration step, whose caller is the app's deployer.
 */
const failed = (reason: RuntimeFailure, cause?: unknown, explain = false) =>
  Effect.annotateCurrentSpan({
    "executor.runtime.failure": reason,
    "executor.runtime.cause": runtimeFailures[reason],
  }).pipe(
    Effect.andThen(
      Effect.fail(
        new RuntimeProtocolFailed({
          reason,
          ...(explain && cause !== undefined ? { message: describeBuildCause(cause) } : {}),
        }),
      ),
    ),
  );
const failedFrom = (explain: boolean) => (cause: unknown) =>
  failed(classify(cause), cause, explain);
/** Reading a build is the host's own work; its failure is Executor's text and recorded as it is. */
const failedBuild = (cause: unknown) =>
  Effect.annotateCurrentSpan({
    "executor.runtime.failure": "build",
    "executor.runtime.cause": describeBuildCause(cause),
  }).pipe(Effect.andThen(Effect.fail(new RuntimeProtocolFailed({ reason: "build" }))));
/**
 * A data supervisor failure. Its own typed failures are Executor's text and recorded as they are;
 * anything else is classified like an app Worker's failure.
 */
const SupervisorFailure = AppDatabaseError;
const failedData = (cause: unknown) =>
  Option.match(Schema.decodeUnknownOption(SupervisorFailure)(cause), {
    onNone: () => failedFrom(false)(cause),
    onSome: (failure) =>
      Effect.annotateCurrentSpan({
        "executor.runtime.failure": "data",
        "executor.runtime.cause": JSON.stringify(Schema.encodeSync(SupervisorFailure)(failure)),
      }).pipe(Effect.andThen(Effect.fail(new RuntimeProtocolFailed({ reason: "data" })))),
  });
const attempt = <A>(work: () => Promise<A>, explain = false) =>
  Effect.tryPromise({ try: work, catch: (cause) => cause }).pipe(Effect.catch(failedFrom(explain)));
/**
 * The protocol of each build this process has loaded, least recently used first. Builds are
 * immutable, so a build's protocol is learned from the load of its first cold start and warm calls
 * read no code. A self-host or local process holds every app Worker it starts, so it always starts
 * one before calling it. A Cloud isolate can reach a Worker that another isolate started; it reads
 * that build once to learn its protocol.
 */
const protocols = new Map<string, AppProtocol>();
const protocolLimit = 4096;
/**
 * First reads of builds whose protocol is not known yet, by build, with the read build once it
 * arrives. Concurrent first calls of a build, such as a tool call and the profile setup that an
 * account selection started, share one read, so the Worker they both reach loads its build once.
 * Only plain data is shared: a call never awaits another call's promise. On Cloud, a call resumed
 * by another request's promise continues in that request's I/O context, and its own capabilities
 * then fail with "Cannot perform I/O on behalf of a different request". A waiting call therefore
 * checks again on its own timer. The entry lasts as long as the reading call, so a waiting call
 * that starts the Worker uses the shared build instead of reading it again.
 */
const reads = new Map<string, { loaded?: LoadedWorkerBuild }>();
/** How often a call waiting on another call's first read checks it. */
const readCheck = "10 millis";
/**
 * How long a call waits on another call's first read before reading the build itself, should the
 * reading call never finish, for instance because its isolate stopped serving its request.
 */
const readWait = 10_000;

/** Record a build's protocol from its read. */
const learn = (build: string, loaded: LoadedWorkerBuild) =>
  appProtocol(loaded.protocol).pipe(
    Effect.catch(() => failed("unsupported")),
    Effect.map((protocol) => {
      protocols.set(build, protocol);
      if (protocols.size > protocolLimit) {
        const oldest = protocols.keys().next();
        if (oldest.done !== true) protocols.delete(oldest.value);
      }
      return protocol;
    }),
  );

/**
 * The adapter for an invocation's build, and the loader its cold start uses. When the protocol is
 * not known yet, the build is read once here and the cold start reuses that read. The read is
 * shared until the caller's scope closes.
 */
const protocolOf = (
  build: string,
  load: () => Promise<LoadedWorkerBuild>,
  waitUntil: (task: Promise<unknown>) => void,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    while (true) {
      const known = protocols.get(build);
      const shared = reads.get(build);
      if (known !== undefined) {
        protocols.delete(build);
        protocols.set(build, known);
        const loaded = shared?.loaded;
        return { protocol: known, load: loaded === undefined ? load : async () => loaded };
      }
      // Another call's read failed or was cancelled, or has not finished in time: read it here.
      if (shared === undefined || (yield* Clock.currentTimeMillis) - started >= readWait) break;
      yield* Effect.sleep(readCheck);
    }
    const entry: { loaded?: LoadedWorkerBuild } = {};
    if (!reads.has(build))
      yield* Effect.acquireRelease(
        Effect.sync(() => reads.set(build, entry)),
        () =>
          Effect.sync(() => {
            if (reads.get(build) === entry) reads.delete(build);
          }),
      );
    // A loader that throws before returning its promise still fails through `attempt`.
    const read = (async () => load())();
    // Keep this request alive until the read settles, so the calls waiting on it are released.
    waitUntil(read.catch(() => undefined));
    const loaded = yield* Effect.tryPromise({ try: () => read, catch: (cause) => cause }).pipe(
      Effect.catch(failedBuild),
    );
    const protocol = yield* learn(build, loaded);
    entry.loaded = loaded;
    return { protocol, load: async () => loaded };
  });

/**
 * A call whose Worker failed to load in this isolate. No authored code ran for it. The load's own
 * failure is not kept: an app's module initialization can throw any text.
 */
class ColdStartFailed extends Schema.TaggedError<ColdStartFailed>()("ColdStartFailed", {}) {}

/**
 * The runtime an invocation uses and its name. A call that uses an app's database runs in its data
 * facet; everything else runs in the app Worker. Both are named by app, build and the selected
 * account IDs, never by credential values or workflow runs.
 */
export const appWorker = (
  invocation: Pick<AppInvocation, "app" | "build" | "database" | "command" | "accounts">,
) =>
  facetIdentity(invocation.build, invocation.accounts).pipe(
    Effect.map((identity) => ({
      identity,
      mode:
        invocation.database && dataOperations.has(invocation.command.operation)
          ? ("facet" as const)
          : ("worker" as const),
      name: `${invocation.app}:${identity}`,
    })),
  );

/**
 * The accounts a bundle of this protocol reads. A bundle that reads sealed handles gets the
 * secret fields of providers with hosts, and every string of a managed account, sealed. An
 * earlier bundle reads every field as a real value, so it gets accounts as they are, and an
 * invocation of it with a managed account fails without reaching it.
 */
const bundleAccounts = (
  protocol: AppProtocol,
  app: string,
  key: Effect.Effect<CryptoKey>,
  accounts: HostAccounts,
): Effect.Effect<ResolvedAccounts, RuntimeProtocolFailed> => {
  if (protocol.sealedCredentials) return sealAccounts(accounts, { app, key });
  const unsealed = unsealedAccounts(accounts);
  return unsealed === undefined ? failed("managed") : Effect.succeed(unsealed);
};

/**
 * A workflow whose steps read their accounts as this app's invocations do, through
 * `bundleAccounts`. The host resolves current credentials for each step.
 */
const boundWorkflow = (
  execution: WorkflowExecution,
  accounts: (resolved: HostAccounts) => Effect.Effect<ResolvedAccounts, RuntimeProtocolFailed>,
): WorkflowExecution => ({
  ...execution,
  resolve: () =>
    execution.resolve().pipe(
      Effect.flatMap((context) =>
        accounts(Redacted.value(context.accounts)).pipe(
          Effect.mapError(() => new WorkflowFailure({ reason: "credentials", retryable: false })),
          Effect.map((accounts) => ({ ...context, accounts: Redacted.make(accounts) })),
        ),
      ),
    ),
});

/** Times one step of an invocation on the runner's clock. */
type Timed = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
const notTimed: Timed = (effect) => effect;

/**
 * The runner's own part of one invocation, on its own clock: how long it took, and how much of that
 * it waited on the isolate running the app. Starting the call there, cold starts included, is the
 * runner's own time: the app runs only once the runner waits for its result. A caller in another
 * isolate cannot measure any of it, since Workers clocks advance only on I/O and are not comparable
 * across isolates.
 */
const runnerTiming = () => {
  let waitMs = 0;
  const waiting: Timed = (effect) =>
    Effect.flatMap(Clock.currentTimeNanos, (from) =>
      effect.pipe(
        Effect.ensuring(
          Effect.flatMap(Clock.currentTimeNanos, (to) =>
            Effect.sync(() => {
              waitMs += Number(to - from) / 1_000_000;
            }),
          ),
        ),
      ),
    );
  /** Add the timing to an object reply: an additive field, like `cacheChanged`. */
  const report = <E, R>(invoke: Effect.Effect<unknown, E, R>) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeNanos;
      const result = yield* invoke;
      const elapsedMs = Number((yield* Clock.currentTimeNanos) - started) / 1_000_000;
      return typeof result === "object" && result !== null && !Array.isArray(result)
        ? { ...result, runner: { elapsedMs, waitMs } }
        : result;
    });
  return { waiting, report };
};

/** Build the runner for one host's bindings. */
export const makeAppRunner = (host: AppRunnerHost) => {
  /** Start one call in a loaded Worker and release its invocation capability afterwards. */
  const startOnce = (
    name: string | null,
    code: () => Promise<WorkerBundle>,
    options: {
      readonly body: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly globalOutbound: Fetcher | null;
      readonly elicit: Callback | null;
      readonly controls: Callback | null;
      readonly workflow?: WorkflowExecution;
      readonly cache: Effect.Effect<CacheSession> | null;
      /** Keep a failure's text for the deployer; see `failed`. */
      readonly explain: boolean;
      readonly waiting: Timed;
    },
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const lifetime = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) => Effect.sync(() => controller.abort()),
        );
        // The Worker stays loaded until the call, including a successful call's release, is over.
        let held = false;
        const residency = host.residency;
        const unhold =
          name === null || residency === undefined
            ? Effect.void
            : yield* Effect.acquireRelease(
                residency.hold(name, namedWorker(host.loader, name), host.waitUntil),
                (unhold) => (held ? Effect.void : unhold),
              );
        const services = yield* Effect.context<never>();
        const load = async () => {
          // Recorded when the Worker Loader runs its cold-start callback, inside runtime.app.rpc.start.
          const read = await Effect.runPromiseWith(services)(
            Effect.tryPromise({ try: code, catch: (cause) => cause }).pipe(
              Effect.map((bundle) =>
                loadedModules("__executor_rpc.js", {
                  ...workerModules(bundle.modules),
                  // A declaration's Worker loads the app inside the call to keep a failure's stack.
                  "__executor_rpc.js": appRpcBridge(
                    bundle.mainModule,
                    name === null ? "call" : "module",
                  ),
                  [appNetworkModuleName]: appNetworkModule,
                }),
              ),
              Effect.tap(annotateLoaded),
              Effect.withSpan("runtime.app.cold_start.load"),
              Effect.result,
            ),
          );
          // The loader reports the original failure; see loadWorker.
          if (Result.isFailure(read)) throw read.failure;
          return {
            mainModule: "__executor_rpc.js",
            modules: read.success.modules,
            compatibilityDate,
            compatibilityFlags: ["nodejs_compat"],
            globalOutbound: options.globalOutbound,
          };
        };
        const worker =
          name === null ? host.loader.get(null, load) : loadWorker(host.loader, name, load).worker;
        const entry = yield* Schema.decodeUnknownEffect(AppRpcEntrypoint)(
          worker.getEntrypoint(),
        ).pipe(Effect.catch(() => failed("internal")));
        const workflow =
          options.workflow === undefined
            ? null
            : yield* invocationWorkflow(options.workflow, lifetime.signal);
        const elicit = options.elicit;
        const delivery =
          elicit === null
            ? null
            : async (input: unknown) =>
                Schema.encodeSync(ElicitationReply)(
                  Schema.decodeUnknownSync(ElicitationReply)(await elicit(input)),
                );
        const cache = options.cache === null ? undefined : yield* options.cache;
        const closeCache = cache?.close ?? Effect.void;
        const call = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              entry.start(
                options.body,
                options.headers,
                delivery,
                workflow,
                options.controls,
                cache?.callback ?? null,
              ),
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((cause): Effect.Effect<never, RuntimeProtocolFailed | ColdStartFailed> =>
              name !== null && failedColdStart(cause)
                ? Effect.fail(new ColdStartFailed())
                : failedFrom(options.explain)(cause),
            ),
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(AppRpcInvocation)(value).pipe(
                Effect.catch(failedFrom(options.explain)),
              ),
            ),
            Effect.withSpan("runtime.app.rpc.start"),
            Effect.onError(() => closeCache),
          ),
          (call, exit) => {
            let released: Promise<void> | undefined;
            // Bounded, so a release RPC that never settles cannot hold its owner open. The app's
            // bridge runs drain and cancel, so a rejection is classified like start's and result's.
            const release = attempt(
              () =>
                (released ??= (async () => {
                  try {
                    if (Exit.isSuccess(exit)) await call.drain?.();
                  } finally {
                    try {
                      await call.cancel();
                    } finally {
                      call[Symbol.dispose]();
                    }
                  }
                })()),
            ).pipe(
              Effect.interruptible,
              Effect.timeoutOption(releaseLimit),
              Effect.tap((settled) =>
                Option.isNone(settled)
                  ? Effect.annotateCurrentSpan("executor.release.timed_out", true)
                  : Effect.void,
              ),
              Effect.withSpan("runtime.app.rpc.release"),
              Effect.catchCause(() => Effect.void),
            );
            // Leases are released once the call's own work is over: a cancelled call at once, a
            // successful one after its background refreshes, even past the release limit.
            if (Exit.isFailure(exit)) return release.pipe(Effect.ensuring(closeCache));
            held = true;
            // A release that outlives its limit still runs in the Worker, draining cache refreshes:
            // keep the Worker loaded until it settles, so the residency never unloads it midway.
            const settled = Effect.promise(
              () => released?.catch(() => undefined) ?? Promise.resolve(),
            );
            return Effect.context<never>().pipe(
              Effect.flatMap((services) =>
                Effect.sync(() =>
                  host.waitUntil(
                    Effect.runPromiseWith(services)(
                      release.pipe(
                        Effect.ensuring(settled),
                        Effect.ensuring(closeCache),
                        Effect.ensuring(unhold),
                      ),
                    ),
                  ),
                ),
              ),
            );
          },
        );
        return yield* attempt(() => call.result(), options.explain).pipe(
          options.waiting,
          Effect.withSpan("runtime.app.rpc.result"),
        );
      }),
    );
  /**
   * Callers that share a cold start share its failure, including one caused by the first caller's
   * cancellation. The failed load retired the name, so each of them starts once more under the
   * fresh name with its own build loader.
   */
  const start = (
    ...args: Parameters<typeof startOnce>
  ): Effect.Effect<unknown, RuntimeProtocolFailed> =>
    startOnce(...args).pipe(
      Effect.catchTag("ColdStartFailed", () =>
        startOnce(...args).pipe(
          Effect.withSpan("runtime.app.cold_start.retry"),
          Effect.catchTag("ColdStartFailed", () => failed("cold-start")),
        ),
      ),
    );

  /** Run one call through its data supervisor, which loads the facet only on a cold start. */
  const facet = (
    invocation: AppInvocation,
    identity: string,
    capabilities: AppCapabilities,
    protocol: AppProtocol,
    load: () => Promise<LoadedWorkerBuild>,
    body: string,
    waiting: Timed,
  ) =>
    Effect.gen(function* () {
      const target = host.data(invocation.app);
      const id = crypto.randomUUID();
      const { command } = invocation;
      const result = yield* target
        .invoke(
          {
            id,
            app: invocation.app,
            identity,
            cacheNamespace: invocation.build,
            body,
            headers: invocation.headers,
            write:
              writeOperations.has(command.operation) ||
              // A call without a kind is to a tool the catalog does not list; it may write.
              (command.operation === "call" && command.kind !== "query"),
            concurrent: protocol.concurrentData,
          },
          async () => {
            const bundle = await load();
            return {
              mainModule: "__executor_facet.js",
              modules: reachableModules("__executor_facet.js", {
                ...bundle.modules,
                "__executor_facet.js": appFacetBridge(bundle.mainModule),
                [appNetworkModuleName]: appNetworkModule,
              }),
            };
          },
          capabilities.elicit,
          capabilities.controls,
        )
        .pipe(
          waiting,
          Effect.catch(failedData),
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(FacetResult)(value).pipe(
              Effect.catch(() => failed("invalid-reply")),
            ),
          ),
          Effect.onInterrupt(() => target.cancel(id).pipe(Effect.catchCause(() => Effect.void))),
        );
      const value = yield* protocol.response(command, result.value).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))),
        Effect.catch(() => failed("invalid-reply")),
      );
      return {
        ...value,
        executorRevision: result.revision,
        ...(result.cacheChanged === true ? { cacheChanged: true } : {}),
        // The supervisor's own part, on its clock, when it reports one.
        ...(result.timing === undefined ? {} : { supervisor: result.timing }),
      };
    });

  return {
    /**
     * Run an authorized call of a retained build. Its Worker is named by app, build and account
     * selection, so renewed credentials, other runs and other calls of the same selection reuse it.
     */
    invoke: (invocation: AppInvocation, capabilities: AppCapabilities) => {
      const timing = runnerTiming();
      return Effect.gen(function* () {
        const { identity, mode, name } = yield* appWorker(invocation).pipe(
          Effect.catch(() => failed("internal")),
        );
        yield* Effect.annotateCurrentSpan({
          "executor.runtime.mode": mode,
          "executor.worker.identity": name,
        });
        // The build's protocol adapter owns this boundary: requests leave, and replies return, in
        // the host's current model whichever protocol the retained bundle speaks.
        const { protocol, load } = yield* protocolOf(
          invocation.build,
          capabilities.load,
          host.waitUntil,
        );
        // A command this protocol's bundles would not run as asked fails without reaching them.
        const refused = protocol.refuse(invocation.command);
        if (refused !== undefined) return { ok: false, error: refused };
        const accountsFor = (resolved: HostAccounts) =>
          bundleAccounts(protocol, invocation.app, host.credentialKey, resolved);
        const accounts = yield* accountsFor(invocation.accounts);
        const body = protocol.invocation({
          command: invocation.command,
          accounts,
          ...(invocation.approval === undefined ? {} : { approval: invocation.approval }),
          ...(invocation.replay === undefined ? {} : { replay: invocation.replay }),
          ...(invocation.deadline === undefined ? {} : { deadline: invocation.deadline }),
          ...(capabilities.workflow === undefined
            ? {}
            : { workflowRun: capabilities.workflow.runId }),
        });
        if (mode === "facet")
          return yield* Effect.scoped(
            Effect.gen(function* () {
              // The facet Worker counts against the same limit as app Workers while it is loaded.
              const unloadFacet = host.unloadFacet;
              if (host.residency !== undefined && unloadFacet !== undefined) {
                const hold = host.residency.hold(
                  `data:${name}`,
                  {
                    run: unloadFacet(invocation.app, identity).pipe(
                      Effect.orElseSucceed(() => false),
                    ),
                    // The supervisor replaces a facet Worker whose unload does not settle.
                    abandon: () => undefined,
                  },
                  host.waitUntil,
                );
                yield* Effect.acquireRelease(hold, (unhold) => unhold).pipe(Effect.asVoid);
              }
              return yield* facet(
                invocation,
                identity,
                capabilities,
                protocol,
                load,
                body,
                timing.waiting,
              );
            }),
          );
        const data = host.data(invocation.app);
        const services = yield* Effect.context<never>();
        // Cache writes after the result (background refreshes) are not reported to the host.
        let cacheChanged = false;
        const store =
          (lanes: Semaphore.Semaphore): CacheTransport =>
          (command) =>
            lanes
              .withPermits(1)(data.cache(invocation.build, command))
              .pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(CacheReply)),
                Effect.mapError(() => new CacheError({ reason: "storage" })),
                Effect.flatMap((reply) =>
                  reply.ok ? Effect.succeed(reply.value) : Effect.fail(reply.error),
                ),
              );
        // Each attempt owns the leases its Worker claims until that attempt's release finishes.
        const cache = Effect.suspend(() =>
          holdLeases(store(Semaphore.makeUnsafe(cacheLanes))),
        ).pipe(
          Effect.map((leases): CacheSession => ({
            callback: (command) =>
              Effect.runPromiseWith(services)(
                Schema.decodeUnknownEffect(CacheCommand)(command).pipe(
                  Effect.mapError(() => new CacheError({ reason: "invalid" })),
                  Effect.flatMap(leases.transport),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (discardsEvaluated(command)) cacheChanged = true;
                    }),
                  ),
                  Effect.match({
                    onSuccess: (value) => ({ ok: true as const, value }),
                    onFailure: (error) => ({ ok: false as const, error }),
                  }),
                  Effect.flatMap(Schema.encodeEffect(CacheReply)),
                ),
              ),
            close: leases.close,
          })),
        );
        const reply = yield* start(name, load, {
          body,
          headers: invocation.headers,
          globalOutbound: host.outbound(invocation.app),
          elicit: capabilities.elicit,
          controls: capabilities.controls,
          ...(capabilities.workflow === undefined
            ? {}
            : {
                workflow: protocol.workflow(boundWorkflow(capabilities.workflow, accountsFor)),
              }),
          cache,
          explain: false,
          waiting: timing.waiting,
        });
        const result = yield* protocol.response(invocation.command, reply);
        return cacheChanged &&
          typeof result === "object" &&
          result !== null &&
          !Array.isArray(result)
          ? { ...result, cacheChanged: true }
          : result;
      }).pipe(Effect.scoped, timing.report, Effect.withSpan("runtime.app.invoke"));
    },
    /**
     * Evaluate a new build's declarations before it is retained. No later call can reuse this
     * Worker, so it is not named and the runtime does not keep it; it has no network or cache.
     */
    declare: (bundle: LoadedWorkerBuild, headers: Readonly<Record<string, string>>) =>
      Effect.gen(function* () {
        const protocol = yield* appProtocol(bundle.protocol).pipe(
          Effect.catch((cause) => failed("unsupported", cause, true)),
        );
        const command = { operation: "requirements" } as const;
        const reply = yield* start(null, async () => bundle, {
          body: protocol.invocation({ command, accounts: {} }),
          headers,
          globalOutbound: null,
          elicit: null,
          controls: null,
          cache: null,
          // The deployer sees why the app's declarations failed, in the app's own terms.
          explain: true,
          waiting: notTimed,
        });
        return yield* protocol.response(command, reply);
      }).pipe(Effect.withSpan("runtime.app.declare")),
  };
};
export type AppRunner = ReturnType<typeof makeAppRunner>;
