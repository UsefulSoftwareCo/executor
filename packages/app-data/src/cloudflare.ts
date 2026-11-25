import { retireMethod, WorkerBundle, workerModules } from "./contracts/worker-bundle.ts";
import type {
  DurableObjectState,
  Fetcher,
  WorkerLoader,
  WorkerLoaderWorkerCode,
  WebSocket,
} from "@cloudflare/workers-types";
import { Clock, Deferred, Effect, Exit, Result, Schema, Semaphore } from "effect";
import { fingerprint } from "./implementation/fingerprint.ts";
import { AppDatabaseError } from "./contracts/database.ts";
import { HostApiCheck } from "./contracts/host-api.ts";
import { CacheCommand, CacheError, CacheReply } from "@executor-js/app-cache/contracts";
import { holdLeases } from "@executor-js/app-cache";
import { discardsEvaluated } from "@executor-js/app-cache/changes";
import { sqliteCache } from "@executor-js/app-cache/sqlite";
import { evaluatedStore } from "./implementation/evaluated.ts";
import type {
  EvaluatedChanged,
  EvaluatedEntry,
  EvaluatedSupervisor,
  EvaluatedWritten,
} from "./contracts/evaluated.ts";

export const FacetBundle = WorkerBundle;
export const FacetInvocation = Schema.Struct({
  id: Schema.NonEmptyString,
  app: Schema.NonEmptyString,
  identity: Schema.NonEmptyString,
  body: Schema.String,
  cacheNamespace: Schema.optionalKey(Schema.String),
  hostApi: Schema.optionalKey(HostApiCheck),
  write: Schema.Boolean,
  concurrent: Schema.Boolean,
  headers: Schema.Record(Schema.String, Schema.String),
});
export const FacetResult = Schema.Struct({
  value: Schema.Json,
  revision: Schema.Int,
  cacheChanged: Schema.optionalKey(Schema.Boolean),
  resent: Schema.optionalKey(Schema.Literal(true)),
  timing: Schema.optionalKey(
    Schema.Struct({
      elapsedMs: Schema.Finite,
      waitMs: Schema.Finite,
      started: Schema.optionalKey(
        Schema.Array(
          Schema.Literals(["supervisor", "supervisor-isolate", "facet", "facet-worker"]),
        ),
      ),
    }),
  ),
});
interface FacetStarts {
  facet: boolean;
  worker: boolean;
  recycled: boolean;
}
const causes = new WeakMap<AppDatabaseError, unknown>();
export const facetFailureCause = (error: AppDatabaseError): unknown => causes.get(error);
const failed = (cause?: unknown) => {
  const error = new AppDatabaseError({ reason: "storage" });
  causes.set(error, cause);
  return error;
};

const retired = new Map<string, string>();
// oxlint-disable-next-line executor/no-module-level-mutable-state -- marks this isolate's cold-start failures; it carries no request data
let coldStartToken: string | undefined;
const coldStartFailure = () => (coldStartToken ??= `Worker cold start ${crypto.randomUUID()}`);
const describe = (cause: unknown) =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

export const loadWorker = (
  loader: Pick<WorkerLoader, "get">,
  name: string,
  code: () => Promise<WorkerLoaderWorkerCode>,
) => {
  const current = retired.get(name) ?? name;
  const worker = loader.get(current, async () => {
    try {
      return await code();
    } catch (cause) {
      if ((retired.get(name) ?? name) === current)
        retired.set(name, `${name}~${crypto.randomUUID()}`);
      throw new Error(`${coldStartFailure()} failed: ${describe(cause)}`);
    }
  });
  return { worker, current };
};
export const workerName = (name: string) => retired.get(name) ?? name;

const unloadedWorker = {
  mainModule: "retire.js",
  modules: {
    "retire.js": `import * as workers from "cloudflare:workers";
export default class extends workers.WorkerEntrypoint {
  ${retireMethod}
}`,
  },
  compatibilityDate: "2026-07-30",
};
const Retirable = Schema.declare(
  (value): value is { retire: () => Promise<unknown> } =>
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    "retire" in value &&
    typeof value.retire === "function",
);
export const replaceWorker = (name: string) => {
  retired.set(name, `${name}~${crypto.randomUUID()}`);
};
export const unloadWorker = (loader: Pick<WorkerLoader, "get">, name: string) =>
  unloadLoaded(loader, workerName(name));
const unloadLoaded = async (loader: Pick<WorkerLoader, "get">, loaded: string) => {
  const worker = loader.get(loaded, async () => unloadedWorker);
  const entry = Schema.decodeUnknownSync(Retirable)(worker.getEntrypoint());
  try {
    return (await entry.retire()) !== false;
  } catch {
    return true;
  }
};
export const failedColdStart = (cause: unknown) =>
  coldStartToken !== undefined && describe(cause).includes(coldStartToken);

const FacetEntrypoint = Schema.declare(
  (
    value,
  ): value is {
    invoke: (
      id: string,
      body: string,
      headers: Readonly<Record<string, string>>,
      elicitation: ((input: unknown) => Promise<unknown>) | null,
      workflows: ((input: unknown) => Promise<unknown>) | null,
      cache: ((input: unknown) => Promise<unknown>) | null,
    ) => Promise<unknown>;
    finish?: (id: string) => Promise<void>;
    cancel: (id: string) => Promise<void>;
  } =>
    typeof value === "object" &&
    value !== null &&
    "invoke" in value &&
    typeof value.invoke === "function" &&
    "cancel" in value &&
    typeof value.cancel === "function",
);

const loadedFacets = new Map<string, { readonly name: string; readonly loaded: string }>();

// oxlint-disable-next-line executor/no-module-level-mutable-state -- one timestamp per isolate; it carries no request data
let isolateStartedAt: number | undefined;

export const makeFacetSupervisor = (
  state: DurableObjectState,
  loader: Pick<WorkerLoader, "get">,
  globalOutbound: (app: string, hostApi: HostApiCheck | undefined) => Fetcher,
  serves: (app: string) => boolean,
  unloadReplacedFacets = false,
) =>
  Effect.gen(function* () {
    const metadata = yield* Semaphore.make(1);
    const startedAt = yield* Clock.currentTimeMillis;
    const firstInIsolate = isolateStartedAt === undefined;
    const isolateStarted = (isolateStartedAt ??= startedAt);
    let received = 0;
    let wokenBy: string | undefined;
    let wokenByWakeOf: string | undefined;
    const enter = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        received += 1;
        return effect;
      });
    const runningIn = (trace?: string, invocation?: string, wake = false) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const woke = received++ === 0;
          if (woke) {
            wokenBy = trace;
            wokenByWakeOf = wake ? invocation : undefined;
          }
          const supervisor: EvaluatedSupervisor = {
            woke,
            instanceMs: now - startedAt,
            isolateMs: now - isolateStarted,
          };
          const wokeEarlier = !woke && trace !== undefined && trace === wokenBy;
          const wokeByWake =
            !woke && !wake && invocation !== undefined && invocation === wokenByWakeOf;
          return {
            supervisor,
            wokeEarlier,
            wokeByWake,
            isolateWoke: (woke || wokeByWake) && firstInIsolate,
          };
        }),
      );
    const admission = { running: 0, identity: "", alone: false };
    let finishing = 0;
    let finished = Promise.resolve();
    let settle = () => {};
    let wake = yield* Deferred.make<void>();
    const tryEnter = (identity: string, concurrent: boolean) => {
      const joins =
        concurrent && !admission.alone && admission.running > 0 && admission.identity === identity;
      if (!joins && admission.running > 0) return wake;
      admission.running += 1;
      admission.identity = identity;
      admission.alone = !concurrent;
      return undefined;
    };
    const leave = Effect.gen(function* () {
      admission.running -= 1;
      if (admission.running === 0) admission.alone = false;
      const woken = wake;
      wake = yield* Deferred.make<void>();
      yield* Deferred.succeed(woken, undefined);
    });
    const admit = (identity: string, concurrent: boolean) =>
      Effect.gen(function* () {
        for (;;) {
          const signal = yield* Effect.acquireRelease(
            Effect.sync(() => tryEnter(identity, concurrent)),
            (pending) => (pending === undefined ? leave : Effect.void),
          );
          if (signal === undefined) return;
          yield* Deferred.await(signal);
        }
      });
    const evaluated = evaluatedStore(state.storage);
    const cached = sqliteCache(state.storage);
    const store = (namespace: string, command: unknown) =>
      cached(namespace, command).pipe(
        Effect.tap(({ replaced }) =>
          replaced || discardsEvaluated(command)
            ? Clock.currentTimeMillis.pipe(
                Effect.flatMap(evaluated.changed),
                Effect.mapError(() => new CacheError({ reason: "storage" })),
              )
            : Effect.void,
        ),
        Effect.map(({ reply }) => reply),
      );
    const cache = (namespace: string, command: unknown) =>
      store(namespace, command).pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (error) => ({ ok: false as const, error }),
        }),
        Effect.flatMap(Schema.encodeEffect(CacheReply)),
        Effect.orDie,
      );
    let writes = 0;
    const calls = new Map<
      string,
      { cancel: Deferred.Deferred<void>; done: Deferred.Deferred<void> }
    >();
    const unloadReplaced = (replaced: { readonly name: string; readonly loaded: string }) =>
      Effect.promise(() => unloadLoaded(loader, replaced.loaded)).pipe(
        Effect.timeoutOption("10 seconds"),
        Effect.flatMap((settled) =>
          settled._tag === "None" && workerName(replaced.name) === replaced.loaded
            ? Effect.sync(() => replaceWorker(replaced.name))
            : Effect.void,
        ),
        Effect.catchCause(() => Effect.void),
      );
    let active: string | undefined;
    const acquire = (
      invocation: typeof FacetInvocation.Type,
      load: () => Promise<typeof FacetBundle.Type>,
      starts: FacetStarts,
    ) =>
      Effect.gen(function* () {
        const supervisor = state.id.toString();
        const name = `${supervisor}:${invocation.identity}`;
        const loaded = workerName(name);
        if (active !== loaded) {
          state.facets.abort("data", "Execution context changed");
          active = loaded;
        } else if (admission.running === 1 && finishing === 0) {
          // Cloudflare counts a facet's subrequests over the facet's whole life, not per call
          // (cloudflare/workerd#7572), so a facet kept running across calls runs out of them and
          // every later request fails until it restarts. A call that finds the facet idle, with no
          // call or release running in it, restarts it and gets the full allowance a Worker
          // invocation has. Calls that overlap it share that allowance.
          state.facets.abort("data", "Fresh subrequest allowance");
          starts.recycled = true;
        }
        if (!unloadReplacedFacets) return yield* select(name, invocation, load, starts);
        const replaced = loadedFacets.get(supervisor);
        loadedFacets.set(supervisor, { name, loaded });
        if (replaced !== undefined && replaced.loaded !== loaded) yield* unloadReplaced(replaced);
        return yield* select(name, invocation, load, starts);
      });
    const select = (
      name: string,
      invocation: Pick<typeof FacetInvocation.Type, "app" | "hostApi">,
      load: () => Promise<typeof FacetBundle.Type>,
      starts: FacetStarts,
    ) =>
      Effect.try({
        try: () =>
          Schema.decodeUnknownSync(FacetEntrypoint)(
            state.facets.get("data", () => {
              starts.facet = true;
              const { worker } = loadWorker(loader, name, async () => {
                starts.worker = true;
                const bundle = Schema.decodeUnknownSync(Schema.toType(FacetBundle))(await load());
                return {
                  ...bundle,
                  modules: workerModules(bundle.modules),
                  compatibilityDate: "2026-07-30",
                  compatibilityFlags: ["nodejs_compat", "no_brotli_content_encoding"],
                  globalOutbound: globalOutbound(invocation.app, invocation.hostApi),
                };
              });
              return { class: worker.getDurableObjectClass("ExecutorAppData") };
            }),
          ),
        catch: failed,
      });
    const revision = Effect.tryPromise({
      try: () => state.storage.get("revision"),
      catch: failed,
    }).pipe(
      Effect.flatMap((value) =>
        value === undefined
          ? Effect.succeed(0)
          : Schema.decodeUnknownEffect(Schema.Int)(value).pipe(Effect.mapError(failed)),
      ),
    );
    const pending = Effect.tryPromise({
      try: () => state.storage.get("pending"),
      catch: failed,
    }).pipe(
      Effect.flatMap((value) =>
        value === undefined
          ? Effect.succeed(false)
          : Schema.decodeUnknownEffect(Schema.Boolean)(value).pipe(Effect.mapError(failed)),
      ),
    );
    const arm = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.tryPromise({
        try: () => state.storage.setAlarm(now + 1_000),
        catch: failed,
      }),
    );
    const send = (socket: WebSocket, value: number) => {
      socket.send(JSON.stringify({ revision: value }));
      socket.serializeAttachment({ revision: value });
    };
    const notify = (value: number) =>
      Effect.try({
        try: () => {
          for (const socket of state.getWebSockets()) {
            const attachment = Schema.decodeUnknownSync(
              Schema.NullOr(Schema.Struct({ revision: Schema.Int })),
            )(socket.deserializeAttachment());
            if (attachment === null || attachment.revision < value) send(socket, value);
          }
        },
        catch: failed,
      });
    const begin = metadata.withPermits(1)(
      Effect.gen(function* () {
        yield* arm;
        yield* Effect.tryPromise({
          try: () => state.storage.put("pending", true),
          catch: failed,
        });
        writes++;
      }),
    );
    const finish = metadata.withPermits(1)(
      Effect.gen(function* () {
        writes--;
        const next = (yield* revision) + 1;
        yield* Effect.tryPromise({
          try: () => state.storage.put({ revision: next, pending: writes > 0 }),
          catch: failed,
        });
        yield* notify(next);
        if (writes === 0)
          yield* Effect.tryPromise({
            try: () => state.storage.deleteAlarm(),
            catch: failed,
          });
      }),
    );
    const recover = metadata.withPermits(1)(
      Effect.gen(function* () {
        if (writes > 0) return yield* arm;
        if (yield* pending) {
          const next = (yield* revision) + 1;
          yield* Effect.tryPromise({
            try: () => state.storage.put({ revision: next, pending: false }),
            catch: failed,
          });
        }
        yield* notify(yield* revision);
        yield* Effect.tryPromise({
          try: () => state.storage.deleteAlarm(),
          catch: failed,
        });
      }),
    );
    const invoke = (
      invocation: typeof FacetInvocation.Type,
      load: () => Promise<typeof FacetBundle.Type>,
      elicitation: ((input: unknown) => Promise<unknown>) | null,
      workflows: ((input: unknown) => Promise<unknown>) | null,
      waited: (ms: number) => void,
      starts: FacetStarts,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* admit(invocation.identity, invocation.concurrent).pipe(
            Effect.withSpan("runtime.app.data.admit"),
          );
          const entrypoint = yield* acquire(invocation, load, starts);
          const observedRevision = yield* revision;
          let cacheChanged = false;
          if (invocation.write)
            yield* Effect.acquireRelease(begin, () => finish.pipe(Effect.catch(() => Effect.void)));
          const run = Effect.gen(function* () {
            const namespace = invocation.cacheNamespace;
            const leases =
              namespace === undefined
                ? undefined
                : yield* holdLeases((command) => store(namespace, command));
            const closeLeases = () =>
              leases === undefined ? Promise.resolve() : Effect.runPromise(leases.close);
            const call = yield* Effect.acquireRelease(
              Effect.sync(() => {
                const id = invocation.id;
                const result = Promise.resolve()
                  .then(() =>
                    entrypoint.invoke(
                      id,
                      invocation.body,
                      invocation.headers,
                      elicitation,
                      workflows,
                      leases === undefined
                        ? null
                        : (command) =>
                            Effect.runPromise(
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
                                Effect.orDie,
                              ),
                            ),
                    ),
                  )
                  .then(Result.succeed, Result.fail);
                return { id, result };
              }),
              ({ id, result }, exit) =>
                Effect.promise(async () => {
                  if (Exit.isFailure(exit) && !invocation.concurrent) {
                    state.facets.abort("data", "App invocation cancelled");
                  }
                  if (Exit.isSuccess(exit) && entrypoint.finish !== undefined) {
                    if (finishing++ === 0)
                      finished = new Promise<void>((resolve) => {
                        settle = resolve;
                      });
                    state.waitUntil(
                      entrypoint
                        .finish(id)
                        .catch(() => undefined)
                        .then(closeLeases)
                        .finally(() => {
                          if (--finishing === 0) settle();
                        }),
                    );
                    return;
                  }
                  await Promise.allSettled([
                    Promise.resolve().then(() => entrypoint.cancel(id)),
                    result,
                  ]);
                  await closeLeases();
                }),
            );
            const from = yield* Clock.currentTimeNanos;
            const result = yield* Effect.promise(() => call.result).pipe(
              Effect.withSpan("runtime.app.data.facet"),
            );
            waited(Number((yield* Clock.currentTimeNanos) - from) / 1_000_000);
            if (Result.isFailure(result)) return yield* failed(result.failure);
            return yield* Schema.decodeUnknownEffect(Schema.Json)(result.success).pipe(
              Effect.mapError(failed),
            );
          });
          const value = yield* run;
          return {
            value,
            revision: observedRevision,
            ...(cacheChanged ? { cacheChanged: true } : {}),
          };
        }),
      );
    return {
      enter,
      cache: (namespace: string, command: unknown) => enter(cache(namespace, command)),
      observedCache: (namespace: string, command: unknown, trace?: string, invocation?: string) =>
        runningIn(trace, invocation).pipe(
          Effect.flatMap(({ supervisor, wokeEarlier, wokeByWake, isolateWoke }) =>
            cache(namespace, command).pipe(
              Effect.map((reply) => ({ reply, supervisor, wokeEarlier, wokeByWake, isolateWoke })),
            ),
          ),
        ),
      wake: (trace?: string, invocation?: string) =>
        runningIn(trace, invocation, true).pipe(
          Effect.map(({ supervisor, isolateWoke }) => ({ supervisor, isolateWoke })),
        ),
      evaluated: (command: unknown, trace?: string) =>
        runningIn(trace).pipe(
          Effect.flatMap(({ supervisor }) =>
            evaluated.command(command).pipe(
              Effect.map((reply): EvaluatedEntry | EvaluatedWritten | EvaluatedChanged =>
                typeof reply === "boolean"
                  ? { kept: reply, supervisor }
                  : reply === null
                    ? { missing: true, supervisor }
                    : { ...reply, supervisor },
              ),
              Effect.orElseSucceed((): EvaluatedEntry => ({ missing: true, supervisor })),
            ),
          ),
        ),
      invoke: (
        input: typeof FacetInvocation.Type,
        load: () => Promise<typeof FacetBundle.Type>,
        elicitation: ((input: unknown) => Promise<unknown>) | null = null,
        workflows: ((input: unknown) => Promise<unknown>) | null = null,
      ) =>
        Effect.suspend(() => {
          const cold = received === 0;
          return enter(
            Effect.scoped(
              Effect.gen(function* () {
                const invocation = yield* Schema.decodeUnknownEffect(
                  Schema.toType(FacetInvocation),
                )(input).pipe(Effect.mapError(failed));
                if (!serves(invocation.app)) {
                  yield* Effect.annotateCurrentSpan("executor.supervisor.refused", "other-app");
                  return yield* failed();
                }
                const handle = {
                  cancel: yield* Deferred.make<void>(),
                  done: yield* Deferred.make<void>(),
                };
                if (calls.has(invocation.id)) return yield* failed();
                yield* Effect.acquireRelease(
                  Effect.sync(() => {
                    calls.set(invocation.id, handle);
                  }),
                  () =>
                    Effect.gen(function* () {
                      calls.delete(invocation.id);
                      yield* Deferred.succeed(handle.done, undefined);
                    }),
                );
                const started = yield* Clock.currentTimeNanos;
                let waitMs = 0;
                const starts: FacetStarts = { facet: false, worker: false, recycled: false };
                const annotate = () =>
                  Effect.annotateCurrentSpan({
                    "executor.supervisor.cold": cold,
                    "executor.supervisor.isolate_cold": cold && firstInIsolate,
                    "executor.facet.cold": starts.facet,
                    "executor.facet.worker_cold": starts.worker,
                    "executor.facet.recycled": starts.recycled,
                    "executor.data.write": invocation.write,
                  });
                const result = yield* Effect.raceFirst(
                  invoke(
                    invocation,
                    load,
                    elicitation,
                    workflows,
                    (ms) => {
                      waitMs += ms;
                    },
                    starts,
                  ),
                  Deferred.await(handle.cancel).pipe(Effect.andThen(Effect.interrupt)),
                ).pipe(Effect.ensuring(Effect.suspend(annotate)));
                const elapsedMs = Number((yield* Clock.currentTimeNanos) - started) / 1_000_000;
                const isolateCold = cold && firstInIsolate;
                const startedParts = [
                  ...(cold ? ["supervisor" as const] : []),
                  ...(isolateCold ? ["supervisor-isolate" as const] : []),
                  ...(starts.facet ? ["facet" as const] : []),
                  ...(starts.worker ? ["facet-worker" as const] : []),
                ];
                return {
                  ...result,
                  timing: {
                    elapsedMs,
                    waitMs,
                    started: startedParts,
                  },
                };
              }),
            ),
          );
        }),
      cancel: (id: string) =>
        enter(
          Effect.gen(function* () {
            const handle = calls.get(id);
            if (handle === undefined) return;
            yield* Deferred.succeed(handle.cancel, undefined);
            yield* Deferred.await(handle.done);
          }),
        ),
      initial: (socket: WebSocket) =>
        enter(
          metadata.withPermits(1)(
            Effect.flatMap(revision, (current) =>
              Effect.try({ try: () => send(socket, current), catch: failed }),
            ),
          ),
        ),
      subscribe: (socket: WebSocket) =>
        enter(
          metadata.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* revision;
              yield* Effect.try({
                try: () => {
                  state.acceptWebSocket(socket);
                  send(socket, current);
                },
                catch: failed,
              });
            }),
          ),
        ),
      recover: enter(recover),
      unload: (identity: string) =>
        enter(
          Effect.gen(function* () {
            if (!unloadReplacedFacets) return false;
            while (finishing > 0) {
              const current = finished;
              yield* Effect.promise(() => current);
            }
            if (admission.running > 0) return false;
            const supervisor = state.id.toString();
            const name = `${supervisor}:${identity}`;
            const loaded = workerName(name);
            const recorded = loadedFacets.get(supervisor)?.loaded === loaded;
            if (active !== loaded && !recorded) return false;
            if (active === loaded) {
              state.facets.abort("data", "Unloaded by the app Worker limit");
              active = undefined;
            }
            if (recorded) loadedFacets.delete(supervisor);
            yield* unloadReplaced({ name, loaded });
            return true;
          }),
        ),
    };
  });

interface SelectedAccount {
  readonly id: string;
}
export const facetIdentity = (
  build: string,
  accounts: Readonly<Record<string, SelectedAccount | ReadonlyArray<SelectedAccount>>>,
) =>
  fingerprint(
    crypto,
    JSON.stringify([
      build,
      Object.entries(accounts)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([slot, selected]) => [
          slot,
          "id" in selected ? selected.id : selected.map((account) => account.id),
        ]),
    ]),
  );
