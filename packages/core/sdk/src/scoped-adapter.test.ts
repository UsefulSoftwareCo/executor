import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";

import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";
import { StorageError, typedAdapter } from "@executor-js/storage-core";

import { defineSchema, type StorageDeps } from "./plugin";
import { scopedTypedAdapter, scopeAdapter } from "./scoped-adapter";

const schema = defineSchema({
  thing: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      value: { type: "string", required: true },
    },
  },
  shared: {
    fields: {
      id: { type: "string", required: true },
      label: { type: "string", required: true },
    },
  },
});

const setup = (scopes: readonly string[]) => {
  const inner = makeMemoryAdapter({ schema });
  const wrapped = scopeAdapter(inner, { scopes }, schema);
  return typedAdapter<typeof schema>(wrapped);
};

describe("StorageDeps type boundary", () => {
  it("does not accept typedAdapter(rawAdapter)", () => {
    const raw = makeMemoryAdapter({ schema });
    const rawTyped = typedAdapter<typeof schema>(raw);
    const scopedTyped = scopedTypedAdapter<typeof schema>(
      scopeAdapter(raw, { scopes: ["a"] }, schema),
    );

    const accepted: StorageDeps<typeof schema> = {
      scopes: [],
      adapter: scopedTyped,
      blobs: null as never,
    };

    const rejected = {
      scopes: [],
      // @ts-expect-error StorageDeps must not accept typedAdapter(rawAdapter).
      adapter: rawTyped,
      blobs: null as never,
    } satisfies StorageDeps<typeof schema>;

    expect(accepted.adapter).toBe(scopedTyped);
    expect(rejected.adapter).toBe(rawTyped);
  });
});

describe("scopeAdapter — write rejection on scoped tables", () => {
  it.effect("rejects create with scope_id outside the stack", () =>
    Effect.gen(function* () {
      const db = setup(["a", "b"]);
      const result = yield* Effect.exit(
        db.create({
          model: "thing",
          data: { id: "t1", scope_id: "c", value: "v" },
          forceAllowId: true,
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (!Exit.isFailure(result)) return;
      const reason = result.cause.reasons.find(Cause.isFailReason);
      const err = reason?.error ?? null;
      expect(err).toBeInstanceOf(StorageError);
      expect(err).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("not in the executor"),
        }),
      );
    }),
  );

  it.effect("rejects create with missing scope_id", () =>
    Effect.gen(function* () {
      const db = setup(["a"]);
      const result = yield* Effect.exit(
        db.create({
          // Cast because the schema typing requires scope_id — we're
          // testing the runtime guard against programmatic omission.
          model: "thing",
          data: { id: "t1", value: "v" } as {
            id: string;
            scope_id: string;
            value: string;
          },
          forceAllowId: true,
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (!Exit.isFailure(result)) return;
      const reason = result.cause.reasons.find(Cause.isFailReason);
      const err = reason?.error ?? null;
      expect(err).toBeInstanceOf(StorageError);
      expect(err).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("missing required"),
        }),
      );
    }),
  );

  it.effect("accepts create with scope_id in the stack", () =>
    Effect.gen(function* () {
      const db = setup(["a", "b"]);
      yield* db.create({
        model: "thing",
        data: { id: "t1", scope_id: "b", value: "v" },
        forceAllowId: true,
      });
      const row = yield* db.findOne({
        model: "thing",
        where: [{ field: "id", value: "t1" }],
      });
      expect(row?.value).toBe("v");
    }),
  );

  it.effect("createMany rejects if any row targets an out-of-stack scope", () =>
    Effect.gen(function* () {
      const db = setup(["a"]);
      const result = yield* Effect.exit(
        db.createMany({
          model: "thing",
          data: [
            { id: "t1", scope_id: "a", value: "v1" },
            { id: "t2", scope_id: "b", value: "v2" },
          ],
          forceAllowId: true,
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("update with out-of-stack scope_id in payload is rejected", () =>
    Effect.gen(function* () {
      const db = setup(["a"]);
      yield* db.create({
        model: "thing",
        data: { id: "t1", scope_id: "a", value: "v" },
        forceAllowId: true,
      });
      const result = yield* Effect.exit(
        db.update({
          model: "thing",
          where: [{ field: "id", value: "t1" }],
          update: { scope_id: "b", value: "v2" },
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
});

describe("scopeAdapter — read isolation", () => {
  it.effect("findMany returns rows from every scope in the stack", () =>
    Effect.gen(function* () {
      const db = setup(["a", "b"]);
      yield* db.create({
        model: "thing",
        data: { id: "t1", scope_id: "a", value: "a-v" },
        forceAllowId: true,
      });
      yield* db.create({
        model: "thing",
        data: { id: "t2", scope_id: "b", value: "b-v" },
        forceAllowId: true,
      });

      const rows = yield* db.findMany({ model: "thing" });
      const ids = rows.map((r) => r.id).sort();
      expect(ids).toEqual(["t1", "t2"]);
    }),
  );

  it.effect("findMany hides rows from out-of-stack scopes", () =>
    Effect.gen(function* () {
      // Write to scope "c" via an adapter that sees "c", then read via
      // an adapter that only sees ["a", "b"]. "c" must not appear.
      const inner = makeMemoryAdapter({ schema });
      const writerCtx = scopeAdapter(inner, { scopes: ["c"] }, schema);
      const writer = typedAdapter<typeof schema>(writerCtx);
      yield* writer.create({
        model: "thing",
        data: { id: "t-hidden", scope_id: "c", value: "leak?" },
        forceAllowId: true,
      });

      const readerCtx = scopeAdapter(inner, { scopes: ["a", "b"] }, schema);
      const reader = typedAdapter<typeof schema>(readerCtx);
      const rows = yield* reader.findMany({ model: "thing" });
      expect(rows.map((r) => r.id)).not.toContain("t-hidden");
    }),
  );

  it.effect("caller-supplied scope_id filter is stripped (can't bypass isolation)", () =>
    Effect.gen(function* () {
      const inner = makeMemoryAdapter({ schema });
      yield* typedAdapter<typeof schema>(scopeAdapter(inner, { scopes: ["c"] }, schema)).create({
        model: "thing",
        data: { id: "t-hidden", scope_id: "c", value: "secret" },
      });

      const reader = typedAdapter<typeof schema>(scopeAdapter(inner, { scopes: ["a"] }, schema));
      // Attempt to bypass by explicitly filtering for scope_id "c".
      const rows = yield* reader.findMany({
        model: "thing",
        where: [{ field: "scope_id", value: "c" }],
      });
      expect(rows).toHaveLength(0);
    }),
  );

  it.effect("caller-supplied out-of-stack scope_id does not widen to all visible rows", () =>
    Effect.gen(function* () {
      const db = setup(["a"]);
      yield* db.create({
        model: "thing",
        data: { id: "t-visible", scope_id: "a", value: "visible" },
        forceAllowId: true,
      });

      const rows = yield* db.findMany({
        model: "thing",
        where: [{ field: "scope_id", value: "c" }],
      });

      expect(rows).toEqual([]);
    }),
  );

  it.effect("unscoped tables pass through untouched (no scope filter, no guard)", () =>
    Effect.gen(function* () {
      const db = setup(["a"]);
      yield* db.create({
        model: "shared",
        data: { id: "s1", label: "hello" },
        forceAllowId: true,
      });
      const row = yield* db.findOne({
        model: "shared",
        where: [{ field: "id", value: "s1" }],
      });
      expect(row?.label).toBe("hello");
    }),
  );
});
