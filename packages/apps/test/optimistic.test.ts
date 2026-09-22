/** Controlled transport checks for the production client's write/read boundary. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Deferred, Effect, Layer, ManagedRuntime, Option } from "effect";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { number } from "../src/index.ts";
import type { OperationReference } from "../src/client.ts";
import { makeOptimisticClient } from "../src/implementation/optimistic.ts";

const query: OperationReference<{ filter: string }, number, "query"> = {
  name: "count",
  kind: "query",
};
const write: OperationReference<{ amount: number }, number, "mutation"> = {
  name: "increment",
  kind: "mutation",
};
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "Expected state was not reached");
    await setImmediate();
  }
};
const fixture = () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const registry = AtomRegistry.make({ defaultIdleTTL: 0 });
  const writes: Deferred.Deferred<unknown, unknown>[] = [];
  const reads: Deferred.Deferred<unknown, unknown>[] = [];
  const errors: unknown[] = [];
  const updates = new Set<(value: number) => void>();
  let server = 0;
  let opened = 0;
  let holdSources = false;
  const client = makeOptimisticClient({
    source: () =>
      Atom.readable((get) => {
        opened++;
        const update = (value: number) => get.setSelf(AsyncResult.success(value));
        updates.add(update);
        get.addFinalizer(() => updates.delete(update));
        return holdSources ? AsyncResult.initial<number>() : AsyncResult.success(server);
      }),
    read: () =>
      Effect.suspend(() => {
        const result = Deferred.makeUnsafe<unknown, unknown>();
        reads.push(result);
        return Deferred.await(result);
      }),
    write: () =>
      Effect.suspend(() => {
        const result = Deferred.makeUnsafe<unknown, unknown>();
        writes.push(result);
        return Deferred.await(result);
      }),
    fork: (effect) => {
      runtime.runFork(effect);
    },
    run: (effect) => runtime.runPromise(effect),
    reportProjectionError: (error) => errors.push(error),
  });
  const mount = (filter = "all", owner = registry) => {
    const atom = client.queryAtom(query, { filter }, number());
    const values: (number | undefined)[] = [];
    const release = owner.subscribe(
      atom,
      (value) => values.push(Option.getOrUndefined(AsyncResult.value(value))),
      { immediate: true },
    );
    return {
      value: () => Option.getOrUndefined(AsyncResult.value(owner.get(atom))),
      snapshot: () => owner.get(atom),
      release,
      values,
    };
  };
  const increment = client.mutation(write, number()).withOptimisticUpdate((store, input) => {
    for (const { input: args, value } of store.getAllQueries(query)) {
      if (value !== undefined) store.setQuery(query, args, value + input.amount);
    }
  });
  const complete = (items: Deferred.Deferred<unknown, unknown>[], index: number, value: number) => {
    const item = items[index];
    assert.ok(item);
    server = value;
    Deferred.doneUnsafe(item, Effect.succeed(value));
  };
  return {
    client,
    mount,
    increment,
    writes,
    reads,
    errors,
    updates,
    opened: () => opened,
    holdSources: () => {
      holdSources = true;
    },
    complete,
    close: async () => {
      client.dispose();
      registry.dispose();
      await runtime.dispose();
    },
  };
};

test("updates all mounted variants immediately and retires only the acknowledged overlay after a fresh read", async () => {
  const f = fixture();
  try {
    const a = f.mount();
    const b = f.mount("filtered");
    assert.equal(a.value(), 0);
    assert.equal(b.value(), 0);
    const one = f.increment({ amount: 1 });
    const two = f.increment({ amount: 2 });
    assert.equal(a.value(), 3);
    assert.equal(b.value(), 3);
    await until(() => f.writes.length === 1);
    f.complete(f.writes, 0, 1);
    assert.equal(await one, 1);
    await until(() => f.reads.length === 2);
    assert.equal(f.writes.length, 1);
    assert.equal(a.value(), 3);
    f.complete(f.reads, 0, 1);
    f.complete(f.reads, 1, 1);
    await until(() => f.writes.length === 2);
    assert.equal(a.value(), 3);
    assert.equal(b.value(), 3);
    f.complete(f.writes, 1, 3);
    assert.equal(await two, 3);
    await until(() => f.reads.length === 4);
    f.complete(f.reads, 2, 3);
    f.complete(f.reads, 3, 3);
    await until(() => f.updates.size === 2);
    assert.deepEqual([...new Set(a.values.slice(a.values.indexOf(3)))], [3]);
    assert.equal(a.value(), 3); // No double increment after server confirmation.
    for (const update of f.updates) update(10);
    assert.equal(a.value(), 10); // A later external write remains authoritative.
  } finally {
    await f.close();
  }
});

test("a failed write rolls back only itself while the next invocation remains projected", async () => {
  const f = fixture();
  try {
    const view = f.mount();
    const first = assert.rejects(f.increment({ amount: 1 }), /rejected/);
    const next = f.increment({ amount: 2 });
    assert.equal(view.value(), 3);
    await until(() => f.writes.length === 1);
    const failed = f.writes[0];
    assert.ok(failed);
    Deferred.doneUnsafe(failed, Effect.fail(new Error("rejected")));
    await first;
    assert.equal(view.value(), 2);
    await until(() => f.reads.length === 1);
    f.complete(f.reads, 0, 0);
    await until(() => f.writes.length === 2);
    assert.equal(view.value(), 2);
    f.complete(f.writes, 1, 2);
    await next;
    await until(() => f.reads.length === 2);
    f.complete(f.reads, 1, 2);
    await until(() => f.updates.size === 1);
    assert.equal(view.value(), 2);
  } finally {
    await f.close();
  }
});

test("a reconciliation failure is a query error, not a failed or repeated write, and does not block the queue", async () => {
  const f = fixture();
  try {
    const view = f.mount();
    const one = f.increment({ amount: 1 });
    await until(() => f.writes.length === 1);
    f.complete(f.writes, 0, 1);
    assert.equal(await one, 1);
    await until(() => f.reads.length === 1);
    const read = f.reads[0];
    assert.ok(read);
    // Hold the restarted source too, to observe the query failure before recovery.
    f.holdSources();
    const failures: boolean[] = [];
    const owner = AtomRegistry.make({ defaultIdleTTL: 0 });
    const atom = f.client.queryAtom(query, { filter: "all" }, number());
    owner.subscribe(atom, (snapshot) => failures.push(AsyncResult.isFailure(snapshot)), {
      immediate: true,
    });
    Deferred.doneUnsafe(read, Effect.fail(new Error("read unavailable")));
    await until(() => failures.includes(true));
    owner.dispose();
    const two = f.increment({ amount: 2 });
    await until(() => f.writes.length === 2);
    f.complete(f.writes, 1, 3);
    assert.equal(await two, 3);
    await until(() => f.reads.length === 2);
    f.complete(f.reads, 1, 3);
    await until(() => f.updates.size === 1);
    assert.equal(f.writes.length, 2);
    assert.equal(view.value(), 3);
  } finally {
    await f.close();
  }
});

test("shared mounts own one subscription, new queries join the handoff, and disposal rejects queued callers", async () => {
  const f = fixture();
  const other = AtomRegistry.make({ defaultIdleTTL: 0 });
  try {
    const first = f.mount();
    const second = f.mount("all", other);
    assert.equal(f.opened(), 1);
    first.release();
    assert.equal(f.updates.size, 1);
    const result = f.increment({ amount: 1 });
    await until(() => f.writes.length === 1);
    const fresh = f.mount("new");
    assert.equal(fresh.value(), undefined);
    f.complete(f.writes, 0, 1);
    await result;
    await until(() => f.reads.length === 2);
    f.complete(f.reads, 0, 1);
    f.complete(f.reads, 1, 1);
    await until(() => fresh.value() === 1);
    assert.equal(second.value(), 1);
    assert.equal(fresh.value(), 1);
    const active = assert.rejects(f.increment({ amount: 1 }), /disposed/);
    const queued = assert.rejects(f.increment({ amount: 1 }), /disposed/);
    f.client.dispose();
    await active;
    await queued;
    await assert.rejects(f.increment({ amount: 1 }), /disposed/);
  } finally {
    other.dispose();
    await f.close();
  }
});

test("invalid projections never send writes or contaminate the authoritative cache", async () => {
  const f = fixture();
  try {
    const view = f.mount();
    const bad = f.client.mutation(write, number()).withOptimisticUpdate((store) => {
      store.setQuery(query, { filter: "all" }, 50);
      throw new Error("invalid projection");
    });
    await assert.rejects(bad({ amount: 1 }), /invalid projection/);
    assert.equal(f.writes.length, 0);
    assert.equal(view.value(), 0);
    const args = { amount: 1 };
    const result = f.increment(args);
    args.amount = 100;
    const extra = f.mount("extra");
    assert.equal(extra.value(), undefined);
    assert.equal(view.value(), 1);
    await until(() => f.writes.length === 1);
    f.complete(f.writes, 0, 1);
    await result;
    await until(() => f.reads.length === 2);
    f.complete(f.reads, 0, 1);
    f.complete(f.reads, 1, 1);
  } finally {
    await f.close();
  }
});

test("unmounting a held reconciliation query releases the write queue", async () => {
  const f = fixture();
  try {
    const view = f.mount();
    const one = f.increment({ amount: 1 });
    const two = f.increment({ amount: 2 });
    await until(() => f.writes.length === 1);
    f.complete(f.writes, 0, 1);
    await one;
    await until(() => f.reads.length === 1);
    view.release();
    await until(() => f.writes.length === 2);
    f.complete(f.writes, 1, 3);
    assert.equal(await two, 3);
  } finally {
    await f.close();
  }
});
