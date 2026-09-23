import { Context, Effect, Stream } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import type { QuerySnapshot, ReactiveStore, StoreChange } from "../contracts/store.ts";

// Sets are invocation-owned and shared only with structured child fibers.
const Reads = Context.Reference<ReadonlyMap<symbol, Set<string>>>("executor/reactivity/Reads", {
  defaultValue: () => new Map(),
});
const Writes = Context.Reference<ReadonlyMap<symbol, Set<string>>>("executor/reactivity/Writes", {
  defaultValue: () => new Map(),
});

/**
 * Make one local subscription coordinator. It owns no database or transport.
 * SQL adapters wrap their reads/writes and transaction boundaries with it.
 */
export const makeReactiveStore = (options: {
  readonly namespace: string;
}): Effect.Effect<ReactiveStore> =>
  Effect.gen(function* () {
    const reactivity = yield* Reactivity.make;
    const identity = Symbol(options.namespace);
    const wakeKey = "commit";
    let revision = 0;
    const tableRevisions = new Map<string, number>();

    const publish = (tables: ReadonlySet<string>) =>
      Effect.sync(() => {
        if (tables.size === 0) return;
        revision += 1;
        for (const table of tables) tableRevisions.set(table, revision);
        reactivity.invalidateUnsafe([wakeKey]);
      });

    const read: ReactiveStore["read"] = (tables, effect) =>
      Effect.flatMap(Reads, (tracking) => {
        const collected = tracking.get(identity);
        if (collected !== undefined) for (const table of tables) collected.add(table);
        return effect;
      });

    const write: ReactiveStore["write"] = (tables, effect) =>
      Effect.uninterruptible(
        Effect.tap(effect, () =>
          Effect.flatMap(Writes, (tracking) => {
            const collected = tracking.get(identity);
            if (collected === undefined) return publish(new Set(tables));
            for (const table of tables) collected.add(table);
            return Effect.void;
          }),
        ),
      );

    const transaction: ReactiveStore["transaction"] = (effect) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const parent = yield* Writes;
          const collected = new Set<string>();
          const result = yield* Effect.provideService(
            effect,
            Writes,
            new Map(parent).set(identity, collected),
          );
          const enclosing = parent.get(identity);
          if (enclosing === undefined) yield* publish(collected);
          else for (const table of collected) enclosing.add(table);
          return result;
        }),
      );

    const evaluate: ReactiveStore["evaluate"] = (effect) =>
      Effect.gen(function* () {
        while (true) {
          const before = revision;
          const collected = new Set<string>();
          const parent = yield* Reads;
          const value = yield* Effect.provideService(
            effect,
            Reads,
            new Map(parent).set(identity, collected),
          );
          if ([...collected].some((table) => (tableRevisions.get(table) ?? 0) > before)) continue;
          const enclosing = parent.get(identity);
          if (enclosing !== undefined) for (const table of collected) enclosing.add(table);
          return { revision, value, tables: [...collected] };
        }
      });

    const subscribe: ReactiveStore["subscribe"] = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Stream.unwrap(
        Effect.sync(() => {
          let dependencies: ReadonlySet<string> | undefined;
          let observedRevision = -1;
          const refresh: Effect.Effect<ReadonlyArray<QuerySnapshot<A>>, E, R> = Effect.gen(
            function* () {
              if (
                dependencies !== undefined &&
                ![...dependencies].some(
                  (table) => (tableRevisions.get(table) ?? 0) > observedRevision,
                )
              ) {
                return [];
              }
              // Registration precedes the first run (Effect Reactivity). Reads that
              // race commits are retried with a new dependency set, including when
              // a conditional query starts reading a previously unrelated table.
              const result = yield* evaluate(effect);
              dependencies = new Set(result.tables);
              observedRevision = result.revision;
              return [{ revision: result.revision, value: result.value }];
            },
          );
          return reactivity
            .stream([wakeKey], refresh)
            .pipe(
              Stream.flatMap(Stream.fromIterable),
              Stream.buffer({ capacity: 1, strategy: "sliding" }),
            );
        }),
      );

    return {
      namespace: options.namespace,
      inTransaction: Effect.map(Writes, (tracking) => tracking.has(identity)),
      read,
      write,
      transaction,
      subscribe,
      evaluate,
      changes: Stream.unwrap(
        Effect.sync(() => {
          let previousRevision = 0;
          return reactivity.stream(
            [wakeKey],
            Effect.sync((): StoreChange => {
              const tables = [...tableRevisions]
                .filter(([, at]) => at > previousRevision)
                .map(([table]) => table);
              previousRevision = revision;
              return { namespace: options.namespace, revision, tables };
            }),
          );
        }),
      ),
    };
  });
