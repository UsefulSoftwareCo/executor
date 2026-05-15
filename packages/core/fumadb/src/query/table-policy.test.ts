import Database from "better-sqlite3";
import { describe, expect, it } from "@effect/vitest";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Effect } from "effect";
import { fumadb } from "fumadb";
import {
  createDrizzleRuntimeSchemaFromTables,
  createDrizzleRuntimeSchemaSqlFromTables,
  drizzleAdapter,
} from "fumadb/adapters/drizzle";
import { withQueryContext, type AbstractQuery } from "fumadb/query";
import { column, idColumn, schema, table } from "fumadb/schema";

interface TenantPolicyContext {
  readonly allowedTenantIds: ReadonlySet<string>;
  readonly deniedTables: ReadonlySet<string>;
  readonly marker: string;
  readonly observed: string[];
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

const v1 = schema({
  version: "1.0.0",
  tables: {
    authors,
    posts,
    comments,
  },
  relations: {
    authors: ({ many }) => ({
      posts: many("posts"),
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

const makeHarness = async () => {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const runtimeSchema = createDrizzleRuntimeSchemaFromTables({
    tables: v1.tables,
    namespace: "table_policy_test",
    version: "1.0.0",
    provider: "sqlite",
  });
  const drizzleDb = drizzle(sqlite, { schema: runtimeSchema });

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
    }),
  );

  return {
    orm: client.orm("1.0.0"),
    close: async () => {
      sqlite.close();
    },
  };
};

const useHarness = <A>(run: (orm: TablePolicyQuery) => Promise<A>) =>
  Effect.acquireUseRelease(
    Effect.promise(makeHarness),
    ({ orm }) => Effect.promise(() => run(orm)),
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

        await expect(
          tenantA.findMany("posts", {
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
            title: "tenant-a-upserted",
          },
          {
            id: "post-a-3",
            title: "A Three",
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

  it.effect("fails closed when a query wrapper does not forward context rebinding", () =>
    useHarness(async (orm) => {
      const wrapped = { ...orm };

      expect(() =>
        withQueryContext(wrapped, makeContext(["tenant-a"], "wrapped")),
      ).toThrow("Cannot apply query context");
    }),
  );

  it.effect(
    "rejects out-of-context writes across createMany, updateMany, upsert, and transactions",
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
