/** One client's mounted queries and ordered optimistic write/read handoffs. */
import { Cause, Deferred, Effect, Exit, Option, Schema as EffectSchema, Semaphore } from "effect";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import type {
  AppMutation,
  OptimisticLocalStore,
  OptimisticUpdate,
} from "../contracts/optimistic.ts";
import type { OperationReference } from "../contracts/live.ts";
import { JsonValue } from "../contracts/schema.ts";
import type { Schema } from "./schema.ts";

type Snapshot = AsyncResult.AsyncResult<unknown, unknown>;
interface Entry {
  readonly name: string;
  readonly input: JsonValue;
  readonly schema: Schema<unknown, boolean>;
  readonly visible: Atom.Writable<Snapshot>;
  readonly released: Deferred.Deferred<void>;
  base: Snapshot;
  staged: Snapshot | undefined;
  stop: (() => void) | undefined;
  generation: number;
  subscribers: number;
}
interface Pending {
  readonly operationId: string;
  readonly name: string;
  readonly project: (store: OptimisticLocalStore) => void;
  readonly result: Deferred.Deferred<unknown, unknown>;
  sent: boolean;
  invalid: boolean;
}
/** Transport and fiber ownership remain with the browser client's runtime. */
export interface OptimisticTransport {
  readonly source: (
    name: string,
    input: JsonValue,
    output: Schema<unknown, boolean>,
  ) => Atom.Atom<Snapshot>;
  readonly read: (
    name: string,
    input: JsonValue,
    output: Schema<unknown, boolean>,
  ) => Effect.Effect<unknown, unknown>;
  readonly write: (
    name: string,
    input: JsonValue,
    output: Schema<unknown, boolean>,
  ) => Effect.Effect<unknown, unknown>;
  readonly fork: (effect: Effect.Effect<void>) => void;
  readonly run: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  readonly reportProjectionError: (details: {
    readonly operationId: string;
    readonly name: string;
    readonly sent: boolean;
  }) => void;
}

const canonical = (value: JsonValue): JsonValue =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const keyOf = (name: string, input: JsonValue) => JSON.stringify([name, canonical(input)]);
const json = EffectSchema.decodeUnknownSync(JsonValue);

/** Owns cache entries and projections. Dispose before closing the transport runtime. */
export const makeOptimisticClient = (transport: OptimisticTransport) => {
  const registry = AtomRegistry.make({ defaultIdleTTL: 0 });
  const entries = new Map<string, Entry>();
  const pending = new Set<Pending>();
  const callers = new Set<Deferred.Deferred<unknown, unknown>>();
  const lock = Semaphore.makeUnsafe(1);
  let disposed = false;
  let idle = true;

  const project = () => {
    let values = new Map(
      [...entries].map(([key, entry]) => [
        key,
        Option.getOrUndefined(AsyncResult.value(entry.base)),
      ]),
    );
    const changed = new Set<string>();
    for (const update of pending) {
      const next = new Map(values);
      const touched = new Set<string>();
      const store: OptimisticLocalStore = {
        getQuery: <Input, Output>(
          reference: OperationReference<Input, Output, "query">,
          input: NoInfer<Input>,
        ) => {
          // SAFETY: operation references bind the registered input/output types. Clone so author code cannot alter the base.
          return structuredClone(next.get(keyOf(reference.name, json(input)))) as
            | Output
            | undefined;
        },
        getAllQueries: <Input, Output>(reference: OperationReference<Input, Output, "query">) =>
          [...entries]
            .filter(([, entry]) => entry.name === reference.name)
            .map(([key, entry]) => ({
              // SAFETY: input is validated JSON; the referenced operation and each query decoder bind these types.
              input: structuredClone(entry.input) as Input,
              value: structuredClone(next.get(key)) as Output | undefined,
            })),
        setQuery: (reference, input, value) => {
          const key = keyOf(reference.name, json(input));
          const entry = entries.get(key);
          if (entry !== undefined) {
            next.set(key, structuredClone(entry.schema.parse(value)));
            touched.add(key);
          }
        },
      };
      try {
        const result: unknown = update.project(store);
        if (result !== undefined)
          throw new Error("Optimistic updates must be synchronous and return nothing.");
        values = next;
        for (const key of touched) changed.add(key);
      } catch (error) {
        // Discard this entire projection, not other invocations or a captured cache snapshot.
        update.invalid = true;
        pending.delete(update);
        if (!update.sent) Deferred.doneUnsafe(update.result, Effect.fail(error));
        transport.reportProjectionError({
          operationId: update.operationId,
          name: update.name,
          sent: update.sent,
        });
      }
    }
    Atom.batch(() => {
      for (const [key, entry] of entries) {
        registry.set(
          entry.visible,
          changed.has(key)
            ? AsyncResult.isInitial(entry.base)
              ? AsyncResult.success(values.get(key))
              : AsyncResult.map(entry.base, () => values.get(key))
            : entry.base,
        );
      }
    });
  };
  const stop = (entry: Entry) => {
    entry.generation++;
    entry.stop?.();
    entry.stop = undefined;
  };
  const start = (entry: Entry) => {
    stop(entry);
    const generation = entry.generation;
    entry.stop = registry.subscribe(
      transport.source(entry.name, entry.input, entry.schema),
      (snapshot) => {
        if (disposed || generation !== entry.generation || !idle || AsyncResult.isInitial(snapshot))
          return;
        entry.base = snapshot;
        project();
      },
      { immediate: true },
    );
  };
  const reconcile = Effect.gen(function* () {
    for (const entry of entries.values()) entry.staged = undefined;
    // Include queries mounted while the write or earlier reads were pending.
    while (!disposed) {
      const unread = [...entries.values()].filter((entry) => entry.staged === undefined);
      if (unread.length === 0) break;
      yield* Effect.forEach(
        unread,
        (entry) =>
          Effect.gen(function* () {
            yield* Effect.raceFirst(
              Effect.gen(function* () {
                const exit = yield* Effect.exit(
                  transport
                    .read(entry.name, entry.input, entry.schema)
                    .pipe(Effect.timeout("30 seconds")),
                );
                entry.staged = Exit.isSuccess(exit)
                  ? AsyncResult.success(exit.value)
                  : AsyncResult.failureWithPrevious(exit.cause, {
                      previous: Option.some(entry.base),
                    });
              }),
              Deferred.await(entry.released),
            );
          }),
        { concurrency: "unbounded", discard: true },
      );
    }
    for (const entry of entries.values()) {
      if (entry.staged !== undefined) entry.base = entry.staged;
      entry.staged = undefined;
    }
  });
  const mutation = <Input, Output>(
    reference: OperationReference<Input, Output, "mutation">,
    output: Schema<NoInfer<Output>, boolean>,
    update?: OptimisticUpdate<Input>,
  ): AppMutation<Input, Output> => {
    const invoke = (input: Input): Promise<Output> => {
      if (disposed) return Promise.reject(new Error("App client is disposed."));
      let parsed: JsonValue;
      let args: Input;
      try {
        parsed = structuredClone(json(input));
        args = structuredClone(input);
      } catch (error) {
        return Promise.reject(error);
      }
      const result = Deferred.makeUnsafe<unknown, unknown>();
      const item: Pending = {
        operationId: crypto.randomUUID(),
        name: reference.name,
        project: (store) => update?.(store, structuredClone(args)),
        result,
        sent: false,
        invalid: false,
      };
      callers.add(result);
      pending.add(item);
      project();
      transport.fork(
        lock
          .withPermits(1)(
            Effect.gen(function* () {
              if (disposed || item.invalid) return;
              idle = false;
              for (const entry of entries.values()) stop(entry);
              item.sent = true;
              const exit = yield* Effect.exit(
                transport
                  .write(reference.name, parsed, output)
                  .pipe(Effect.annotateSpans("executor.operation.id", item.operationId)),
              );
              Deferred.doneUnsafe(result, exit);
              callers.delete(result);
              if (Exit.isFailure(exit)) {
                pending.delete(item);
                project();
              }
              yield* reconcile;
              pending.delete(item);
              idle = true;
              project();
              for (const entry of entries.values()) start(entry);
            }),
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                callers.delete(result);
                pending.delete(item);
              }),
            ),
            Effect.ignore,
          ),
      );
      return transport.run(Deferred.await(result)).then((value) => output.parse(value));
    };
    return Object.assign(invoke, {
      withOptimisticUpdate: (project: OptimisticUpdate<Input>) =>
        mutation(reference, output, project),
    });
  };
  return {
    mutation: <Input, Output>(
      reference: OperationReference<Input, Output, "mutation">,
      output: Schema<NoInfer<Output>, boolean>,
    ) => mutation(reference, output),
    /** Shares state across mounts; the last subscriber releases the stream and cache entry. */
    queryAtom: <Input, Output>(
      reference: OperationReference<Input, Output, "query">,
      input: NoInfer<Input>,
      output: Schema<NoInfer<Output>, boolean>,
    ) => {
      const parsed = structuredClone(json(input));
      const key = keyOf(reference.name, parsed);
      return Atom.readable<AsyncResult.AsyncResult<Output, unknown>>((get) => {
        if (disposed) return AsyncResult.failure(Cause.fail(new Error("App client is disposed.")));
        let entry = entries.get(key);
        if (entry === undefined) {
          entry = {
            name: reference.name,
            input: parsed,
            schema: output,
            visible: Atom.make<Snapshot>(AsyncResult.initial()),
            base: AsyncResult.initial(),
            staged: undefined,
            stop: undefined,
            generation: 0,
            subscribers: 0,
            released: Deferred.makeUnsafe<void>(),
          };
          entries.set(key, entry);
          if (idle) start(entry);
          project();
        }
        const retained = entry;
        retained.subscribers++;
        const typed = (snapshot: Snapshot) => {
          // SAFETY: the operation's decoder validates server results and every optimistic replacement.
          return snapshot as AsyncResult.AsyncResult<Output, unknown>;
        };
        const release = registry.subscribe(retained.visible, (snapshot) =>
          get.setSelf(typed(snapshot)),
        );
        get.addFinalizer(() => {
          release();
          retained.subscribers--;
          if (retained.subscribers === 0) {
            stop(retained);
            entries.delete(key);
            Deferred.doneUnsafe(retained.released, Effect.void);
          }
        });
        return typed(registry.get(retained.visible));
      }).pipe(Atom.setIdleTTL(0));
    },
    /** Cancel callers and close streams; the transport owner then interrupts its fibers. */
    dispose: () => {
      disposed = true;
      for (const entry of entries.values()) stop(entry);
      for (const result of callers)
        Deferred.doneUnsafe(result, Effect.fail(new Error("App client is disposed.")));
      entries.clear();
      pending.clear();
      callers.clear();
      registry.dispose();
    },
  };
};
