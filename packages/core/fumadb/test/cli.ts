import { cancel, confirm, isCancel } from "@clack/prompts";
import { fumadb } from "../src";
import { kyselyAdapter } from "../src/adapters/kysely";
import { createCli } from "../src/cli";
import { column, idColumn, schema, table, variantSchema } from "../src/schema";
import { kyselyTests, resetDB } from "./shared";

const v1 = schema({
  version: "1.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", "varchar(255)").defaultTo$("auto"),
      name: column("name", "string"),
    }),
    messages: table("messages", {
      id: idColumn("id", "varchar(255)").defaultTo$("auto"),
      user: column("user", "varchar(255)"),
      content: column("content", "string"),
      parent: column("parent", "varchar(255)").nullable(),
    }),
  },
  relations: {
    users: ({ many }) => ({
      messages: many("messages"),
    }),
    messages: ({ one }) => ({
      author: one("users", ["user", "id"]).foreignKey(),
    }),
  },
});

const v1Roles = variantSchema("role", v1, {
  tables: {
    roles: table("roles", {
      id: idColumn("id", "varchar(255)"),
      userId: column("user_id", "varchar(255)").unique(),
    }),
  },
  relations: {
    roles: (b) => ({
      user: b.one("users", ["userId", "id"]).foreignKey(),
    }),
    users: (b) => ({
      role: b.one("roles"),
    }),
  },
});

const v2 = schema({
  version: "2.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", "varchar(255)").defaultTo$("auto"),
      name: column("name", "string"),
      image: column("image", "binary").nullable(),
    }),
    messages: table("messages", {
      id: idColumn("id", "varchar(255)").defaultTo$("auto"),
      user: column("user", "varchar(255)"),
      content: column("content", "string"),
      parent: column("parent", "varchar(255)").nullable(),
    }),
  },
  relations: {
    users: ({ many }) => ({
      messages: many("messages"),
    }),
    messages: ({ one }) => ({
      author: one("users", ["user", "id"]).foreignKey(),
    }),
  },
});

const v2Roles = variantSchema("role", v2, {
  tables: {
    roles: table("roles", {
      id: idColumn("id", "varchar(255)"),
      userId: column("user_id", "varchar(255)").unique(),
    }),
  },
  relations: {
    roles: (b) => ({
      user: b.one("users", ["userId", "id"]).foreignKey(),
    }),
    users: (b) => ({
      role: b.one("roles"),
    }),
  },
});

const db = fumadb({
  schemas: [v1, v1Roles, v2, v2Roles],
  namespace: "test",
}).names.prefix("test_");

const test = kyselyTests[0]!;
const { main } = createCli({
  db: db.client(kyselyAdapter(test)),
  command: "my-lib",
  version: "0.0.0",
});

const isReset = await confirm({
  message: "reset db?",
});

if (isCancel(isReset)) {
  cancel("skipped cli testing");
  process.exit(0);
}

if (isReset) await resetDB(test.provider);

void main();
