import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { acknowledge, acknowledgedQuery, currentQuery } from "../src/contracts/mutations.ts";

test("confirmed query updates survive a held read and its failure, then accept external changes", () => {
  const source = Atom.make<AsyncResult.AsyncResult<{ a: string; b: string }, string>>(
    AsyncResult.success({ a: "old", b: "old" }),
  );
  const query = acknowledgedQuery(source);
  const registry = AtomRegistry.make();
  const unmount = registry.mount(query);
  try {
    registry.set(query, (current) => ({ ...current, a: "saved" }));
    registry.set(source, AsyncResult.success({ a: "old", b: "old" }, { waiting: true }));
    assert.deepEqual(Option.getOrThrow(AsyncResult.value(registry.get(query))), {
      a: "saved",
      b: "old",
    });
    registry.set(query, (current) => ({ ...current, b: "second" }));
    registry.set(source, AsyncResult.fail("read failed"));
    const failed = registry.get(query);
    assert.ok(AsyncResult.isFailure(failed));
    assert.deepEqual(Option.getOrThrow(AsyncResult.value(failed)), { a: "saved", b: "second" });
    registry.set(source, AsyncResult.success({ a: "external", b: "external" }));
    assert.deepEqual(Option.getOrThrow(AsyncResult.value(registry.get(query))), {
      a: "external",
      b: "external",
    });
  } finally {
    unmount();
    registry.dispose();
  }
});

test("synchronous acknowledgement is visible before completion while the authoritative read is pending", async () => {
  let value = "old";
  let resolve: ((value: string) => void) | undefined;
  const source = Atom.make(
    Effect.promise(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    ),
  );
  const query = acknowledgedQuery(source);
  const write = Atom.fn((_: void, get) => Effect.sync(() => acknowledge(get, query, () => value)));
  const registry = AtomRegistry.make();
  const unmount = registry.mount(query);
  try {
    resolve?.("old");
    await new Promise((done) => setTimeout(done, 0));
    value = "saved";
    registry.set(write, undefined);
    assert.ok(AsyncResult.isSuccess(registry.get(write)));
    assert.equal(Option.getOrThrow(AsyncResult.value(registry.get(query))), "saved");
    assert.equal(registry.get(query).waiting, true);
    resolve?.("external");
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(Option.getOrThrow(AsyncResult.value(registry.get(query))), "external");
  } finally {
    unmount();
    registry.dispose();
  }
});

test("strict derived queries never expose stale tools or authority during refresh", () => {
  const source = Atom.make<AsyncResult.AsyncResult<string, string>>(AsyncResult.success("old"));
  const query = currentQuery(source);
  const registry = AtomRegistry.make();
  try {
    assert.equal(Option.getOrThrow(AsyncResult.value(registry.get(query))), "old");
    registry.set(source, AsyncResult.success("old", { waiting: true }));
    assert.ok(AsyncResult.isInitial(registry.get(query)));
    registry.set(
      source,
      AsyncResult.failWithPrevious("failed", { previous: Option.some(AsyncResult.success("old")) }),
    );
    assert.ok(Option.isNone(AsyncResult.value(registry.get(query))));
  } finally {
    registry.dispose();
  }
});
