import { expect, test } from "@effect/vitest";
import * as Drizzle from "../src/adapters/drizzle/generate";
import * as Prisma from "../src/adapters/prisma/generate";
import * as TypeORM from "../src/adapters/typeorm/generate";
import { column, idColumn, schema, table } from "../src/schema";

test("idColumn accepts uuid type", () => {
  const col = idColumn("id", "uuid");
  expect(col.type).toBe("uuid");
  expect(col.id).toBe(true);
});

test("column accepts uuid type", () => {
  const col = column("token", "uuid");
  expect(col.type).toBe("uuid");
});

test("schema with UUID id column", () => {
  const s = schema({
    version: "1.0.0",
    tables: {
      users: table("users", {
        id: idColumn("id", "uuid"),
        name: column("name", "string"),
      }),
    },
  });

  expect(s.tables.users.getIdColumn().type).toBe("uuid");
});

test("schema with UUID regular column", () => {
  const s = schema({
    version: "1.0.0",
    tables: {
      sessions: table("sessions", {
        id: idColumn("id", "varchar(255)").defaultTo$("auto"),
        sessionToken: column("session_token", "uuid").nullable(),
      }),
    },
  });

  expect(s.tables.sessions.columns.sessionToken.type).toBe("uuid");
});

// Test schema generation for different adapters
const uuidSchema = schema({
  version: "1.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", "uuid"),
      email: column("email", "varchar(255)"),
      sessionToken: column("session_token", "uuid").nullable(),
    }),
  },
});

test("Prisma PostgreSQL generates UUID schema correctly", () => {
  const generated = Prisma.generateSchema(uuidSchema, "postgresql");

  expect(generated).toContain("id String @db.Uuid @id");
  expect(generated).toContain("sessionToken String? @map(\"session_token\") @db.Uuid");
});

test("Prisma MySQL generates UUID schema correctly", () => {
  const generated = Prisma.generateSchema(uuidSchema, "mysql");

  expect(generated).toContain("id String @id");
  expect(generated).toContain("sessionToken String? @map(\"session_token\")");
});

test("Drizzle PostgreSQL generates UUID schema correctly", () => {
  const generated = Drizzle.generateSchema(uuidSchema, "postgresql");

  expect(generated).toContain("uuid(");
  expect(generated).toContain("primaryKey()");
});

test("Drizzle MySQL generates UUID schema correctly", () => {
  const generated = Drizzle.generateSchema(uuidSchema, "mysql");

  expect(generated).toContain('char("id", { length: 36 })');
  expect(generated).toContain("primaryKey()");
});

test("Drizzle SQLite generates UUID schema correctly", () => {
  const generated = Drizzle.generateSchema(uuidSchema, "sqlite");

  expect(generated).toContain('text("id")');
  expect(generated).toContain("primaryKey()");
});

test("TypeORM generates UUID schema correctly", () => {
  const generated = TypeORM.generateSchema(uuidSchema, "postgresql");

  expect(generated).toContain('type: "uuid"');
});

// Test mixing UUID and CUID2
const mixedSchema = schema({
  version: "1.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", "uuid"),
      name: column("name", "string"),
    }),
    posts: table("posts", {
      id: idColumn("id", "varchar(255)").defaultTo$("auto"),
      authorId: column("author_id", "uuid"),
      content: column("content", "string"),
    }),
  },
});

test("schema can mix UUID and CUID2 IDs", () => {
  expect(mixedSchema.tables.users.getIdColumn().type).toBe("uuid");
  expect(mixedSchema.tables.posts.getIdColumn().type).toBe("varchar(255)");
  expect(mixedSchema.tables.posts.columns.authorId.type).toBe("uuid");
});

test("Prisma generates mixed UUID and CUID2 schema correctly", () => {
  const generated = Prisma.generateSchema(mixedSchema, "postgresql");

  expect(generated).toContain("@db.Uuid");
  expect(generated).toContain("@default(cuid())");
});
