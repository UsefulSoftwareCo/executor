import { inspect } from "node:util";
import { expect, test } from "@effect/vitest";
import { fumadb, type InferFumaDB } from "../../src";
import { kyselyAdapter } from "../../src/adapters/kysely";
import {
  drizzleTests,
  initDrizzleClient,
  initPrismaClient,
  kyselyTests,
  prismaTests,
  resetDB,
} from "../shared";
import { v1 } from "./relations.schema";

const testDB = fumadb({
  schemas: [v1],
  namespace: "test",
}).names({
  posts: { prisma: "Posts" },
});

async function run(client: InferFumaDB<typeof testDB>) {
  expect(await client.version()).toBe("1.0.0");
  const orm = client.orm("1.0.0");
  const lines: string[] = [];

  lines.push("create initial records");
  await orm.createMany("users", [
    {
      id: "fuma",
      name: "fuma",
    },
    {
      id: "alfon",
      name: "alfonsus",
    },
    {
      id: "joulev",
      name: "joulev",
    },
  ]);
  await orm.createMany("posts", [
    {
      id: "1",
      authorId: "fuma",
      content: "hello world",
    },
    {
      id: "2",
      authorId: "joulev",
      relyTo: "1",
      attachmentUrl: "attachment-1",
    },
    {
      id: "3",
      authorId: "alfon",
      content: "hehe",
    },
  ]);
  await orm.createMany("attachments", [
    {
      id: "1",
      url: "attachment-1",
      data: new Uint8Array([1, 2, 3, 4]),
    },
  ]);

  lines.push("get initial records");
  lines.push(
    inspect(await orm.findMany("users", { orderBy: ["id", "asc"] }), {
      depth: null,
      sorted: true,
    })
  );
  lines.push(
    inspect(await orm.findMany("posts"), { depth: null, sorted: true })
  );
  lines.push(
    inspect(await orm.findMany("attachments"), { depth: null, sorted: true })
  );

  lines.push("delete alfon, his posts should also be deleted");
  // deleting posts only works because it is not relied by any posts
  await orm.deleteMany("users", {
    where: (b) => b("id", "=", "alfon"),
  });
  lines.push(
    inspect(await orm.findMany("posts"), { depth: null, sorted: true })
  );

  lines.push(
    "update attachment url of post 2, attachment url should also be updated"
  );
  await orm.updateMany("posts", {
    where: (b) => b("id", "=", "2"),
    set: {
      attachmentUrl: "attachment-1-updated",
    },
  });
  lines.push(
    inspect(await orm.findMany("attachments"), { depth: null, sorted: true })
  );

  lines.push("delete post, attachment should also be deleted");
  await orm.deleteMany("posts", {
    where: (b) => b("id", "=", "2"),
  });
  lines.push(
    inspect(await orm.findMany("attachments"), { depth: null, sorted: true })
  );

  await expect(() =>
    orm.createMany("likes", [
      {
        postId: "1",
        userId: "fuma",
      },
      {
        postId: "1",
        userId: "fuma",
      },
    ])
  ).rejects.toThrowError();

  return lines.join("\n");
}

test.each(kyselyTests)("query relations: kysely $provider", async (item) => {
  await resetDB(item.provider);

  const client = testDB.client(
    kyselyAdapter({
      db: item.db,
      provider: item.provider,
    })
  );

  await client
    .createMigrator()
    .migrateToLatest()
    .then((res) => res.execute());

  await expect(await run(client)).toMatchFileSnapshot("relations.output.txt");
});

test.each(drizzleTests)(
  "query relations: drizzle ($provider)",
  async (item) => {
    await resetDB(item.provider);
    const client = await initDrizzleClient(testDB, "1.0.0", item.provider);

    await expect(await run(client)).toMatchFileSnapshot("relations.output.txt");
  }
);

test.each(prismaTests)(
  "query relations: prisma ($provider)",
  { timeout: Infinity },
  async (item) => {
    const client = await initPrismaClient(testDB, "1.0.0", item.provider);

    await expect(await run(client)).toMatchFileSnapshot("relations.output.txt");
  }
);
