/**
 * End-to-end behaviour that the upstream snapshots do not cover: interruption
 * rolls a transaction back, consumer name changes migrate without data loss,
 * variant schemas migrate and join, and concurrent writers stay isolated.
 */
import { it } from "@effect/vitest";
import { DateTime, Effect, Fiber, Option, Schema } from "effect";
import { expect } from "vitest";
import { fumadb } from "../src/index.ts";
import type { Provider } from "../src/contracts/provider.ts";
import {
  column as col,
  idColumn,
  schema as defineSchema,
  table as defineTable,
} from "../src/schema.ts";
import { sqlAdapter } from "../src/implementation/sql/index.ts";
import { providers, withProvider } from "./support/databases.ts";
import { queryV1, variantAdmin, variantBase } from "./support/schemas.ts";

const QueryDB = fumadb({ schemas: [queryV1], namespace: "behaviour" });
// Defined as a const first: a schema written inline in the `schemas` array is
// contextually typed as `AnySchema` and loses its version literal.
const typesV1 = defineSchema({
  version: "1.0.0",
  tables: {
    t: defineTable("t", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
      s: col("s", Schema.NullOr(Schema.String)),
      v: col("v", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
      j: col("j", Schema.NullOr(Schema.Unknown)),
      d: col("d", Schema.NullOr(Schema.Date), { type: "date" }),
      ts: col("ts", Schema.NullOr(Schema.Date)),
      dec: col("dec", Schema.NullOr(Schema.Number)),
      u: col("u", Schema.NullOr(Schema.String.check(Schema.isUUID()))),
      bin: col("bin", Schema.NullOr(Schema.Uint8Array)),
      big: col("big", Schema.NullOr(Schema.BigInt)),
    }),
  },
});
const TypesDB = fumadb({ namespace: "behaviour", schemas: [typesV1] });
const VariantDB = fumadb({ schemas: [variantBase, variantAdmin], namespace: "behaviour" });

const migrated = (provider: Provider) =>
  Effect.gen(function* () {
    const client = QueryDB.client(sqlAdapter({ provider }));
    yield* (yield* (yield* client.createMigrator).migrateToLatest()).execute;
    return client.orm("1.0.0");
  });

for (const provider of providers) {
  it.live(
    `${provider}: an interrupted transaction is rolled back`,
    () =>
      withProvider(
        provider,
        Effect.gen(function* () {
          const orm = yield* migrated(provider);
          const fiber = yield* Effect.forkChild(
            orm.transaction(
              Effect.gen(function* () {
                yield* orm.create("users", { id: "a", name: "A" });
                yield* Effect.never;
              }),
            ),
          );
          yield* Effect.sleep("200 millis");
          yield* Fiber.interrupt(fiber);
          expect(yield* orm.count("users")).toBe(0);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    `${provider}: consumer name changes migrate the existing tables and keep the data`,
    () =>
      withProvider(
        provider,
        Effect.gen(function* () {
          const first = QueryDB.client(sqlAdapter({ provider }));
          yield* (yield* (yield* first.createMigrator).migrateToLatest()).execute;
          yield* first.orm("1.0.0").createMany("users", [{ id: "u1", name: "keep me" }]);

          const renamed = QueryDB.names({
            users: { sql: "app_users" },
            "users.name": { sql: "display_name" },
          }).client(sqlAdapter({ provider }));
          const result = yield* (yield* renamed.createMigrator).migrateTo("1.0.0");
          const types = result.operations.map((operation) => operation.type);
          expect(types).toContain("rename-table");
          expect(types.filter((type) => type === "create-table" || type === "drop-table")).toEqual(
            // SQLite recreates the table to apply the column rename; every other provider alters in place.
            provider === "sqlite" ? ["create-table", "drop-table"] : [],
          );
          yield* result.execute;
          expect(yield* renamed.orm("1.0.0").findMany("users")).toEqual([
            { id: "u1", name: "keep me" },
          ]);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    `${provider}: a variant schema migrates and its one-to-one relation joins`,
    () =>
      withProvider(
        provider,
        Effect.gen(function* () {
          const client = VariantDB.client(sqlAdapter({ provider }));
          const migrator = yield* client.createMigrator;
          yield* (yield* migrator.migrateTo("1.0.0-admin")).execute;
          expect(yield* client.version).toBe("1.0.0-admin");
          expect(Option.isNone(yield* migrator.next)).toBe(true);
          const orm = client.orm("1.0.0-admin");
          yield* orm.create("users", { id: "u1", name: "n" });
          yield* orm.create("role", { userId: "u1", role: "admin", description: "d" });
          expect(yield* orm.findMany("users", { join: (b) => b.role() })).toEqual([
            { id: "u1", name: "n", role: { userId: "u1", role: "admin", description: "d" } },
          ]);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    `${provider}: a one join with no related row is null on both join paths`,
    () =>
      withProvider(
        provider,
        Effect.gen(function* () {
          const orm = yield* migrated(provider);
          yield* orm.create("users", { id: "u1", name: "n" });
          // message 1 mentions nothing; message 2 mentions message 1
          yield* orm.createMany("messages", [
            { id: "1", user: "u1", content: "a" },
            { id: "2", user: "u1", content: "b", mentionId: "1" },
          ]);
          // flat LEFT JOIN path (explicit one relation)
          const flat = yield* orm.findMany("messages", {
            orderBy: ["id", "asc"],
            select: ["id"],
            join: (b) => b.mentioning(),
          });
          expect(flat.map((m) => m.mentioning?.id ?? null)).toEqual([null, "1"]);
          // sub-query path (implied one relation), and nested join forcing the sub-query path for `mentioning`
          const nested = yield* orm.findMany("messages", {
            orderBy: ["id", "asc"],
            select: ["id"],
            join: (b) =>
              b
                .mentionedBy({ select: ["id"] })
                .mentioning({ select: ["id"], join: (b) => b.author({ select: ["id"] }) }),
          });
          expect(
            nested.map((m) => [m.mentionedBy?.id ?? null, m.mentioning?.author?.id ?? null]),
          ).toEqual([
            ["2", null],
            [null, "u1"],
          ]);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    `${provider}: concurrent writers outside a transaction do not interfere`,
    () =>
      withProvider(
        provider,
        Effect.gen(function* () {
          const orm = yield* migrated(provider);
          yield* Effect.forEach(
            Array.from({ length: 20 }, (_, i) => i),
            (i) => orm.create("users", { id: `u${i}`, name: `n${i}` }),
            { concurrency: 8 },
          );
          expect(yield* orm.count("users")).toBe(20);
        }),
      ),
    { timeout: 60_000 },
  );
}

for (const provider of providers) {
  it.live(
    `${provider}: every column type round-trips exactly, including unicode, sub-second times, and decimals`,
    () =>
      withProvider(
        provider,
        Effect.gen(function* () {
          const client = TypesDB.client(sqlAdapter({ provider }));
          yield* (yield* (yield* client.createMigrator).migrateToLatest()).execute;
          const orm = client.orm("1.0.0");
          const text = "日本語 ñ é 😀 'quoted'";
          const created = yield* orm.create("t", {
            s: text,
            v: text,
            j: { title: text, n: [1, 2] },
            d: new Date("2024-03-10T00:00:00Z"),
            ts: new Date("1950-06-15T12:34:56.789Z"),
            dec: 0.1 + 0.2,
            u: "0a8f1e2b-3c4d-4e6f-8a8b-9c0d1e2f3a4b",
            bin: new Uint8Array([]),
            big: -9007199254740993n,
          });
          const row = yield* orm.findFirst("t", { where: (b) => b("id", "=", created.id) });
          expect(row).toEqual({
            id: created.id,
            s: text,
            v: text,
            j: { title: text, n: [1, 2] },
            d: new Date("2024-03-10T00:00:00Z"),
            ts: new Date("1950-06-15T12:34:56.789Z"),
            dec: 0.1 + 0.2,
            u: "0a8f1e2b-3c4d-4e6f-8a8b-9c0d1e2f3a4b",
            bin: new Uint8Array([]),
            big: -9007199254740993n,
          });
          // the DST fall-back hour must stay two distinct instants
          const first = yield* orm.create("t", { ts: new Date("2024-11-03T09:30:00.000Z") });
          const second = yield* orm.create("t", { ts: new Date("2024-11-03T08:30:00.000Z") });
          expect(first.ts?.getTime()).not.toBe(second.ts?.getTime());
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    `${provider}: comparing with null, large IN joins, and large batches work`,
    () =>
      withProvider(
        provider,
        Effect.gen(function* () {
          const orm = yield* migrated(provider);
          yield* orm.create("users", { id: "u1", name: "n" });
          yield* orm.createMany(
            "messages",
            Array.from({ length: 1500 }, (_, i) => ({
              id: `m${i}`,
              user: "u1",
              content: i % 2 === 0 ? "even" : "odd",
            })),
          );
          expect(yield* orm.count("messages")).toBe(1500);
          // `= NULL` never matches but must not fail (MSSQL typed null parameters)
          expect(yield* orm.findMany("messages", { where: (b) => b("parent", "=", null) })).toEqual(
            [],
          );
          expect(
            (yield* orm.findMany("messages", {
              where: (b) => b("content", "in", ["even", null] as ReadonlyArray<string>),
            })).length,
          ).toBe(750);
          // a string operator with null is a typed input error, not a match-everything pattern
          const bad = yield* Effect.flip(
            orm.findMany("messages", { where: (b) => b("content", "contains", null as never) }),
          );
          expect(bad._tag === "QueryError" && bad.reason).toBe("InvalidInput");
          // a join over more root rows than SQLite's expression depth or MSSQL's parameter limit
          const users = yield* orm.findMany("users", {
            join: (b) => b.messages({ select: ["id"] }),
          });
          expect(users[0]?.messages.length).toBe(1500);
          const messages = yield* orm.findMany("messages", {
            select: ["id"],
            join: (b) => b.author({ select: ["name"] }),
          });
          expect(messages.length).toBe(1500);
          expect(messages.every((m) => m.author?.name === "n")).toBe(true);
        }),
      ),
    { timeout: 120_000 },
  );
}

// Schema-first columns whose Type differs from the stored value: DateTime join keys, brands, Option, literal unions.
const daysV1 = defineSchema({
  version: "1.0.0",
  tables: {
    days: defineTable("days", {
      id: idColumn("id", Schema.String),
      at: col("at", Schema.DateTimeUtcFromDate).unique(),
    }),
    events: defineTable("events", {
      id: idColumn("id", Schema.String).generated(),
      day: col("day", Schema.DateTimeUtcFromDate),
      kind: col("kind", Schema.Literals(["meeting", "break"])),
      note: col("note", Schema.OptionFromNullOr(Schema.String)),
      priority: col("priority", Schema.Literals([1, 2, 3])).default(2),
    }),
  },
  relations: {
    days: ({ many }) => ({ events: many("events") }),
    events: ({ one }) => ({ day_: one("days", ["day", "at"]).foreignKey({ onDelete: "CASCADE" }) }),
  },
});
const DaysDB = fumadb({ schemas: [daysV1], namespace: "behaviour" });

for (const provider of providers) {
  for (const relationMode of ["foreign-keys", "fumadb"] as const) {
    if (provider === "mssql" && relationMode === "foreign-keys") continue;
    it.live(
      `${provider} (${relationMode}): DateTime join keys, literal unions, and Option columns round-trip`,
      () =>
        withProvider(
          provider,
          Effect.gen(function* () {
            const client = DaysDB.client(sqlAdapter({ provider, relationMode }));
            yield* (yield* (yield* client.createMigrator).migrateToLatest()).execute;
            const orm = client.orm("1.0.0");
            const at = DateTime.makeUnsafe("2024-05-06T00:00:00Z");
            yield* orm.create("days", { id: "d1", at });
            yield* orm.createMany("events", [
              { day: at, kind: "meeting", note: Option.some("standup") },
              { day: at, kind: "break", note: Option.none(), priority: 3 },
            ]);
            const days = yield* orm.findMany("days", {
              join: (b) => b.events({ select: ["kind", "note", "priority"] }),
            });
            expect(
              days[0]?.events.map((e) => [e.kind, Option.getOrNull(e.note), e.priority]).sort(),
            ).toEqual([
              ["break", null, 3],
              ["meeting", "standup", 2],
            ]);
            expect(DateTime.isDateTime(days[0]?.at)).toBe(true);
            expect(yield* orm.count("events", { where: (b) => b("kind", "=", "meeting") })).toBe(1);
            const dangling = yield* Effect.exit(
              orm.create("events", {
                day: DateTime.makeUnsafe("1999-01-01T00:00:00Z"),
                kind: "break",
                note: Option.none(),
              }),
            );
            expect(dangling._tag).toBe("Failure");
            yield* orm.deleteMany("days", { where: (b) => b("id", "=", "d1") });
            expect(yield* orm.count("events")).toBe(0);
          }),
        ),
      { timeout: 60_000 },
    );
  }
}
