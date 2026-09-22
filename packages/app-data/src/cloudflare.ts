/** Workerd edge: one supervisor per configured app; code changes preserve the isolated facet database. */
import { WorkerBundle, workerModules } from "./contracts/worker-bundle.ts";
import type {
  DurableObjectState,
  Fetcher,
  WorkerLoader,
  WebSocket,
} from "@cloudflare/workers-types";
import { Clock, Deferred, Effect, Exit, Result, Schema, Semaphore } from "effect";
import { fingerprint } from "./implementation/cursor.ts";
import { AppDatabaseError } from "./contracts/database.ts";

/** Executable bytes, supplied by the trusted build store rather than a browser request. */
export const FacetBundle = WorkerBundle;
/** The outer host has already authorized this exact app invocation. No credentials are persisted here. */
export const FacetInvocation = Schema.Struct({
  id: Schema.NonEmptyString,
  identity: Schema.NonEmptyString,
  body: Schema.String,
  write: Schema.Boolean,
  headers: Schema.Record(Schema.String, Schema.String),
});
/** The supervisor attaches the revision before releasing its serialized invocation. */
export const FacetResult = Schema.Struct({ value: Schema.Json, revision: Schema.Int });
const causes = new WeakMap<AppDatabaseError, unknown>();
/** Internal diagnostics, deliberately absent from the serialized error. */
export const facetFailureCause = (error: AppDatabaseError): unknown => causes.get(error);
const failed = (cause?: unknown) => {
  const error = new AppDatabaseError({ reason: "storage" });
  causes.set(error, cause);
  return error;
};

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
    ) => Promise<unknown>;
    cancel: (id: string) => Promise<void>;
  } =>
    typeof value === "object" &&
    value !== null &&
    "invoke" in value &&
    typeof value.invoke === "function" &&
    "cancel" in value &&
    typeof value.cancel === "function",
);

/** Use supervisor alarms: the pinned workerd cannot schedule alarms from a facet. */
export const makeFacetSupervisor = (
  state: DurableObjectState,
  loader: Pick<WorkerLoader, "get">,
  /**
   * Network the facet's global `fetch` uses. Cloudflare has no private network to reach, so it
   * passes nothing and relies on the compatibility flag. A local workerd host passes a
   * public-only network service, which the flag cannot express there.
   */
  globalOutbound?: Fetcher,
) =>
  Effect.gen(function* () {
    const execution = yield* Semaphore.make(1);
    const metadata = yield* Semaphore.make(1);
    let activeIdentity: string | undefined;
    let writes = 0;
    const calls = new Map<
      string,
      { cancel: Deferred.Deferred<void>; done: Deferred.Deferred<void> }
    >();
    const acquire = (
      invocation: typeof FacetInvocation.Type,
      load: () => Promise<typeof FacetBundle.Type>,
    ) =>
      Effect.try({
        try: () => {
          if (activeIdentity !== invocation.identity) {
            state.facets.abort("data", "Execution context changed");
            activeIdentity = invocation.identity;
          }
          // An abort invalidates stubs. Reacquire on every serialized invocation.
          return Schema.decodeUnknownSync(FacetEntrypoint)(
            state.facets.get("data", () => {
              const worker = loader.get(
                `${state.id.toString()}:${invocation.identity}`,
                async () => {
                  const bundle = Schema.decodeUnknownSync(Schema.toType(FacetBundle))(await load());
                  return {
                    ...bundle,
                    modules: workerModules(bundle.modules),
                    compatibilityDate: "2026-07-30",
                    ...(globalOutbound === undefined
                      ? // Same-zone URLs must use their public Worker routes, not the underlying origin.
                        { compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"] }
                      : // The flag would override this outbound and send fetch to the shared network.
                        { compatibilityFlags: ["nodejs_compat"], globalOutbound }),
                  };
                },
              );
              return { class: worker.getDurableObjectClass("ExecutorAppData") };
            }),
          );
        },
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
      Effect.tryPromise({ try: () => state.storage.setAlarm(now + 1_000), catch: failed }),
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
        yield* Effect.tryPromise({ try: () => state.storage.put("pending", true), catch: failed });
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
          yield* Effect.tryPromise({ try: () => state.storage.deleteAlarm(), catch: failed });
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
        yield* Effect.tryPromise({ try: () => state.storage.deleteAlarm(), catch: failed });
      }),
    );
    const invoke = (
      invocation: typeof FacetInvocation.Type,
      load: () => Promise<typeof FacetBundle.Type>,
      elicitation: ((input: unknown) => Promise<unknown>) | null,
      workflows: ((input: unknown) => Promise<unknown>) | null,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const entrypoint = yield* acquire(invocation, load);
          // Reads share the invocation lock with writes. Capture the revision before
          // execution so a later write cannot make an old query look current.
          const observedRevision = yield* revision;
          if (invocation.write)
            yield* Effect.acquireRelease(begin, () => finish.pipe(Effect.catch(() => Effect.void)));
          const run = Effect.gen(function* () {
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
                    ),
                  )
                  .then(Result.succeed, Result.fail);
                return { id, result };
              }),
              ({ id, result }, exit) =>
                Effect.promise(async () => {
                  if (Exit.isFailure(exit)) {
                    // A facet transaction closes its input gate, so a cancel RPC cannot
                    // enter until it commits. Abort the isolated facet to roll it back.
                    state.facets.abort("data", "App invocation cancelled");
                  }
                  // Drain the invocation before the next caller acquires a fresh facet capability.
                  await Promise.allSettled([
                    Promise.resolve().then(() => entrypoint.cancel(id)),
                    result,
                  ]);
                }),
            );
            const result = yield* Effect.promise(() => call.result);
            if (Result.isFailure(result)) return yield* failed(result.failure);
            return yield* Schema.decodeUnknownEffect(Schema.Json)(result.success).pipe(
              Effect.mapError(failed),
            );
          });
          return { value: yield* run, revision: observedRevision };
        }),
      ).pipe(
        // Storage operations already serialize inside the facet. Queue here so aborting
        // one invocation never kills another caller or leaves a stale facet capability.
        execution.withPermits(1),
      );
    return {
      invoke: (
        input: typeof FacetInvocation.Type,
        load: () => Promise<typeof FacetBundle.Type>,
        elicitation: ((input: unknown) => Promise<unknown>) | null = null,
        workflows: ((input: unknown) => Promise<unknown>) | null = null,
      ) =>
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
            return yield* Effect.raceFirst(
              invoke(invocation, load, elicitation, workflows),
              Deferred.await(handle.cancel).pipe(Effect.andThen(Effect.interrupt)),
            );
          }),
        ),
      cancel: (id: string) =>
        Effect.gen(function* () {
          const handle = calls.get(id);
          if (handle === undefined) return;
          yield* Deferred.succeed(handle.cancel, undefined);
          yield* Deferred.await(handle.done);
        }),
      initial: (socket: WebSocket) =>
        metadata.withPermits(1)(
          Effect.flatMap(revision, (current) =>
            Effect.try({ try: () => send(socket, current), catch: failed }),
          ),
        ),
      subscribe: (socket: WebSocket) =>
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
      recover,
    };
  });

/** A deployment and the host-serialized account bindings define one warm execution context. */
export const facetIdentity = (build: string, accounts: string) =>
  fingerprint(crypto, JSON.stringify([build, accounts]));
