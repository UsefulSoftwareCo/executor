import type { Fetcher, WorkerLoader } from "@cloudflare/workers-types";
import {
  Clock,
  Context,
  Effect,
  Exit,
  Option,
  Redacted,
  Result,
  Schema,
  type Scope,
  Semaphore,
} from "effect";
import {
  ElicitationReply,
  type HostRequest,
  type HostAccounts,
  scopedSlots,
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
import type { StartedPart } from "../contracts/runtime.ts";
import { appCacheNamespace, type HostApiCheck } from "../contracts/host-api.ts";
import { appProtocol, type AppProtocol } from "./app-protocols.ts";
import { appFacetBridge, appNetworkModuleName, appRpcBridge } from "./worker-bridge.ts";
import { appNetworkModule, outboundGroupHeader } from "./app-network.ts";
import { sealAccounts, unsealedAccounts } from "./credential-handles.ts";
import { AppRpcEntrypoint, AppRpcInvocation } from "./worker-elicitation.ts";
import { invocationWorkflow } from "./worker-workflow-rpc.ts";
import { type AppWorkerResidency, namedWorker } from "./app-worker-residency.ts";

type Callback = (input: unknown) => Promise<unknown>;

export interface AppDataHost {
  readonly invoke: (
    input: typeof FacetInvocation.Type,
    load: () => Promise<typeof FacetBundle.Type>,
    elicit: Callback | null,
    controls: Callback | null,
  ) => Effect.Effect<unknown, unknown>;
  readonly cancel: (id: string) => Effect.Effect<void, unknown>;
  readonly cache: (namespace: string, command: unknown) => Effect.Effect<unknown, unknown>;
  readonly wake?: (reason: SupervisorWakeReason) => Effect.Effect<unknown, unknown>;
}

export type SupervisorWakeReason = "build" | "app";

export interface AppRunnerHost {
  readonly loader: Pick<WorkerLoader, "get">;
  readonly outbound: (app: string, hostApi: HostApiCheck | undefined) => Fetcher;
  readonly credentialKey: Effect.Effect<CryptoKey>;
  readonly data: (app: string) => AppDataHost;
  readonly waitUntil: (task: Promise<unknown>) => void;
  readonly residency?: AppWorkerResidency;
  readonly unloadFacet?: (app: string, identity: string) => Effect.Effect<boolean, unknown>;
  readonly within?: { readonly supervisor: { readonly serves: (app: string) => boolean } };
  readonly outboundGroup?: (group: string) => Effect.Effect<void, never, Scope.Scope>;
}

export interface AppInvocation {
  readonly caller?: string;
  readonly app: string;
  readonly build: string;
  readonly hostApi?: HostApiCheck;
  readonly database: boolean;
  readonly command: HostRequest;
  readonly accounts: HostAccounts;
  readonly approval?: typeof TrustedToolApproval.Type;
  readonly replay?: typeof WorkflowReplay.Type;
  readonly deadline?: typeof InvocationDeadline.Type;
  readonly run?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly outboundGroup?: string;
}

export interface AppCapabilities {
  readonly load: () => Promise<LoadedWorkerBuild>;
  readonly elicit: Callback | null;
  readonly controls: Callback | null;
  readonly workflow?: WorkflowExecution;
}

const dataOperations: ReadonlySet<HostRequest["operation"]> = new Set([
  "migrate",
  "connect",
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
  "connect",
  "mutate",
  "webhook-register",
  "webhook-handle",
  "webhook-unregister",
]);
const compatibilityDate = "2026-07-30";
const releaseLimit = "35 seconds";

const cacheLanes = 2;

const loadedModules = <Module>(main: string, modules: Readonly<Record<string, Module>>) => ({
  modules: reachableModules(main, modules),
  total: Object.keys(modules).length,
});
const annotateLoaded = ({ modules, total }: ReturnType<typeof loadedModules>) =>
  Effect.annotateCurrentSpan({
    "executor.worker.modules": Object.keys(modules).length,
    "executor.worker.modules_total": total,
  });

interface CacheSession {
  readonly callback: Callback;
  readonly close: Effect.Effect<void>;
}

const platformFailures: ReadonlyArray<readonly [RegExp, RuntimeFailure]> = [
  [/Serialized RPC arguments or return values are limited to/i, "too-large"],
  [/exceeded (its )?memory limit/i, "memory"],
  [/exceeded (its )?CPU time limit/i, "cpu"],
  [/timed out|exceeded (a |its )?(time limit|timeout|wall)/i, "timeout"],
  [/overloaded/i, "overloaded"],
  [/Durable Object reset|object to be reset|code (was|has been) updated/i, "reset"],
  [/Network connection lost/i, "disconnected"],
  [/will never generate a response|Promise will never complete/i, "hung"],
  [/^(\w+: )?internal error/i, "internal"],
];
export const classify = (cause: unknown): RuntimeFailure => {
  if (Schema.is(RuntimeProtocolFailed)(cause) && cause.reason !== undefined) return cause.reason;
  if (Schema.isSchemaError(cause)) return "invalid-reply";
  if (failedColdStart(cause)) return "cold-start";
  const text = describeBuildCause(cause);
  if (/^(\w+: )?SchemaError\b/.test(text)) return "invalid-reply";
  return platformFailures.find(([pattern]) => pattern.test(text))?.[1] ?? "unrecognized";
};
export type RejectedCall = "runner" | "app";
const standardErrorNames: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DataCloneError",
  "InvalidStateError",
  "NetworkError",
]);
const causeShape = (cause: unknown, rejected: RejectedCall) => {
  const message =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
  return {
    "executor.runtime.cause.call": rejected,
    "executor.runtime.cause.kind":
      cause instanceof Error
        ? "error"
        : cause === null || cause === undefined
          ? "empty"
          : typeof cause === "string" || typeof cause === "object"
            ? typeof cause
            : "other",
    ...(cause instanceof Error
      ? { "executor.runtime.cause.name": standardErrorNames.has(cause.name) ? cause.name : "other" }
      : {}),
    ...(message === undefined ? {} : { "executor.runtime.cause.message_length": message.length }),
  };
};
const failed = (
  reason: RuntimeFailure,
  cause?: unknown,
  explain = false,
  rejected?: RejectedCall,
) =>
  Effect.annotateCurrentSpan({
    "executor.runtime.failure": reason,
    "executor.runtime.cause": runtimeFailures[reason],
    ...(reason === "unrecognized" && rejected !== undefined ? causeShape(cause, rejected) : {}),
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
export const failedFrom =
  (explain: boolean, rejected: RejectedCall = "app") =>
  (cause: unknown) =>
    failed(classify(cause), cause, explain, rejected);
const failedBuild = (cause: unknown) =>
  Effect.annotateCurrentSpan({
    "executor.runtime.failure": "build",
    "executor.runtime.cause": describeBuildCause(cause),
  }).pipe(Effect.andThen(Effect.fail(new RuntimeProtocolFailed({ reason: "build" }))));
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
const protocols = new Map<string, AppProtocol>();
const protocolLimit = 4096;
const reads = new Map<string, { loaded?: LoadedWorkerBuild }>();
const readCheck = "10 millis";
const readWait = 10_000;

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

const protocolOf = (
  build: string,
  load: () => Promise<LoadedWorkerBuild>,
  waitUntil: (task: Promise<unknown>) => void,
  reading: () => void,
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
    reading();
    const read = (async () => load())();
    waitUntil(read.catch(() => undefined));
    const loaded = yield* Effect.tryPromise({ try: () => read, catch: (cause) => cause }).pipe(
      Effect.catch(failedBuild),
    );
    const protocol = yield* learn(build, loaded);
    entry.loaded = loaded;
    return { protocol, load: async () => loaded };
  });

class ColdStartFailed extends Schema.TaggedError<ColdStartFailed>()("ColdStartFailed", {}) {}

export const appWorker = (
  invocation: Pick<
    AppInvocation,
    "app" | "build" | "database" | "command" | "accounts" | "hostApi"
  >,
) =>
  facetIdentity(invocation.build, Object.fromEntries(scopedSlots(invocation.accounts))).pipe(
    Effect.map((selection) => {
      const identity =
        invocation.hostApi === undefined
          ? selection
          : `${selection}:${invocation.hostApi.revision}`;
      return {
        identity,
        mode: runsInFacet(invocation) ? ("facet" as const) : ("worker" as const),
        name: `${invocation.app}:${identity}`,
      };
    }),
  );

export const runsInFacet = (invocation: Pick<AppInvocation, "database" | "command">) =>
  invocation.database && dataOperations.has(invocation.command.operation);

const bundleAccounts = (
  protocol: AppProtocol,
  app: string,
  key: Effect.Effect<CryptoKey>,
  accounts: HostAccounts,
): Effect.Effect<ResolvedAccounts, RuntimeProtocolFailed> => {
  if (protocol.sealedCredentials)
    return sealAccounts(accounts, { app, key }).pipe(Effect.map(protocol.accounts));
  const unsealed = unsealedAccounts(accounts);
  return unsealed === undefined ? failed("managed") : Effect.succeed(protocol.accounts(unsealed));
};

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

type Timed = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
const notTimed: Timed = (effect) => effect;

export const IsolateStarted = Context.Reference<(part: StartedPart | "unknown") => void>(
  "executor/IsolateStarted",
  { defaultValue: () => () => undefined },
);

// oxlint-disable-next-line executor/no-module-level-mutable-state -- whether this isolate has received a call; it carries no request data
let runnerReceived = false;

export const runnerIngress = Effect.map(Clock.currentTimeNanos, (receivedAt) => {
  const first = !runnerReceived;
  runnerReceived = true;
  return { receivedAt, first };
});

export const RunnerIngress = Context.Reference<
  { readonly receivedAt: bigint; readonly first: boolean } | undefined
>("executor/RunnerIngress", { defaultValue: () => undefined });

const runnerTiming = (within: AppRunnerHost["within"]) => {
  let waitMs = 0;
  const startedParts = new Set<StartedPart>();
  let startsKnown = true;
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
  const report = <E, R>(invoke: Effect.Effect<unknown, E, R>) =>
    Effect.gen(function* () {
      const ingress = (yield* RunnerIngress) ?? (yield* runnerIngress);
      if (ingress.first && within === undefined) startedParts.add("runner");
      const started = ingress.receivedAt;
      const result = yield* invoke.pipe(
        Effect.provideService(IsolateStarted, (part) => {
          if (part === "unknown") startsKnown = false;
          else startedParts.add(part);
        }),
      );
      const elapsedMs = Number((yield* Clock.currentTimeNanos) - started) / 1_000_000;
      return typeof result === "object" && result !== null && !Array.isArray(result)
        ? {
            ...result,
            runner: {
              elapsedMs,
              waitMs,
              ...(startsKnown ? { started: [...startedParts] } : {}),
              ...(within === undefined ? {} : { host: "supervisor" as const }),
            },
          }
        : result;
    });
  return { waiting, report };
};

export const makeAppRunner = (host: AppRunnerHost) => {
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
          Context.get(services, IsolateStarted)("app");
          const read = await Effect.runPromiseWith(services)(
            Effect.tryPromise({ try: code, catch: (cause) => cause }).pipe(
              Effect.map((bundle) =>
                loadedModules("__executor_rpc.js", {
                  ...workerModules(bundle.modules),
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
          if (Result.isFailure(read)) throw read.failure;
          return {
            mainModule: "__executor_rpc.js",
            modules: read.success.modules,
            compatibilityDate,
            compatibilityFlags: ["nodejs_compat", "no_brotli_content_encoding"],
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
            if (Exit.isFailure(exit)) return release.pipe(Effect.ensuring(closeCache));
            held = true;
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

  const facet = (
    target: AppDataHost,
    invocation: AppInvocation,
    identity: string,
    capabilities: AppCapabilities,
    protocol: AppProtocol,
    load: () => Promise<LoadedWorkerBuild>,
    body: string,
    waiting: Timed,
  ) =>
    Effect.gen(function* () {
      const id = crypto.randomUUID();
      const { command } = invocation;
      const result = yield* target
        .invoke(
          {
            id,
            app: invocation.app,
            identity,
            cacheNamespace: appCacheNamespace(invocation.build, invocation.hostApi),
            ...(invocation.hostApi === undefined ? {} : { hostApi: invocation.hostApi }),
            body,
            headers: invocation.headers,
            write:
              writeOperations.has(command.operation) ||
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
        ...(result.resent === true ? { resent: true } : {}),
        ...(result.timing === undefined ? {} : { supervisor: result.timing }),
      };
    });

  return {
    invoke: (invocation: AppInvocation, capabilities: AppCapabilities) => {
      const timing = runnerTiming(host.within);
      return Effect.gen(function* () {
        if (host.within !== undefined) {
          const refused = !host.within.supervisor.serves(invocation.app)
            ? "other-app"
            : !runsInFacet(invocation)
              ? "not-database"
              : undefined;
          if (refused !== undefined) {
            yield* Effect.annotateCurrentSpan("executor.runner.refused", refused);
            return yield* failed("internal");
          }
        }
        const { identity, mode, name } = yield* appWorker(invocation).pipe(
          Effect.catch(() => failed("internal")),
        );
        yield* Effect.annotateCurrentSpan({
          "executor.runtime.mode": mode,
          "executor.worker.identity": name,
        });
        const data = host.data(invocation.app);
        const services = yield* Effect.context<never>();
        const wake = data.wake;
        let woken = mode === "facet" || wake === undefined;
        const wakeSupervisor = (reason: SupervisorWakeReason) => {
          if (woken || wake === undefined) return;
          woken = true;
          try {
            host.waitUntil(
              Effect.runPromiseWith(services)(
                wake(reason).pipe(Effect.catchCause(() => Effect.void)),
              ),
            );
          } catch {}
        };
        const { protocol, load } = yield* protocolOf(
          invocation.build,
          capabilities.load,
          host.waitUntil,
          () => wakeSupervisor("build"),
        );
        const refused = protocol.refuse(invocation.command);
        if (refused !== undefined) return { ok: false, error: refused };
        const accountsFor = (resolved: HostAccounts) =>
          bundleAccounts(protocol, invocation.app, host.credentialKey, resolved);
        const accounts = yield* accountsFor(invocation.accounts);
        const body = protocol.invocation({
          command: invocation.command,
          accounts,
          ...(invocation.caller === undefined ? {} : { caller: invocation.caller }),
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
              const unloadFacet = host.unloadFacet;
              if (host.residency !== undefined && unloadFacet !== undefined) {
                const hold = host.residency.hold(
                  `data:${name}`,
                  {
                    run: unloadFacet(invocation.app, identity).pipe(
                      Effect.orElseSucceed(() => false),
                    ),
                    abandon: () => undefined,
                  },
                  host.waitUntil,
                );
                yield* Effect.acquireRelease(hold, (unhold) => unhold).pipe(Effect.asVoid);
              }
              return yield* facet(
                data,
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
        let cacheChanged = false;
        const store =
          (lanes: Semaphore.Semaphore): CacheTransport =>
          (command) =>
            lanes
              .withPermits(1)(
                data.cache(appCacheNamespace(invocation.build, invocation.hostApi), command),
              )
              .pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(CacheReply)),
                Effect.mapError(() => new CacheError({ reason: "storage" })),
                Effect.flatMap((reply) =>
                  reply.ok ? Effect.succeed(reply.value) : Effect.fail(reply.error),
                ),
              );
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
        const started = yield* IsolateStarted;
        const group = host.outboundGroup === undefined ? undefined : invocation.outboundGroup;
        if (group !== undefined && host.outboundGroup !== undefined)
          yield* host.outboundGroup(group);
        const grouped =
          group === undefined
            ? invocation.headers
            : { ...invocation.headers, [outboundGroupHeader]: group };
        const reply = yield* start(name, load, {
          body,
          headers: grouped,
          globalOutbound: host.outbound(invocation.app, invocation.hostApi),
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
        }).pipe(
          Effect.provideService(IsolateStarted, (part) => {
            started(part);
            if (part === "app") wakeSupervisor("app");
          }),
        );
        const result = yield* protocol.response(invocation.command, reply);
        return cacheChanged &&
          typeof result === "object" &&
          result !== null &&
          !Array.isArray(result)
          ? { ...result, cacheChanged: true }
          : result;
      }).pipe(Effect.scoped, timing.report, Effect.withSpan("runtime.app.invoke"));
    },
    declare: (bundle: LoadedWorkerBuild, headers: Readonly<Record<string, string>>) =>
      Effect.gen(function* () {
        const protocol = yield* appProtocol(bundle.protocol).pipe(
          Effect.catch((cause) => failed("unsupported", cause, true)),
        );
        const command = { operation: "requirements" } as const;
        const reply = yield* start(null, async () => bundle, {
          body: protocol.invocation({ command, accounts: { app: {} } }),
          headers,
          globalOutbound: null,
          elicit: null,
          controls: null,
          cache: null,
          explain: true,
          waiting: notTimed,
        });
        return yield* protocol.response(command, reply);
      }).pipe(Effect.withSpan("runtime.app.declare")),
  };
};
export type AppRunner = ReturnType<typeof makeAppRunner>;
