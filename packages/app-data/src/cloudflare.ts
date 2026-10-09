/** Workerd edge: one supervisor per configured app; code changes preserve the isolated facet database. */
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
import { CacheCommand, CacheError, CacheReply } from "@executor-js/app-cache/contracts";
import { holdLeases } from "@executor-js/app-cache";
import { discardsEvaluated } from "@executor-js/app-cache/changes";
import { sqliteCache } from "@executor-js/app-cache/sqlite";
import { evaluatedStore } from "./implementation/evaluated.ts";
import type {
  EvaluatedEntry,
  EvaluatedSupervisor,
  EvaluatedWritten,
} from "./contracts/evaluated.ts";

/** Executable bytes, supplied by the trusted build store rather than a browser request. */
export const FacetBundle = WorkerBundle;
/** The outer host has already authorized this exact app invocation. No credentials are persisted here. */
export const FacetInvocation = Schema.Struct({
  id: Schema.NonEmptyString,
  /** The app, which binds the facet's outbound network to it. */
  app: Schema.NonEmptyString,
  identity: Schema.NonEmptyString,
  body: Schema.String,
  cacheNamespace: Schema.optionalKey(Schema.String),
  write: Schema.Boolean,
  /**
   * The bundle's calls may run alongside other calls of the same execution context. Bundles built
   * before app SQL hold a transaction for a whole call, so their facet runs one call at a time.
   */
  concurrent: Schema.Boolean,
  headers: Schema.Record(Schema.String, Schema.String),
});
/**
 * The supervisor attaches the revision the invocation observed, whether the invocation
 * invalidated app cache data, and its own part of the invocation on its own clock, queueing
 * included: how long it took and how much of that it waited on the facet.
 */
export const FacetResult = Schema.Struct({
  value: Schema.Json,
  revision: Schema.Int,
  cacheChanged: Schema.optionalKey(Schema.Boolean),
  timing: Schema.optionalKey(Schema.Struct({ elapsedMs: Schema.Finite, waitMs: Schema.Finite })),
});
const causes = new WeakMap<AppDatabaseError, unknown>();
/** Internal diagnostics, deliberately absent from the serialized error. */
export const facetFailureCause = (error: AppDatabaseError): unknown => causes.get(error);
const failed = (cause?: unknown) => {
  const error = new AppDatabaseError({ reason: "storage" });
  causes.set(error, cause);
  return error;
};

/**
 * The name each Worker Loader name currently loads under. The runtime keeps a rejected cold-start
 * callback under its name for the rest of the process and never runs another callback for that
 * name, so a cold start that fails, for instance because its caller was cancelled or the build
 * could not be read, retires the name. Later calls load the same code under a fresh one.
 */
const retired = new Map<string, string>();
// oxlint-disable-next-line executor/no-module-level-mutable-state -- marks this isolate's cold-start failures; it carries no request data
let coldStartToken: string | undefined;
/** Marks this isolate's failed cold starts; authored code cannot produce it. */
const coldStartFailure = () => (coldStartToken ??= `Worker cold start ${crypto.randomUUID()}`);
const describe = (cause: unknown) =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

/**
 * Get a Worker by name, loading its code only on a cold start. A failed load retires the name, so
 * the failure is not kept for later calls. Returns the name actually used.
 */
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
/** The name the next call of this Worker loads under. */
export const workerName = (name: string) => retired.get(name) ?? name;

/** Loaded only if a name being unloaded is not resident, so the unload leaves nothing behind. */
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
/** A Worker whose unload did not settle in time; later calls load its code under a fresh name. */
export const replaceWorker = (name: string) => {
  retired.set(name, `${name}~${crypto.randomUUID()}`);
};
/**
 * Unload an idle named Worker from this process. Resolves true once the runtime has dropped it,
 * so the next call of the name cold-starts, and false when the runtime cannot unload it. The
 * caller must not unload a Worker with calls in flight: the runtime does not stop them.
 */
export const unloadWorker = (loader: Pick<WorkerLoader, "get">, name: string) =>
  unloadLoaded(loader, workerName(name));
const unloadLoaded = async (loader: Pick<WorkerLoader, "get">, loaded: string) => {
  const worker = loader.get(loaded, async () => unloadedWorker);
  const entry = Schema.decodeUnknownSync(Retirable)(worker.getEntrypoint());
  try {
    return (await entry.retire()) !== false;
  } catch {
    // The aborted isolate never answers; its caller sees the abort as an internal error.
    return true;
  }
};
/**
 * Whether a call failed because this isolate's cold start of its Worker failed. No authored code
 * ran, and the name is already retired, so the call can be made again under the fresh name.
 */
export const failedColdStart = (cause: unknown) =>
  coldStartToken !== undefined && describe(cause).includes(coldStartToken);

/** Private per-call cancellation; the facet never receives the supervisor storage or namespace. */
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

/**
 * The facet Worker each data supervisor in this isolate loaded last, by supervisor ID. The runtime
 * evicts an idle supervisor and builds a new one for its next call, but keeps the Workers it
 * loaded, so this record lives in the isolate rather than in the supervisor. It lets a new
 * supervisor unload the facet its evicted predecessor left loaded.
 */
const loadedFacets = new Map<string, { readonly name: string; readonly loaded: string }>();

/** When this isolate built its first supervisor, on its clock; supervisors report their isolate's age. */
// oxlint-disable-next-line executor/no-module-level-mutable-state -- one timestamp per isolate; it carries no request data
let isolateStartedAt: number | undefined;

/** Use supervisor alarms: the pinned workerd cannot schedule alarms from a facet. */
export const makeFacetSupervisor = (
  state: DurableObjectState,
  loader: Pick<WorkerLoader, "get">,
  /**
   * Network the facet's global `fetch` uses, bound to its app. It substitutes credential handles
   * and applies the host's routing rules.
   */
  globalOutbound: (app: string) => Fetcher,
  /**
   * Unload the Worker of a facet replaced for another account selection. A workerd host whose
   * process never unloads named Workers itself sets this; Cloudflare unloads them.
   */
  unloadReplacedFacets = false,
) =>
  Effect.gen(function* () {
    const metadata = yield* Semaphore.make(1);
    const startedAt = yield* Clock.currentTimeMillis;
    const isolateStarted = (isolateStartedAt ??= startedAt);
    /**
     * Calls and events this instance has received, of every kind that can activate it: host RPCs,
     * the socket upgrade, alarms and socket events. The first one woke it.
     */
    let received = 0;
    /** Count `effect` as one call or event the instance received. */
    const enter = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        received += 1;
        return effect;
      });
    /** How this instance is running, for the caller's span. Counts the call it answers. */
    const running = Clock.currentTimeMillis.pipe(
      Effect.map((now): EvaluatedSupervisor => ({
        woke: received++ === 0,
        instanceMs: now - startedAt,
        isolateMs: now - isolateStarted,
      })),
    );
    /**
     * Which calls may run in the facet now. Calls of the loaded execution context run together when
     * their bundle allows it, so a call waiting on an outside service never holds up the app's
     * other calls, including that service's callbacks into the app. A call for another context, or
     * one that needs the facet alone, waits until the running calls finish. Durable Objects share
     * one I/O context, so waiters can be woken through a Deferred.
     */
    /**
     * Calls of the running execution context always join it: a running call may be waiting for
     * one of them, such as a provider's callback during webhook registration, so holding them
     * back could deadlock. The cost is fairness: steady overlapping traffic for one context keeps
     * another waiting until it pauses.
     */
    const admission = { running: 0, identity: "", alone: false };
    let wake = yield* Deferred.make<void>();
    /** Enter now when allowed, or return the signal to wait on. Synchronous, so it cannot interleave. */
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
    /**
     * Wait until the call may run in the facet. Waiting is interruptible, so cancelling a queued
     * call ends it at once; an attempt that enters registers `leave` with the call's scope.
     */
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
    // Every cache command, from the host or from an invocation, passes here, so an invalidation
    // is recorded for evaluated results before any caller can read them again.
    const store = (namespace: string, command: unknown) =>
      cached(namespace, command).pipe(
        Effect.tap(() =>
          discardsEvaluated(command)
            ? Clock.currentTimeMillis.pipe(
                Effect.flatMap(evaluated.changed),
                Effect.mapError(() => new CacheError({ reason: "storage" })),
              )
            : Effect.void,
        ),
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
    /**
     * Unload the Worker of a facet this supervisor replaced. The runtime would otherwise keep it
     * for the life of the process, one per account selection ever used. A call that selects it
     * again waits for the unload and then loads it fresh.
     */
    const unloadReplaced = (replaced: { readonly name: string; readonly loaded: string }) =>
      Effect.promise(() => unloadLoaded(loader, replaced.loaded)).pipe(
        Effect.timeoutOption("10 seconds"),
        Effect.flatMap((settled) =>
          // The runtime may still hold the old Worker; a later call must not reach it.
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
    ) =>
      Effect.gen(function* () {
        const supervisor = state.id.toString();
        const name = `${supervisor}:${invocation.identity}`;
        const loaded = workerName(name);
        // Another execution context, or a retired name after a failed cold start, needs a new facet.
        if (active !== loaded) {
          state.facets.abort("data", "Execution context changed");
          active = loaded;
        }
        if (!unloadReplacedFacets) return yield* select(name, invocation.app, load);
        // Also covers a facet an evicted supervisor left loaded, which `active` never saw.
        const replaced = loadedFacets.get(supervisor);
        loadedFacets.set(supervisor, { name, loaded });
        if (replaced !== undefined && replaced.loaded !== loaded) yield* unloadReplaced(replaced);
        return yield* select(name, invocation.app, load);
      });
    const select = (name: string, app: string, load: () => Promise<typeof FacetBundle.Type>) =>
      Effect.try({
        try: () =>
          // An abort invalidates stubs. Reacquire on every invocation.
          Schema.decodeUnknownSync(FacetEntrypoint)(
            state.facets.get("data", () => {
              const { worker } = loadWorker(loader, name, async () => {
                const bundle = Schema.decodeUnknownSync(Schema.toType(FacetBundle))(await load());
                return {
                  ...bundle,
                  modules: workerModules(bundle.modules),
                  compatibilityDate: "2026-07-30",
                  // The strictly-public flag would override this outbound and bypass it.
                  compatibilityFlags: ["nodejs_compat"],
                  globalOutbound: globalOutbound(app),
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
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* admit(invocation.identity, invocation.concurrent);
          const entrypoint = yield* acquire(invocation, load);
          // Capture the revision before execution so a later write cannot make an old query
          // look current. A write that commits while the query runs only causes a refetch.
          const observedRevision = yield* revision;
          let cacheChanged = false;
          if (invocation.write)
            yield* Effect.acquireRelease(begin, () => finish.pipe(Effect.catch(() => Effect.void)));
          const run = Effect.gen(function* () {
            const namespace = invocation.cacheNamespace;
            // The invocation owns the leases it claims until it finishes, background refreshes included.
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
                    // An older bundle's transaction closes the facet's input gate, so a cancel
                    // RPC cannot enter until it commits. Abort the facet, which runs only this
                    // call, to roll it back. Current bundles never hold a transaction across a
                    // wait, so their cancel below reaches the call without touching others.
                    state.facets.abort("data", "App invocation cancelled");
                  }
                  if (Exit.isSuccess(exit) && entrypoint.finish !== undefined) {
                    state.waitUntil(
                      entrypoint
                        .finish(id)
                        .catch(() => undefined)
                        .then(closeLeases),
                    );
                    return;
                  }
                  // Drain the invocation before the next caller acquires a fresh facet capability.
                  await Promise.allSettled([
                    Promise.resolve().then(() => entrypoint.cancel(id)),
                    result,
                  ]);
                  await closeLeases();
                }),
            );
            // Waiting on the facet, which runs the app, is not the supervisor's own time.
            const from = yield* Clock.currentTimeNanos;
            const result = yield* Effect.promise(() => call.result);
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
      /**
       * Host-evaluated results, with how this supervisor was running when it answered. A command
       * the store could not run is answered as missing, a miss; its writer ignores the answer.
       */
      evaluated: (command: unknown) =>
        running.pipe(
          Effect.flatMap((supervisor) =>
            evaluated.command(command).pipe(
              Effect.map((reply): EvaluatedEntry | EvaluatedWritten =>
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
        enter(
          Effect.scoped(
            Effect.gen(function* () {
              const invocation = yield* Schema.decodeUnknownEffect(Schema.toType(FacetInvocation))(
                input,
              ).pipe(Effect.mapError(failed));
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
              const result = yield* Effect.raceFirst(
                invoke(invocation, load, elicitation, workflows, (ms) => {
                  waitMs += ms;
                }),
                Deferred.await(handle.cancel).pipe(Effect.andThen(Effect.interrupt)),
              );
              const elapsedMs = Number((yield* Clock.currentTimeNanos) - started) / 1_000_000;
              return { ...result, timing: { elapsedMs, waitMs } };
            }),
          ),
        ),
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
    };
  });

/** A saved account as selected for one slot; only its stable identifier names a runtime. */
interface SelectedAccount {
  readonly id: string;
}
/**
 * A deployment and its account selection define one warm execution context. Credential values
 * and workflow runs are delivered with each invocation: a renewed token or another run must not
 * load another Worker, which the runtime would keep for its lifetime.
 */
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
