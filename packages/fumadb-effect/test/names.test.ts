/**
 * Name variants: `src/schema/names.ts` and the consumer-facing builder in
 * `src/names-builder.ts` (upstream `schema/export.ts` and
 * `schema/name-variants-builder.ts`).
 */
import { Effect, Option } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/contracts/adapter.ts";
import { fumadb } from "../src/index.ts";
import {
  applyNameVariants,
  applyNameVariantsPrefix,
  exportNameVariants,
  type NameVariantsConfig,
} from "../src/contracts/schema/names.ts";
import type { AnySchema } from "../src/contracts/schema/schema.ts";
import { migrateV1, migrateV2, variantAdmin, variantBase } from "./support/schemas.ts";
import { sqlAdapter, settingsTableName } from "../src/sql.ts";

it("reads valid stored names and ignores corrupt JSON or invalid shapes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = fumadb({ namespace: "names_test", schemas: [migrateV1] }).client(
        sqlAdapter({ provider: "sqlite" }),
      );
      const migrator = yield* client.createMigrator;
      yield* (yield* migrator.migrateToLatest()).execute;
      expect(yield* migrator.nameVariants).toEqual(Option.some(exportNameVariants(migrateV1)));

      const sql = yield* SqlClient.SqlClient;
      const settings = sql(settingsTableName("names_test"));
      for (const raw of ["{", "null", "[]", '{"users":{"sql":123}}']) {
        yield* sql`update ${settings} set value = ${raw} where key = ${"name-variants"}`;
        expect(yield* migrator.nameVariants).toEqual(Option.none());
      }

      const overrides = { users: { sql: "chat_users" }, "users.id": { sql: "user_id" } };
      yield* sql`update ${settings} set value = ${JSON.stringify(overrides)} where key = ${"name-variants"}`;
      expect(yield* migrator.nameVariants).toEqual(Option.some(overrides));
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
  ));

/** Minimal adapter used only to read a factory's schemas back out. */
const inspectAdapter: Adapter<never> = {
  name: "inspect",
  createOrm: () => {
    throw new Error("the inspect adapter cannot build an ORM");
  },
  getSchemaVersion: () => Effect.succeed(Option.none()),
  createMigrator: undefined,
};

const sqlNames = (schema: AnySchema): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, names] of Object.entries(exportNameVariants(schema))) out[key] = names.sql;
  return out;
};

const schemasOf = (factory: {
  readonly client: (adapter: Adapter<never>) => { readonly schemas: ReadonlyArray<AnySchema> };
}) => factory.client(inspectAdapter).schemas;

describe("exportNameVariants", () => {
  it("exports every table and column keyed by ORM name", () => {
    expect(sqlNames(migrateV1)).toEqual({
      users: "users",
      "users.id": "id",
      "users.image": "image",
      "users.data": "data",
      accounts: "accounts",
      "accounts.id": "secret_id",
    });
  });
});

describe("applyNameVariants", () => {
  it("overrides table and column names on a copy", () => {
    const updated = applyNameVariants(migrateV1, {
      users: { sql: "chat_users" },
      "users.image": { sql: "avatar" },
    });

    expect(updated.tables["users"]?.names.sql).toBe("chat_users");
    expect(updated.tables["users"]?.columns["image"]?.names.sql).toBe("avatar");
    expect(updated.tables["users"]?.columns["data"]?.names.sql).toBe("data");
    // the input is untouched
    expect(migrateV1.tables.users.names.sql).toBe("users");
    expect(migrateV1.tables.users.columns.image.names.sql).toBe("image");
  });

  it("ignores unknown tables and columns", () => {
    const updated = applyNameVariants(migrateV1, {
      nope: { sql: "x" },
      "users.nope": { sql: "y" },
      "nope.id": { sql: "z" },
    });
    expect(sqlNames(updated)).toEqual(sqlNames(migrateV1));
  });

  it("keeps relations and foreign keys working", () => {
    const updated = applyNameVariants(migrateV2, { accounts: { sql: "chat_accounts" } });
    const key = updated.tables["users"]?.foreignKeys[0];
    expect(key?.name).toBe("users_accounts_account_fk");
    expect(key?.referencedTable.names.sql).toBe("chat_accounts");
    expect(key?.columns.map((col) => col.names.sql)).toEqual(["email"]);
    expect(Object.keys(updated.tables["users"]?.relations ?? {})).toEqual([
      "account",
      "father",
      "son",
    ]);
  });

  it("keeps the relations a variant inherited from its base schema", () => {
    const updated = applyNameVariantsPrefix(variantAdmin, "p_");
    expect(Object.keys(updated.tables["users"]?.relations ?? {})).toEqual(["role"]);
    expect(updated.tables["role"]?.foreignKeys.map((key) => key.name)).toEqual([
      "role_users_user_fk",
    ]);
    expect(updated.tables["role"]?.foreignKeys[0]?.referencedTable.names.sql).toBe("p_users");
  });

  it("can be applied twice", () => {
    const once = applyNameVariants(migrateV1, { users: { sql: "a_users" } });
    const twice = applyNameVariants(once, { "users.id": { sql: "user_id" } });
    expect(twice.tables["users"]?.names.sql).toBe("a_users");
    expect(twice.tables["users"]?.columns["id"]?.names.sql).toBe("user_id");
  });

  it("accepts an undefined override", () => {
    const config: NameVariantsConfig = { users: undefined };
    expect(sqlNames(applyNameVariants(migrateV1, config))).toEqual(sqlNames(migrateV1));
  });
});

describe("applyNameVariantsPrefix", () => {
  it("prefixes table names only", () => {
    const updated = applyNameVariantsPrefix(migrateV1, "prefix_");
    expect(sqlNames(updated)).toEqual({
      users: "prefix_users",
      "users.id": "id",
      "users.image": "image",
      "users.data": "data",
      accounts: "prefix_accounts",
      "accounts.id": "secret_id",
    });
    expect(migrateV1.tables.users.names.sql).toBe("users");
  });

  it("prefixes the current SQL name, so it composes with an override", () => {
    const renamed = applyNameVariants(migrateV1, { users: { sql: "chat_users" } });
    expect(applyNameVariantsPrefix(renamed, "p_").tables["users"]?.names.sql).toBe("p_chat_users");
  });
});

describe("the names builder on a factory", () => {
  const factory = fumadb({ namespace: "fuma_chat_", schemas: [migrateV1, migrateV2] });

  it("applies overrides to every version", () => {
    const [v1, v2] = schemasOf(factory.names({ users: { sql: "chat_users" } }));
    expect(v1?.tables["users"]?.names.sql).toBe("chat_users");
    expect(v2?.tables["users"]?.names.sql).toBe("chat_users");
    // column names are untouched
    expect(v2?.tables["users"]?.columns["email"]?.names.sql).toBe("email");
  });

  it("applies per-version overrides and keeps the other versions", () => {
    const schemas = schemasOf(factory.names(["2.0.0"], { users: { sql: "v2_users" } }));
    expect(schemas.map((s) => s.version)).toEqual(["1.0.0", "2.0.0"]);
    expect(schemas[0]?.tables["users"]?.names.sql).toBe("users");
    expect(schemas[1]?.tables["users"]?.names.sql).toBe("v2_users");
  });

  it("prefixes every table with an explicit prefix", () => {
    const schemas = schemasOf(factory.names.prefix("app_"));
    expect(schemas.map((s) => s.tables["users"]?.names.sql)).toEqual(["app_users", "app_users"]);
    expect(schemas.map((s) => s.tables["accounts"]?.names.sql)).toEqual([
      "app_accounts",
      "app_accounts",
    ]);
    expect(schemas[0]?.tables["accounts"]?.columns["id"]?.names.sql).toBe("secret_id");
  });

  it("uses the namespace when the prefix is `true`", () => {
    expect(schemasOf(factory.names.prefix(true))[0]?.tables["users"]?.names.sql).toBe(
      "fuma_chat_users",
    );
  });

  it("chains overrides and a prefix", () => {
    const schemas = schemasOf(factory.names({ users: { sql: "chat_users" } }).names.prefix("p_"));
    expect(schemas.map((s) => s.tables["users"]?.names.sql)).toEqual([
      "p_chat_users",
      "p_chat_users",
    ]);
  });

  it("leaves the original factory unchanged", () => {
    factory.names.prefix("p_");
    expect(schemasOf(factory).map((s) => s.tables["users"]?.names.sql)).toEqual(["users", "users"]);
  });

  it("keeps variant schemas separate and sorted by precedence", () => {
    const variants = fumadb({ namespace: "v", schemas: [variantBase, variantAdmin] });
    const schemas = schemasOf(variants.names.prefix("p_"));
    expect(schemas.map((s) => s.version)).toEqual(["1.0.0-admin", "1.0.0"]);
    expect(schemas[0]?.tables["role"]?.names.sql).toBe("p_role");
    expect(schemas[1]?.tables["role"]).toBeUndefined();
  });
});
