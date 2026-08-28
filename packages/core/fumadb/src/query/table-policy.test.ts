import Database from "better-sqlite3";
import { describe, expect, it } from "@effect/vitest";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Effect } from "effect";
import { fumadb } from "@executor-js/fumadb";
import {
  createDrizzleRuntimeSchemaFromTables,
  createDrizzleRuntimeSchemaSqlFromTables,
  drizzleAdapter,
} from "@executor-js/fumadb/adapters/drizzle";
import { memoryAdapter } from "@executor-js/fumadb/adapters/memory";
import { withQueryContext, type AbstractQuery } from "@executor-js/fumadb/query";
import { column, idColumn, schema, table } from "@executor-js/fumadb/schema";

interface TenantPolicyContext {
  readonly allowedTenantIds: ReadonlySet<string>;
  readonly deniedTables: ReadonlySet<string>;
  readonly marker: string;
  readonly observed: string[];
  readonly allowedRegionId?: bigint;
}

const observe = (context: TenantPolicyContext, event: string) => {
  context.observed.push(`${context.marker}:${event}`);
};

const assertTenantAllowed = (tableName: string, context: TenantPolicyContext, tenantId: string) => {
  observe(context, `${tableName}:assert`);
  if (!context.allowedTenantIds.has(tenantId)) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: FumaDB table policy callbacks reject writes by throwing
    throw new Error(`tenant ${tenantId} is not allowed for ${tableName}`);
  }
};

const isReadDenied = (tableName: string, context: TenantPolicyContext) => {
  observe(context, `${tableName}:read`);
  return context.deniedTables.has(tableName);
};

const authors = table("policy_authors", {
  id: idColumn("id", "varchar(255)"),
  tenantId: column("tenant_id", "varchar(255)"),
  name: column("name", "string"),
}).policy<TenantPolicyContext>({
  name: "tenant.authors",
  onRead: ({ builder, context }) => {
    if (isReadDenied("authors", context)) return false;
    return builder("tenantId", "in", [...context.allowedTenantIds]);
  },
  onCreate: ({ values, context }) => assertTenantAllowed("authors", context, values.tenantId),
  onUpdate: ({ builder, set, context }) => {
    observe(context, "authors:update");
    if (set.tenantId !== undefined) assertTenantAllowed("authors", context, set.tenantId);
    return builder("tenantId", "in", [...context.allowedTenantIds]);
  },
  onDelete: ({ builder, context }) => {
    observe(context, "authors:delete");
    return builder("tenantId", "in", [...context.allowedTenantIds]);
  },
});

const posts = table("policy_posts", {
  id: idColumn("id", "varchar(255)"),
  tenantId: column("tenant_id", "varchar(255)"),
  authorId: column("author_id", "varchar(255)"),
  title: column("title", "string"),
}).policy<TenantPolicyContext>({
  name: "tenant.posts",
  onRead: ({ builder, context }) => {
    if (isReadDenied("posts", context)) return false;
    return builder("tenantId", "in", [...context.allowedTenantIds]);
  },
  onCreate: ({ values, context }) => assertTenantAllowed("posts", context, values.tenantId),
  onUpdate: ({ builder, set, context }) => {
    observe(context, "posts:update");
    if (set.tenantId !== undefined) assertTenantAllowed("posts", context, set.tenantId);
    return builder("tenantId", "in", [...context.allowedTenantIds]);
  },
  onDelete: ({ builder, context }) => {
    observe(context, "posts:delete");
    return builder("tenantId", "in", [...context.allowedTenantIds]);
  },
});

const comments = table("policy_comments", {
  id: idColumn("id", "varchar(255)"),
  tenantId: column("tenant_id", "varchar(255)"),
  postId: column("post_id", "varchar(255)"),
  body: column("body", "string"),
}).policy<TenantPolicyContext>({
  name: "tenant.comments",
  onRead: ({ builder, context }) => {
    if (isReadDenied("comments", context)) return false;
    return builder("tenantId", "in", [...context.allowedTenantIds]);
  },
  onCreate: ({ values, context }) => assertTenantAllowed("comments", context, values.tenantId),
  onUpdate: ({ builder, set, context }) => {
    observe(context, "comments:update");
    if (set.tenantId !== undefined) assertTenantAllowed("comments", context, set.tenantId);
    return builder("tenantId", "in", [...context.allowedTenantIds]);
  },
  onDelete: ({ builder, context }) => {
    observe(context, "comments:delete");
    return builder("tenantId", "in", [...context.allowedTenantIds]);
  },
});

// Policy predicate carries a bigint value; string-keyed grouping of these
// predicates (e.g. JSON.stringify) throws on bigint.
const quotas = table("policy_quotas", {
  id: idColumn("id", "varchar(255)"),
  region: column("region", "bigint"),
  label: column("label", "string"),
}).policy<TenantPolicyContext>({
  name: "tenant.quotas",
  onUpdate: ({ builder, context }) => builder("region", "=", context.allowedRegionId ?? BigInt(-1)),
});

// The update policy predicate depends on the row itself, so rows with
// different `shard` values compile to different predicates and split one
// upsertMany call into separate predicate groups.
const shards = table("policy_shards", {
  id: idColumn("id", "varchar(255)"),
  shard: column("shard", "string"),
  authorId: column("author_id", "varchar(255)"),
}).policy<TenantPolicyContext>({
  name: "tenant.shards",
  onUpdate: ({ builder, set }) => builder("shard", "=", set.shard ?? ""),
});

// Ten columns, so a row-count-sized batch would bind ten parameters per row.
const wideRows = table("policy_wide_rows", {
  id: idColumn("id", "varchar(255)"),
  c1: column("c1", "string"),
  c2: column("c2", "string"),
  c3: column("c3", "string"),
  c4: column("c4", "string"),
  c5: column("c5", "string"),
  c6: column("c6", "string"),
  c7: column("c7", "string"),
  c8: column("c8", "string"),
  c9: column("c9", "string"),
});

const v1 = schema({
  version: "1.0.0",
  tables: {
    authors,
    posts,
    comments,
    quotas,
    shards,
    wideRows,
  },
  relations: {
    authors: ({ many }) => ({
      posts: many("posts"),
      shards: many("shards"),
    }),
    shards: ({ one }) => ({
      author: one("authors", ["authorId", "id"]).foreignKey(),
    }),
    posts: ({ one, many }) => ({
      author: one("authors", ["authorId", "id"]).foreignKey(),
      comments: many("comments"),
    }),
    comments: ({ one }) => ({
      post: one("posts", ["postId", "id"]).foreignKey(),
    }),
  },
});

const tablePolicyDB = fumadb({
  namespace: "table_policy_test",
  schemas: [v1],
});

type TablePolicyQuery = AbstractQuery<typeof v1>;

const makeContext = (
  allowedTenantIds: readonly string[],
  marker: string,
  deniedTables: readonly string[] = [],
): TenantPolicyContext => ({
  allowedTenantIds: new Set(allowedTenantIds),
  deniedTables: new Set(deniedTables),
  marker,
  observed: [],
});

const makeHarness = async (options?: {
  readonly nativeBatch?: boolean;
  readonly maxBoundParameters?: number;
}) => {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const runtimeSchema = createDrizzleRuntimeSchemaFromTables({
    tables: v1.tables,
    namespace: "table_policy_test",
    version: "1.0.0",
    provider: "sqlite",
  });
  const statements: { readonly sql: string; readonly paramCount: number }[] = [];
  const drizzleDb = drizzle(sqlite, {
    schema: runtimeSchema,
    logger: {
      logQuery: (query: string, params: unknown[]) => {
        statements.push({ sql: query, paramCount: params.length });
      },
    },
  });
  let batchCalls = 0;

  if (options?.nativeBatch) {
    Object.assign(drizzleDb, {
      batch: async (queries: readonly { run: () => unknown }[]) => {
        batchCalls += 1;
        return sqlite.transaction(() => queries.map((query) => query.run()))();
      },
    });
  }

  for (const statement of createDrizzleRuntimeSchemaSqlFromTables({
    tables: v1.tables,
    namespace: "table_policy_test",
    version: "1.0.0",
    provider: "sqlite",
  })) {
    sqlite.exec(statement);
  }

  const client = tablePolicyDB.client(
    drizzleAdapter({
      db: drizzleDb,
      provider: "sqlite",
      interactiveTransactions: options?.nativeBatch ? false : undefined,
      maxBoundParameters: options?.maxBoundParameters,
    }),
  );

  return {
    orm: client.orm("1.0.0"),
    getBatchCalls: () => batchCalls,
    getStatements: (): readonly { readonly sql: string; readonly paramCount: number }[] =>
      statements,
    close: async () => {
      sqlite.close();
    },
  };
};

const useHarness = <A>(run: (orm: TablePolicyQuery) => Promise<A>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => makeHarness()),
    ({ orm }) => Effect.promise(() => run(orm)),
    ({ close }) => Effect.promise(close),
  );

const useStatementHarness = <A>(
  run: (harness: {
    readonly orm: TablePolicyQuery;
    readonly getStatements: () => readonly { readonly sql: string; readonly paramCount: number }[];
  }) => Promise<A>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => makeHarness()),
    (harness) => Effect.promise(() => run(harness)),
    ({ close }) => Effect.promise(close),
  );

const useBudgetHarness = <A>(
  maxBoundParameters: number,
  run: (orm: TablePolicyQuery) => Promise<A>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => makeHarness({ maxBoundParameters })),
    ({ orm }) => Effect.promise(() => run(orm)),
    ({ close }) => Effect.promise(close),
  );

const useNativeBatchHarness = <A>(
  run: (harness: {
    readonly orm: TablePolicyQuery;
    readonly getBatchCalls: () => number;
  }) => Promise<A>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => makeHarness({ nativeBatch: true, maxBoundParameters: 8 })),
    (harness) => Effect.promise(() => run(harness)),
    ({ close }) => Effect.promise(close),
  );

const seedTenants = async (orm: TablePolicyQuery) => {
  const seed = withQueryContext(orm, makeContext(["tenant-a", "tenant-b"], "seed"));

  await seed.createMany("authors", [
    {
      id: "author-a",
      tenantId: "tenant-a",
      name: "Ada",
    },
    {
      id: "author-b",
      tenantId: "tenant-b",
      name: "Bert",
    },
  ]);

  await seed.createMany("posts", [
    {
      id: "post-a-1",
      tenantId: "tenant-a",
      authorId: "author-a",
      title: "A One",
    },
    {
      id: "post-a-2",
      tenantId: "tenant-a",
      authorId: "author-a",
      title: "A Two",
    },
    {
      id: "post-b-1",
      tenantId: "tenant-b",
      authorId: "author-b",
      title: "B One",
    },
  ]);

  await seed.createMany("comments", [
    {
      id: "comment-a-1",
      tenantId: "tenant-a",
      postId: "post-a-1",
      body: "A comment",
    },
    {
      id: "comment-b-1",
      tenantId: "tenant-b",
      postId: "post-b-1",
      body: "B comment",
    },
  ]);
};

describe("FumaDB table policies", () => {
  it.effect(
    "filters reads, joins, counts, updates, deletes, and upserts through public query APIs",
    () =>
      useHarness(async (orm) => {
        await seedTenants(orm);
        const tenantAContext = makeContext(["tenant-a"], "tenant-a");
        const tenantA = withQueryContext(orm, tenantAContext);
        const allTenants = withQueryContext(orm, makeContext(["tenant-a", "tenant-b"], "all"));

        await expect(tenantA.count("posts")).resolves.toBe(2);

        await expect(
          tenantA.findMany("authors", {
            orderBy: ["id", "asc"],
            join: (builder) =>
              builder.posts({
                orderBy: ["id", "asc"],
                join: (builder) => builder.comments({ orderBy: ["id", "asc"] }),
              }),
          }),
        ).resolves.toEqual([
          {
            id: "author-a",
            tenantId: "tenant-a",
            name: "Ada",
            posts: [
              {
                id: "post-a-1",
                tenantId: "tenant-a",
                authorId: "author-a",
                title: "A One",
                comments: [
                  {
                    id: "comment-a-1",
                    tenantId: "tenant-a",
                    postId: "post-a-1",
                    body: "A comment",
                  },
                ],
              },
              {
                id: "post-a-2",
                tenantId: "tenant-a",
                authorId: "author-a",
                title: "A Two",
                comments: [],
              },
            ],
          },
        ]);

        await expect(
          tenantA.findMany("posts", {
            orderBy: ["id", "asc"],
            join: (builder) =>
              builder.author({
                select: ["id", "tenantId"],
              }),
          }),
        ).resolves.toEqual([
          {
            id: "post-a-1",
            tenantId: "tenant-a",
            authorId: "author-a",
            title: "A One",
            author: {
              id: "author-a",
              tenantId: "tenant-a",
            },
          },
          {
            id: "post-a-2",
            tenantId: "tenant-a",
            authorId: "author-a",
            title: "A Two",
            author: {
              id: "author-a",
              tenantId: "tenant-a",
            },
          },
        ]);

        await tenantA.updateMany("posts", {
          set: {
            title: "tenant-a-updated",
          },
        });
        await expect(
          allTenants.findMany("posts", {
            select: ["id", "title"],
            orderBy: ["id", "asc"],
          }),
        ).resolves.toEqual([
          {
            id: "post-a-1",
            title: "tenant-a-updated",
          },
          {
            id: "post-a-2",
            title: "tenant-a-updated",
          },
          {
            id: "post-b-1",
            title: "B One",
          },
        ]);

        await tenantA.deleteMany("comments", {});
        await expect(
          allTenants.findMany("comments", {
            select: ["id", "tenantId"],
            orderBy: ["id", "asc"],
          }),
        ).resolves.toEqual([
          {
            id: "comment-b-1",
            tenantId: "tenant-b",
          },
        ]);

        await tenantA.upsert("posts", {
          where: (builder) => builder("id", "=", "post-a-2"),
          update: {
            title: "tenant-a-upserted",
          },
          create: {
            id: "post-a-created-if-missing",
            tenantId: "tenant-a",
            authorId: "author-a",
            title: "not used",
          },
        });
        await tenantA.upsert("posts", {
          where: (builder) => builder("id", "=", "post-a-3"),
          update: {
            title: "not used",
          },
          create: {
            id: "post-a-3",
            tenantId: "tenant-a",
            authorId: "author-a",
            title: "A Three",
          },
        });
        await tenantA.upsertMany("posts", {
          target: ["id"],
          update: ["title"],
          values: [
            {
              id: "post-a-1",
              tenantId: "tenant-a",
              authorId: "author-a",
              title: "tenant-a-bulk-upserted",
            },
            {
              id: "post-a-4",
              tenantId: "tenant-a",
              authorId: "author-a",
              title: "A Four",
            },
          ],
        });

        await expect(
          tenantA.findMany("posts", {
            select: ["id", "title"],
            orderBy: ["id", "asc"],
          }),
        ).resolves.toEqual([
          {
            id: "post-a-1",
            title: "tenant-a-bulk-upserted",
          },
          {
            id: "post-a-2",
            title: "tenant-a-upserted",
          },
          {
            id: "post-a-3",
            title: "A Three",
          },
          {
            id: "post-a-4",
            title: "A Four",
          },
        ]);

        expect(tenantAContext.observed).toEqual(
          expect.arrayContaining([
            "tenant-a:posts:read",
            "tenant-a:authors:read",
            "tenant-a:comments:read",
            "tenant-a:posts:update",
            "tenant-a:comments:delete",
            "tenant-a:posts:assert",
          ]),
        );
      }),
  );

  it.effect("keeps requested relation keys when read policies deny joins", () =>
    useHarness(async (orm) => {
      await seedTenants(orm);

      const blockedComments = withQueryContext(
        orm,
        makeContext(["tenant-a"], "blocked-comments", ["comments"]),
      );
      await expect(
        blockedComments.findMany("posts", {
          where: (builder) => builder("id", "=", "post-a-1"),
          join: (builder) => builder.comments(),
        }),
      ).resolves.toEqual([
        {
          id: "post-a-1",
          tenantId: "tenant-a",
          authorId: "author-a",
          title: "A One",
          comments: [],
        },
      ]);

      const blockedAuthors = withQueryContext(
        orm,
        makeContext(["tenant-a"], "blocked-authors", ["authors"]),
      );
      await expect(
        blockedAuthors.findMany("posts", {
          where: (builder) => builder("id", "=", "post-a-1"),
          join: (builder) => builder.author(),
        }),
      ).resolves.toEqual([
        {
          id: "post-a-1",
          tenantId: "tenant-a",
          authorId: "author-a",
          title: "A One",
          author: null,
        },
      ]);
    }),
  );

  it.effect("rejects invalid bulk upsert conflict shapes", () =>
    useHarness(async (orm) => {
      await seedTenants(orm);
      const tenantA = withQueryContext(orm, makeContext(["tenant-a"], "tenant-a"));
      const values = [
        {
          id: "post-a-bulk-upsert",
          tenantId: "tenant-a",
          authorId: "author-a",
          title: "A bulk upsert",
        },
      ];

      await expect(
        tenantA.upsertMany("posts", {
          target: [],
          update: ["title"],
          values,
        }),
      ).rejects.toThrow("[FumaDB] upsertMany requires at least one target column.");

      await expect(
        tenantA.upsertMany("posts", {
          target: ["id"],
          update: [],
          values,
        }),
      ).rejects.toThrow("[FumaDB] upsertMany requires at least one update column.");
    }),
  );

  it.effect("keeps every bulk upsert statement inside the bound-variable budget", () =>
    useStatementHarness(async ({ orm, getStatements }) => {
      // 250 rows * 10 columns = 2,500 bound variables in a single statement —
      // over older SQLite's 999-variable cap. The adapter advertises no limit
      // here, so batching must fall back to the conservative 999 budget.
      const values = Array.from({ length: 250 }, (_, index) => ({
        id: `wide-${String(index).padStart(3, "0")}`,
        c1: `value-${index}-1`,
        c2: `value-${index}-2`,
        c3: `value-${index}-3`,
        c4: `value-${index}-4`,
        c5: `value-${index}-5`,
        c6: `value-${index}-6`,
        c7: `value-${index}-7`,
        c8: `value-${index}-8`,
        c9: `value-${index}-9`,
      }));

      await orm.upsertMany("wideRows", {
        target: ["id"],
        update: ["c1"],
        values,
      });

      const inserts = getStatements().filter((statement) =>
        statement.sql.toLowerCase().startsWith("insert into"),
      );
      expect(inserts.length).toBeGreaterThanOrEqual(3);
      for (const statement of inserts) {
        expect(statement.paramCount).toBeLessThanOrEqual(999);
      }
      await expect(orm.count("wideRows")).resolves.toBe(250);
    }),
  );

  it.effect("bulk upserts through a policy predicate that contains a bigint", () =>
    useHarness(async (orm) => {
      const region = withQueryContext(orm, {
        ...makeContext(["tenant-a"], "region"),
        allowedRegionId: BigInt(7),
      });

      await region.createMany("quotas", [
        { id: "quota-in-region", region: BigInt(7), label: "before" },
        { id: "quota-out-of-region", region: BigInt(9), label: "before" },
      ]);

      await region.upsertMany("quotas", {
        target: ["id"],
        update: ["label"],
        values: [
          { id: "quota-in-region", region: BigInt(7), label: "after" },
          { id: "quota-out-of-region", region: BigInt(9), label: "after" },
          { id: "quota-created", region: BigInt(7), label: "created" },
        ],
      });

      await expect(
        region.findMany("quotas", {
          select: ["id", "label"],
          orderBy: ["id", "asc"],
        }),
      ).resolves.toEqual([
        { id: "quota-created", label: "created" },
        { id: "quota-in-region", label: "after" },
        { id: "quota-out-of-region", label: "before" },
      ]);
    }),
  );

  it.effect("skips policy-excluded conflicts identically on drizzle and memory adapters", () => {
    // `post-b-1` already exists for tenant-b, so its unique target conflicts,
    // and the tenant-a update policy excludes the conflicting row. SQL detects
    // the conflict first and the predicate only gates the update, so the row
    // is skipped — never duplicated.
    const upsertAcrossPolicyExcludedConflict = async (orm: TablePolicyQuery) => {
      await seedTenants(orm);
      const tenantA = withQueryContext(orm, makeContext(["tenant-a"], "tenant-a"));
      await tenantA.upsertMany("posts", {
        target: ["id"],
        update: ["title"],
        values: [
          {
            id: "post-b-1",
            tenantId: "tenant-a",
            authorId: "author-a",
            title: "hijack attempt",
          },
          {
            id: "post-a-9",
            tenantId: "tenant-a",
            authorId: "author-a",
            title: "A Nine",
          },
        ],
      });
      const allTenants = withQueryContext(orm, makeContext(["tenant-a", "tenant-b"], "all"));
      return allTenants.findMany("posts", {
        select: ["id", "tenantId", "title"],
        orderBy: ["id", "asc"],
      });
    };

    const expected = [
      { id: "post-a-1", tenantId: "tenant-a", title: "A One" },
      { id: "post-a-2", tenantId: "tenant-a", title: "A Two" },
      { id: "post-a-9", tenantId: "tenant-a", title: "A Nine" },
      { id: "post-b-1", tenantId: "tenant-b", title: "B One" },
    ];

    return useHarness(async (orm) => {
      await expect(upsertAcrossPolicyExcludedConflict(orm)).resolves.toEqual(expected);

      const memoryOrm = tablePolicyDB.client(memoryAdapter()).orm("1.0.0");
      await expect(upsertAcrossPolicyExcludedConflict(memoryOrm)).resolves.toEqual(expected);
    });
  });

  it.effect("rolls back every bounded upsert statement when a native batch fails", () =>
    useNativeBatchHarness(async ({ orm, getBatchCalls }) => {
      await seedTenants(orm);
      const tenantA = withQueryContext(orm, makeContext(["tenant-a"], "tenant-a"));

      await expect(
        tenantA.upsertMany("posts", {
          target: ["id"],
          update: ["title"],
          values: [
            {
              id: "post-a-batch-1",
              tenantId: "tenant-a",
              authorId: "author-a",
              title: "A batch one",
            },
            {
              id: "post-a-batch-2",
              tenantId: "tenant-a",
              authorId: "author-a",
              title: "A batch two",
            },
            {
              id: "post-a-batch-invalid",
              tenantId: "tenant-a",
              authorId: "missing-author",
              title: "Must roll back",
            },
          ],
        }),
      ).rejects.toThrow();

      expect(getBatchCalls()).toBe(1);
      await expect(
        tenantA.findMany("posts", {
          where: (builder) => builder("id", "starts with", "post-a-batch-"),
          select: ["id"],
        }),
      ).resolves.toEqual([]);
    }),
  );

  it.effect("rolls back earlier predicate groups when a later group fails", () =>
    useHarness(async (orm) => {
      await seedTenants(orm);
      const writer = withQueryContext(orm, makeContext(["tenant-a"], "groups"));

      // Two distinct per-row predicates split this call into two internal
      // groups. The second group's row references a missing author, so its
      // insert violates the foreign key — the first group's rows must roll
      // back with it instead of staying committed.
      await expect(
        writer.upsertMany("shards", {
          target: ["id"],
          update: ["shard"],
          values: [
            { id: "shard-a-1", shard: "a", authorId: "author-a" },
            { id: "shard-b-1", shard: "b", authorId: "missing-author" },
          ],
        }),
      ).rejects.toThrow();

      await expect(orm.count("shards")).resolves.toBe(0);
    }),
  );

  it.effect("rolls back earlier createMany batches when a later batch fails", () =>
    useBudgetHarness(8, async (orm) => {
      await seedTenants(orm);
      const tenantA = withQueryContext(orm, makeContext(["tenant-a"], "tenant-a"));

      // Four columns per row against an 8-parameter budget forces two-row
      // batches, so this insert runs as two statements. The last row reuses
      // the seeded `post-a-1` id, so the second statement violates the
      // primary key — the first statement's rows must roll back with it.
      await expect(
        tenantA.createMany("posts", [
          { id: "post-a-n1", tenantId: "tenant-a", authorId: "author-a", title: "N1" },
          { id: "post-a-n2", tenantId: "tenant-a", authorId: "author-a", title: "N2" },
          { id: "post-a-n3", tenantId: "tenant-a", authorId: "author-a", title: "N3" },
          { id: "post-a-1", tenantId: "tenant-a", authorId: "author-a", title: "Duplicate" },
        ]),
      ).rejects.toThrow();

      await expect(
        tenantA.findMany("posts", {
          where: (builder) => builder("id", "starts with", "post-a-n"),
          select: ["id"],
        }),
      ).resolves.toEqual([]);
    }),
  );

  it.effect("fails fast when a single row exceeds the bound-parameter budget", () =>
    useBudgetHarness(8, async (orm) => {
      await expect(
        orm.createMany("wideRows", [
          {
            id: "wide-overflow",
            c1: "1",
            c2: "2",
            c3: "3",
            c4: "4",
            c5: "5",
            c6: "6",
            c7: "7",
            c8: "8",
            c9: "9",
          },
        ]),
      ).rejects.toThrow(
        'one row binds 10 bound parameters, which exceeds the 8-parameter budget',
      );

      await expect(orm.count("wideRows")).resolves.toBe(0);
    }),
  );

  it.effect("fails fast when reserved predicate parameters consume the budget", () =>
    useBudgetHarness(4, async (orm) => {
      const seed = withQueryContext(orm, makeContext(["tenant-a"], "seed"));
      await seed.createMany("authors", [{ id: "author-a", tenantId: "tenant-a", name: "Ada" }]);

      const tenantA = withQueryContext(orm, makeContext(["tenant-a"], "tenant-a"));
      // A posts row alone fits the 4-parameter budget exactly, but the update
      // policy predicate reserves one more bound parameter per statement.
      await expect(
        tenantA.upsertMany("posts", {
          target: ["id"],
          update: ["title"],
          values: [{ id: "post-a-r1", tenantId: "tenant-a", authorId: "author-a", title: "R1" }],
        }),
      ).rejects.toThrow("the predicate reserves 1 more");

      await expect(tenantA.count("posts")).resolves.toBe(0);
    }),
  );

  it.effect("applies intra-call conflicts identically on drizzle and memory adapters", () => {
    // The second value's unique target conflicts with a row created by the
    // first value in the SAME upsertMany call: both adapters must update the
    // freshly created row instead of duplicating or dropping it.
    const upsertIntraCallConflict = async (orm: TablePolicyQuery) => {
      await seedTenants(orm);
      const tenantA = withQueryContext(orm, makeContext(["tenant-a"], "tenant-a"));
      await tenantA.upsertMany("posts", {
        target: ["id"],
        update: ["title"],
        values: [
          { id: "post-a-dup", tenantId: "tenant-a", authorId: "author-a", title: "first write" },
          { id: "post-a-dup", tenantId: "tenant-a", authorId: "author-a", title: "second write" },
        ],
      });
      return tenantA.findMany("posts", {
        where: (builder) => builder("id", "=", "post-a-dup"),
        select: ["id", "title"],
      });
    };

    const expected = [{ id: "post-a-dup", title: "second write" }];

    return useHarness(async (orm) => {
      await expect(upsertIntraCallConflict(orm)).resolves.toEqual(expected);

      const memoryOrm = tablePolicyDB.client(memoryAdapter()).orm("1.0.0");
      await expect(upsertIntraCallConflict(memoryOrm)).resolves.toEqual(expected);
    });
  });

  it.effect("fails closed when a query wrapper does not forward context rebinding", () =>
    useHarness(async (orm) => {
      const wrapped = { ...orm };

      expect(() =>
        withQueryContext(wrapped, makeContext(["tenant-a"], "wrapped")),
      ).toThrow("Cannot apply query context");
    }),
  );

  it.effect(
    "rejects out-of-context writes across createMany, updateMany, upsert, upsertMany, and transactions",
    () =>
      useHarness(async (orm) => {
        await seedTenants(orm);
        const tenantAContext = makeContext(["tenant-a"], "tenant-a");
        const tenantA = withQueryContext(orm, tenantAContext);

        await expect(
          tenantA.createMany("posts", [
            {
              id: "post-a-batch",
              tenantId: "tenant-a",
              authorId: "author-a",
              title: "A batch",
            },
            {
              id: "post-b-batch",
              tenantId: "tenant-b",
              authorId: "author-b",
              title: "B batch",
            },
          ]),
        ).rejects.toThrow("tenant tenant-b is not allowed for posts");
        await expect(
          tenantA.findFirst("posts", {
            where: (builder) => builder("id", "=", "post-a-batch"),
          }),
        ).resolves.toBeNull();

        await expect(
          tenantA.updateMany("posts", {
            where: (builder) => builder("id", "=", "post-a-1"),
            set: {
              tenantId: "tenant-b",
            },
          }),
        ).rejects.toThrow("tenant tenant-b is not allowed for posts");

        await expect(
          tenantA.upsert("posts", {
            where: (builder) => builder("id", "=", "post-b-2"),
            update: {
              title: "not used",
            },
            create: {
              id: "post-b-2",
              tenantId: "tenant-b",
              authorId: "author-b",
              title: "B Two",
            },
          }),
        ).rejects.toThrow("tenant tenant-b is not allowed for posts");

        await expect(
          tenantA.upsertMany("posts", {
            target: ["id"],
            update: ["title"],
            values: [
              {
                id: "post-a-bulk-upsert",
                tenantId: "tenant-a",
                authorId: "author-a",
                title: "A bulk upsert",
              },
              {
                id: "post-b-bulk-upsert",
                tenantId: "tenant-b",
                authorId: "author-b",
                title: "B bulk upsert",
              },
            ],
          }),
        ).rejects.toThrow("tenant tenant-b is not allowed for posts");
        await expect(
          tenantA.findFirst("posts", {
            where: (builder) => builder("id", "=", "post-a-bulk-upsert"),
          }),
        ).resolves.toBeNull();

        await expect(
          tenantA.upsertMany("posts", {
            target: ["id"],
            update: ["tenantId"],
            values: [
              {
                id: "post-a-1",
                tenantId: "tenant-b",
                authorId: "author-b",
                title: "tenant move",
              },
            ],
          }),
        ).rejects.toThrow("tenant tenant-b is not allowed for posts");

        await expect(
          tenantA.transaction(async (tx) => {
            await tx.create("posts", {
              id: "post-a-transaction",
              tenantId: "tenant-a",
              authorId: "author-a",
              title: "A transaction",
            });
            await expect(tx.count("posts")).resolves.toBe(3);
            await tx.create("posts", {
              id: "post-b-transaction",
              tenantId: "tenant-b",
              authorId: "author-b",
              title: "B transaction",
            });
          }),
        ).rejects.toThrow("tenant tenant-b is not allowed for posts");

        await expect(
          tenantA.findFirst("posts", {
            where: (builder) => builder("id", "=", "post-a-transaction"),
          }),
        ).resolves.toBeNull();
        await expect(
          tenantA.findFirst("posts", {
            where: (builder) => builder("id", "=", "post-b-transaction"),
          }),
        ).resolves.toBeNull();

        expect(tenantAContext.observed).toEqual(
          expect.arrayContaining([
            "tenant-a:posts:assert",
            "tenant-a:posts:update",
            "tenant-a:posts:read",
          ]),
        );
      }),
  );
});
