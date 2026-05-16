import { inspect } from "node:util";
import { expect, test } from "@effect/vitest";
import { fumadb } from "../../src";
import { kyselyAdapter } from "../../src/adapters/kysely";
import { mongoAdapter } from "../../src/adapters/mongodb";
import type { AbstractQuery } from "../../src/query";
import {
  databases,
  drizzleTests,
  initDrizzleClient,
  initPrismaClient,
  kyselyTests,
  prismaTests,
  resetDB,
  resetMongoDB,
} from "../shared";
import { v1 } from "./query.schema";

const myDB = fumadb({
  namespace: "test",
  schemas: [v1],
})
  .names.prefix(true)
  .names({
    users: { prisma: "PrismaUser" },
    "users.id": {
      sql: "user_id",
      prisma: "UserId",
    },
  });
async function run(orm: AbstractQuery<typeof v1>): Promise<string> {
  const lines: string[] = [];

  lines.push("create one");
  lines.push(
    inspect(
      await orm.create("users", {
        id: "generated-cuid",
        name: "fuma",
      }),
      { depth: null, sorted: true },
    ),
  );
  lines.push("create other users");
  lines.push(
    inspect(
      await orm.createMany("users", [
        {
          id: "alfon",
          name: "alfon",
        },
        {
          id: "test",
          name: "Test User",
        },
      ]),
      { depth: null, sorted: true },
    ),
  );

  lines.push("initial data ready");
  await orm.createMany("messages", [
    {
      user: "alfon",
      content: "Hello World 1 by alfon",
      id: "1",
    },
    {
      user: "alfon",
      content: "Hello World 2 by alfon",
      id: "2",
      mentionId: "1",
    },
  ]);
  lines.push(
    inspect(await orm.findMany("users", { orderBy: ["id", "asc"] }), {
      depth: null,
      sorted: true,
    }),
    inspect(await orm.findMany("messages", { orderBy: ["id", "asc"] }), {
      depth: null,
      sorted: true,
    }),
  );

  lines.push("test joins: user -> messages -> mentioned by");
  lines.push(
    inspect(
      await orm.findMany("users", {
        orderBy: ["id", "asc"],
        join: (b) =>
          b.messages({
            orderBy: ["id", "asc"],
            join: (b) =>
              b.mentionedBy({
                join: (b) => b.author(),
              }),
          }),
      }),
      { depth: null, sorted: true },
    ),
  );

  lines.push("test joins: user -> messages (conditional) -> author");
  lines.push(
    inspect(
      await orm.findMany("users", {
        orderBy: ["id", "asc"],
        join: (b) =>
          b.messages({
            orderBy: ["id", "asc"],
            select: ["content"],
            limit: 1,
            where: (b) => b("content", "contains", "alfon"),
            join: (b) => b.author(),
          }),
      }),
      { depth: null, sorted: true },
    ),
  );

  lines.push(`count users: ${await orm.count("users")}`);

  const getBob = () =>
    orm.findFirst("users", { where: (b) => b("id", "=", "bob") });
  const upsertBob = (v: string) =>
    orm.upsert("users", {
      where: (b) => b("id", "=", "bob"),
      create: { id: "bob", name: v },
      update: { name: v },
    });

  lines.push("upsert bob: should be created as sad");
  await upsertBob("Bob is sad");
  lines.push(inspect(await getBob(), { depth: null, sorted: true }));

  lines.push("upsert bob: should be updated to happy");
  await upsertBob("Bob is happy");
  lines.push(inspect(await getBob(), { depth: null, sorted: true }));

  lines.push("insert with binary data");
  lines.push(
    inspect(
      await orm.create("messages", {
        id: "image-test",
        user: "alfon",
        content: "test",
        image: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      }),
      { depth: null, sorted: true },
    ),
  );

  await orm
    .transaction(async (tx) => {
      await tx.createMany("messages", [
        {
          id: "transaction-1",
          user: "alfon",
          content: "test message",
        },
        {
          id: "transaction-2",
          user: "bob",
          content: "haha",
        },
      ]);

      await tx.deleteMany("messages", {
        where: (b) => b("id", "=", "image-test"),
      });

      lines.push("should be able to select affected records in transaction");
      lines.push(
        inspect(
          await tx.findMany("messages", {
            orderBy: ["id", "asc"],
          }),
          { depth: null, sorted: true },
        ),
      );

      throw new Error("Rollback!");
    })
    .catch((e: Error) => {
      expect(e.message).toBe("Rollback!");
    });

  lines.push("after rollback, the changes should not be kept");

  lines.push(
    inspect(
      await orm.findMany("messages", {
        orderBy: ["id", "asc"],
      }),
      { depth: null, sorted: true },
    ),
  );

  await expect(
    orm.create("messages", {
      user: "invalid",
      id: "invalid-message",
    }),
  ).rejects.toThrowError();

  return lines.join("\n");
}

test.each(kyselyTests)(
  "query kysely ($provider)",
  { timeout: Infinity },
  async (item) => {
    await resetDB(item.provider);
    const client = myDB.client(
      kyselyAdapter({
        db: item.db,
        provider: item.provider,
      }),
    );

    const migrator = await client.createMigrator();
    await migrator.migrateToLatest().then((res) => res.execute());

    const result = await run(client.orm("1.0.0"));
    await expect(result).toMatchFileSnapshot(`query.output.txt`);
  },
);

test("query mongodb", { timeout: Infinity }, async () => {
  const mongodb = databases.find((db) => db.provider === "mongodb")!.create();
  await mongodb.connect();
  await resetMongoDB(mongodb);

  const instance = myDB.client(
    mongoAdapter({
      client: mongodb,
    }),
  );

  await expect(await run(instance.orm("1.0.0"))).toMatchFileSnapshot(
    "query.output.txt",
  );
  await mongodb.close();
});

test.each(drizzleTests)("query drizzle ($provider)", async (item) => {
  await resetDB(item.provider);
  const client = await initDrizzleClient(myDB, "1.0.0", item.provider);

  await expect(await run(client.orm("1.0.0"))).toMatchFileSnapshot(
    "query.output.txt",
  );
});

test.each(prismaTests)(
  "query prisma ($provider)",
  { timeout: Infinity },
  async (item) => {
    const client = await initPrismaClient(myDB, "1.0.0", item.provider);

    await expect(await run(client.orm("1.0.0"))).toMatchFileSnapshot(
      "query.output.txt",
    );
  },
);

test.each(prismaTests)(
  "prisma getSchemaVersion should not cause unique constraint violation on concurrent calls ($provider)",
  { timeout: Infinity },
  async (item) => {
    const client = await initPrismaClient(myDB, "1.0.0", item.provider);

    // Call version() multiple times concurrently
    // This should not cause unique constraint violation
    const concurrentCalls = Array(10)
      .fill(null)
      .map(() => client.version());

    const results = await Promise.all(concurrentCalls);

    // All calls should return the same version without errors
    for (const result of results) {
      expect(result).toBe("1.0.0");
    }
  },
);

test.each(kyselyTests)(
  "json column with empty object - kysely ($provider)",
  { timeout: Infinity },
  async (item) => {
    await resetDB(item.provider);
    const client = myDB.client(
      kyselyAdapter({
        db: item.db,
        provider: item.provider,
      }),
    );

    const migrator = await client.createMigrator();
    await migrator.migrateToLatest().then((res) => res.execute());

    const orm = client.orm("1.0.0");

    // Test 1: Insert with empty object metadata
    const result1 = await orm.create("posts", {
      id: "00000000-0000-0000-0000-000000000001",
      title: "Post with empty metadata",
      metadata: {},
    });

    expect(result1).toEqual({
      id: "00000000-0000-0000-0000-000000000001",
      title: "Post with empty metadata",
      metadata: {},
    });

    // Test 2: createMany with empty objects
    await orm.createMany("posts", [
      {
        id: "00000000-0000-0000-0000-000000000002",
        title: "Post 2",
        metadata: {},
      },
      {
        id: "00000000-0000-0000-0000-000000000003",
        title: "Post 3",
        metadata: { views: 100 },
      },
    ]);

    const all = await orm.findMany("posts", {
      orderBy: ["id", "asc"],
    });

    expect(all).toHaveLength(3);
    expect(all[0]?.metadata).toEqual({});
    expect(all[1]?.metadata).toEqual({});
    expect(all[2]?.metadata).toEqual({ views: 100 });
  },
);
