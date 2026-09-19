import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { fumadb } from "@executor-js/fumadb";
import {
  createDrizzleRuntimeSchemaFromTables,
  createDrizzleRuntimeSchemaSqlFromTables,
  drizzleAdapter,
} from "@executor-js/fumadb/adapters/drizzle";
import { memoryAdapter } from "@executor-js/fumadb/adapters/memory";
import type { AbstractQuery, JsonFilter } from "@executor-js/fumadb/query";
import { column, idColumn, schema, table } from "@executor-js/fumadb/schema";
import { toORM, type ORMAdapter } from "./orm";

const events = table("events", {
  id: idColumn("id", "varchar(255)"),
  tenant: column("tenant", "varchar(255)"),
  data: column("data", "json"),
});

const v1 = schema({ version: "1.0.0", tables: { events } });

type EventsQuery = AbstractQuery<typeof v1>;

interface SeedRow {
  readonly id: string;
  readonly tenant: string;
  readonly data: {
    readonly status: string;
    readonly trigger: string;
    readonly startedAt: number;
    readonly durationMs: number | null;
  };
}

const seedRows: readonly SeedRow[] = [
  { id: "e1", tenant: "t1", data: { status: "completed", trigger: "cli", startedAt: 1000, durationMs: 100 } },
  { id: "e2", tenant: "t1", data: { status: "completed", trigger: "cli", startedAt: 2000, durationMs: 200 } },
  { id: "e3", tenant: "t1", data: { status: "failed", trigger: "http", startedAt: 3000, durationMs: 300 } },
  { id: "e4", tenant: "t1", data: { status: "running", trigger: "http", startedAt: 4000, durationMs: null } },
  { id: "e5", tenant: "t2", data: { status: "completed", trigger: "cli", startedAt: 5000, durationMs: 500 } },
];

// Rows whose status carries literal LIKE wildcards (`_`, `%`). Kept out of the
// shared seed (existing assertions count exact t1 rows) and seeded only by the
// wildcard-parity test under a dedicated tenant. `a_b%c` must be matched
// literally; `axbyc` is the lookalike an unescaped LIKE would wrongly catch.
const wildcardRows: readonly SeedRow[] = [
  { id: "w1", tenant: "tw", data: { status: "a_b%c", trigger: "cli", startedAt: 6000, durationMs: 600 } },
  { id: "w2", tenant: "tw", data: { status: "axbyc", trigger: "cli", startedAt: 7000, durationMs: 700 } },
];

const inT1 = (eb: Parameters<NonNullable<Parameters<EventsQuery["jsonCount"]>[1]["where"]>>[0]) =>
  eb("tenant", "=", "t1");

const statusIn = (values: readonly string[]): JsonFilter => ({
  kind: "array",
  path: ["status"],
  valueType: "text",
  operator: "in",
  values,
});

const statusCompare = (
  operator: "=" | "contains" | "starts with" | "ends with",
  value: string,
): JsonFilter => ({
  kind: "compare",
  path: ["status"],
  valueType: "text",
  operator,
  value,
});

const seed = async (orm: EventsQuery) => {
  await orm.createMany("events", seedRows.map((row) => ({ ...row })));
};

interface Harness {
  readonly orm: EventsQuery;
  readonly close: () => Promise<void>;
}

const makeMemoryHarness = async (): Promise<Harness> => {
  const client = fumadb({ namespace: "aggregate_test", schemas: [v1] }).client(memoryAdapter());
  return { orm: client.orm("1.0.0") as EventsQuery, close: async () => {} };
};

const makeSqliteHarness = async (): Promise<Harness> => {
  const sqlite = new Database(":memory:");
  const schemaArgs = {
    tables: v1.tables,
    namespace: "aggregate_test",
    version: "1.0.0",
    provider: "sqlite",
  } as const;
  const drizzleDb = drizzle(sqlite, { schema: createDrizzleRuntimeSchemaFromTables(schemaArgs) });
  for (const statement of createDrizzleRuntimeSchemaSqlFromTables(schemaArgs)) {
    sqlite.exec(statement);
  }
  const client = fumadb({ namespace: "aggregate_test", schemas: [v1] }).client(
    drizzleAdapter({ db: drizzleDb, provider: "sqlite" }),
  );
  return {
    orm: client.orm("1.0.0") as EventsQuery,
    close: async () => {
      sqlite.close();
    },
  };
};

const runSuite = (name: string, makeHarness: () => Promise<Harness>) => {
  describe(`json aggregation (${name})`, () => {
    let harness: Harness;
    beforeEach(async () => {
      harness = await makeHarness();
      await seed(harness.orm);
    });
    afterEach(async () => {
      await harness.close();
    });

    it("jsonCount scopes by real columns and JSON filter", async () => {
      const { orm } = harness;
      expect(await orm.jsonCount("events", { column: "data", where: inT1 })).toBe(4);
      expect(await orm.jsonCount("events", { column: "data", where: (eb) => eb("tenant", "=", "t2") })).toBe(1);
      expect(
        await orm.jsonCount("events", { column: "data", where: inT1, filter: statusIn(["completed"]) }),
      ).toBe(2);
    });

    it("matches empty composite filter semantics", async () => {
      const { orm } = harness;
      expect(
        await orm.jsonCount("events", {
          column: "data",
          where: inT1,
          filter: { kind: "or", items: [] },
        }),
      ).toBe(0);
      expect(
        await orm.jsonCount("events", {
          column: "data",
          where: inT1,
          filter: { kind: "and", items: [] },
        }),
      ).toBe(4);
    });

    it("jsonGroupCount counts distinct values", async () => {
      const rows = await harness.orm.jsonGroupCount("events", {
        column: "data",
        where: inT1,
        path: ["status"],
      });
      const byValue = Object.fromEntries(rows.map((row) => [row.value, row.count]));
      expect(byValue).toEqual({ completed: 2, failed: 1, running: 1 });
    });

    it("jsonTimeBuckets buckets a numeric path", async () => {
      const rows = await harness.orm.jsonTimeBuckets("events", {
        column: "data",
        where: inT1,
        path: ["startedAt"],
        bucketMs: 2000,
      });
      expect(rows).toEqual([
        { bucket: 0, count: 1 },
        { bucket: 2000, count: 2 },
        { bucket: 4000, count: 1 },
      ]);
    });

    it("jsonStats computes count/min/max and continuous percentiles", async () => {
      const stats = await harness.orm.jsonStats("events", {
        column: "data",
        where: inT1,
        path: ["durationMs"],
        percentiles: [0, 0.5, 1],
      });
      expect(stats.count).toBe(3);
      expect(stats.min).toBe(100);
      expect(stats.max).toBe(300);
      expect(stats.percentiles).toEqual([
        { fraction: 0, value: 100 },
        { fraction: 0.5, value: 200 },
        { fraction: 1, value: 300 },
      ]);
    });

    it("jsonPage keyset-paginates by a JSON path with a real-column tiebreak", async () => {
      const { orm } = harness;
      const page1 = await orm.jsonPage("events", {
        column: "data",
        where: inT1,
        orderBy: [{ path: ["startedAt"], valueType: "number", direction: "desc" }],
        keyColumn: "id",
        keyDirection: "desc",
        limit: 2,
      });
      expect(page1.map((row) => row.id)).toEqual(["e4", "e3"]);

      const page2 = await orm.jsonPage("events", {
        column: "data",
        where: inT1,
        orderBy: [{ path: ["startedAt"], valueType: "number", direction: "desc" }],
        keyColumn: "id",
        keyDirection: "desc",
        limit: 2,
        cursor: { values: [3000], key: "e3" },
      });
      expect(page2.map((row) => row.id)).toEqual(["e2", "e1"]);
    });

    it("jsonPage applies the JSON filter", async () => {
      const rows = await harness.orm.jsonPage("events", {
        column: "data",
        where: inT1,
        filter: statusIn(["completed", "failed"]),
        orderBy: [{ path: ["startedAt"], valueType: "number", direction: "asc" }],
        keyColumn: "id",
        keyDirection: "asc",
        limit: 10,
      });
      expect(rows.map((row) => row.id)).toEqual(["e1", "e2", "e3"]);
    });

    it("excludes null-path rows from = / != filters (SQL three-valued logic)", async () => {
      const { orm } = harness;
      // e4 has durationMs: null. `!= 200` excludes e2 (it matches 200) AND e4
      // (NULL comparisons are unknown in SQL), leaving e1 + e3.
      expect(
        await orm.jsonCount("events", {
          column: "data",
          where: inT1,
          filter: { kind: "compare", path: ["durationMs"], valueType: "number", operator: "!=", value: 200 },
        }),
      ).toBe(2);
      // `= 100` matches only e1; the null row never matches `=`.
      expect(
        await orm.jsonCount("events", {
          column: "data",
          where: inT1,
          filter: { kind: "compare", path: ["durationMs"], valueType: "number", operator: "=", value: 100 },
        }),
      ).toBe(1);
      expect(
        await orm.jsonCount("events", {
          column: "data",
          where: inT1,
          filter: {
            kind: "array",
            path: ["durationMs"],
            valueType: "number",
            operator: "in",
            values: [100, 300],
          },
        }),
      ).toBe(2);
      expect(
        await orm.jsonCount("events", {
          column: "data",
          where: inT1,
          filter: {
            kind: "array",
            path: ["durationMs"],
            valueType: "number",
            operator: "not in",
            values: [200],
          },
        }),
      ).toBe(2);
    });

    it("quotes JSON path segments for nested object keys", async () => {
      const { orm } = harness;
      await orm.create("events", {
        id: "path-1",
        tenant: "tp",
        data: {
          "a.b": {
            'c"d': 7,
          },
          a: {
            b: {
              'c"d': 99,
            },
          },
        },
      });

      await expect(
        orm.jsonCount("events", {
          column: "data",
          where: (eb) => eb("tenant", "=", "tp"),
          filter: {
            kind: "compare",
            path: ["a.b", 'c"d'],
            valueType: "number",
            operator: "=",
            value: 7,
          },
        }),
      ).resolves.toBe(1);
    });

    it("keyset-paginates a nullable sort column without truncating", async () => {
      const { orm } = harness;
      const collected: string[] = [];
      let cursor: { readonly values: readonly (number | null)[]; readonly key: string } | undefined;
      for (let i = 0; i < 10; i += 1) {
        const rows = await orm.jsonPage("events", {
          column: "data",
          where: inT1,
          orderBy: [{ path: ["durationMs"], valueType: "number", direction: "asc" }],
          keyColumn: "id",
          keyDirection: "asc",
          limit: 1,
          cursor,
        });
        if (rows.length === 0) break;
        const last = rows[rows.length - 1]!;
        const key = last.id as string;
        collected.push(key);
        cursor = { values: [(last.data as { durationMs: number | null }).durationMs], key };
      }
      // asc, nulls first: e4(null), then e1(100), e2(200), e3(300). The page
      // whose cursor is the null row must still return the non-null rows, a
      // naive `durationMs > NULL` predicate would truncate here.
      expect(collected).toEqual(["e4", "e1", "e2", "e3"]);
    });
  });
};

runSuite("memory", makeMemoryHarness);
runSuite("sqlite", makeSqliteHarness);

// LIKE-wildcard parity: a value carrying literal `_`/`%` must match the same
// rows under the drizzle (sqlite) adapter as under the literal memory adapter.
// Without ESCAPE these wildcards would make sqlite over-match (`a_b%c` would
// also catch `axbyc`).
describe("json filter LIKE-wildcard parity (memory vs sqlite)", () => {
  let memory: Harness;
  let sqlite: Harness;
  beforeEach(async () => {
    memory = await makeMemoryHarness();
    sqlite = await makeSqliteHarness();
    await memory.orm.createMany("events", wildcardRows.map((row) => ({ ...row })));
    await sqlite.orm.createMany("events", wildcardRows.map((row) => ({ ...row })));
  });
  afterEach(async () => {
    await memory.close();
    await sqlite.close();
  });

  const idsFor = async (orm: EventsQuery, filter: JsonFilter): Promise<readonly string[]> => {
    const rows = await orm.jsonPage("events", {
      column: "data",
      where: (eb) => eb("tenant", "=", "tw"),
      filter,
      orderBy: [{ path: ["startedAt"], valueType: "number", direction: "asc" }],
      keyColumn: "id",
      keyDirection: "asc",
      limit: 100,
    });
    return rows.map((row) => row.id as string);
  };

  it.each([
    ["contains", statusCompare("contains", "_b%")],
    ["eq", statusCompare("=", "a_b%c")],
    ["starts with", statusCompare("starts with", "a_")],
    ["ends with", statusCompare("ends with", "%c")],
  ] as const)("matches identically for %s", async (_label, filter) => {
    const fromMemory = await idsFor(memory.orm, filter);
    const fromSqlite = await idsFor(sqlite.orm, filter);
    expect(fromSqlite).toEqual(fromMemory);
    // The wildcard row must be selected, the lookalike (`axbyc`) must not.
    expect(fromMemory).toContain("w1");
    expect(fromMemory).not.toContain("w2");
  });
});

describe("json aggregation unsupported adapters", () => {
  it("fails loudly when the adapter has no JSON aggregate hooks", async () => {
    let unsupported: EventsQuery;
    const adapter: ORMAdapter<typeof v1> = {
      tables: v1.tables,
      count: async () => 0,
      findFirst: async () => null,
      findMany: async () => [],
      updateMany: async () => {},
      upsert: async () => {},
      create: async () => ({}),
      createMany: async () => [],
      deleteMany: async () => {},
      transaction: async <T>(run: (transactionInstance: EventsQuery) => Promise<T>): Promise<T> =>
        run(unsupported),
    };
    unsupported = toORM(adapter);

    await expect(unsupported.jsonCount("events", { column: "data" })).rejects.toThrow(
      "[FumaDB] jsonCount is not supported by this adapter.",
    );
  });
});
