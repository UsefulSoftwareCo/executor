/**
 * The schema diff (`src/migration/diff.ts`, upstream
 * `src/migration-engine/auto-from-schema.ts`).
 *
 * The fixtures are upstream's `test/migrate.test.ts` v1..v4 schemas. The
 * expected operation lists match the statements in
 * `test/snapshots/upstream/migration/kysely.<provider>-from-schema.sql`, minus
 * the per-version table prefix that the upstream test applied.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { generateMigrationFromSchema } from "../src/implementation/migration/diff.ts";
import type { ColumnOperation, MigrationOperation } from "../src/contracts/migration-operation.ts";
import { type Provider, providers } from "../src/contracts/provider.ts";
import { applyNameVariantsPrefix } from "../src/contracts/schema/names.ts";
import { column, idColumn, schema, table, variantSchema } from "../src/schema.ts";
import type { AnySchema } from "../src/contracts/schema/schema.ts";
import { migrateV1, migrateV2, migrateV3, migrateV4 } from "./support/schemas.ts";

const v1: AnySchema = migrateV1;
const v2: AnySchema = migrateV2;
const v3: AnySchema = migrateV3;
const v4: AnySchema = migrateV4;
const empty: AnySchema = schema({ version: "0.0.0", tables: {} });

const describeColumnAction = (action: ColumnOperation): string => {
  switch (action.type) {
    case "create-column":
      return `create ${action.value.names.sql}`;
    case "drop-column":
      return `drop ${action.name}`;
    case "rename-column":
      return `rename ${action.from}->${action.to}`;
    case "update-column":
      return `update ${action.name}${action.updateDataType ? " type" : ""}${action.updateDefault ? " default" : ""}${
        action.updateNullable ? " nullable" : ""
      }`;
  }
};

/** A readable one-line form of an operation, used for whole-list assertions. */
const describeOperation = (op: MigrationOperation): string => {
  switch (op.type) {
    case "create-table":
      return `create-table ${op.value.names.sql}${op.skipForeignKeys === true ? " [skipForeignKeys]" : ""}`;
    case "drop-table":
      return `drop-table ${op.name}`;
    case "rename-table":
      return `rename-table ${op.from}->${op.to}`;
    case "update-table":
      return `update-table ${op.name} [${op.value.map(describeColumnAction).join(", ")}]`;
    case "add-foreign-key":
      return `add-foreign-key ${op.table}.${op.value.name}`;
    case "drop-foreign-key":
      return `drop-foreign-key ${op.table}.${op.name}`;
    case "add-unique-constraint":
      return `add-unique ${op.table}.${op.name} (${op.columns.join(",")})`;
    case "drop-unique-constraint":
      return `drop-unique ${op.table}.${op.name}`;
    case "custom":
      return `custom ${op.sql}`;
  }
};

const describeAll = (ops: ReadonlyArray<MigrationOperation>): Array<string> =>
  ops.map(describeOperation);

/** MySQL, PostgreSQL, and CockroachDB batch column changes into one `ALTER TABLE`. */
const batchesColumnActions = (provider: Provider): boolean =>
  provider === "mysql" || provider === "postgresql" || provider === "cockroachdb";

/** MSSQL defaults to `relationMode: "fumadb"`, so it never creates a real foreign key. */
const usesForeignKeys = (provider: Provider): boolean => provider !== "mssql";

const updateTable = (
  provider: Provider,
  name: string,
  actions: ReadonlyArray<string>,
): Array<string> =>
  batchesColumnActions(provider)
    ? [`update-table ${name} [${actions.join(", ")}]`]
    : actions.map((action) => `update-table ${name} [${action}]`);

const v2UsersAdditions = [
  "create name",
  "create email",
  "update image type default",
  "create string",
  "create bigint",
  "create integer",
  "create decimal",
  "create bool",
  "create json",
  "create binary",
  "create date",
  "create timestamp",
  "create fatherId",
];

const v2OnlyUsersColumns = [
  "string",
  "bigint",
  "integer",
  "decimal",
  "bool",
  "json",
  "binary",
  "date",
  "timestamp",
  "fatherId",
];

/** Dropping a table or a column is opt-in, so the tests that assert it ask for it. */
const dropping = (provider: Provider) =>
  ({ provider, dropUnusedColumns: true, dropUnusedTables: true }) as const;

describe.each(providers)("provider %s", (provider) => {
  it("creates every table from an empty database", () => {
    const ops = generateMigrationFromSchema(empty, v2, { provider });
    expect(describeAll(ops)).toEqual(
      provider === "cockroachdb"
        ? [
            // CockroachDB cannot reference a table created in the same transaction.
            "create-table users [skipForeignKeys]",
            "create-table accounts [skipForeignKeys]",
            "add-foreign-key users.users_accounts_account_fk",
            "add-foreign-key users.users_users_father_fk",
          ]
        : ["create-table users", "create-table accounts"],
    );
  });

  it("1.0.0 -> 2.0.0 adds columns, unique constraints, foreign keys, then drops the unused column", () => {
    const ops = generateMigrationFromSchema(v1, v2, dropping(provider));
    expect(describeAll(ops)).toEqual([
      ...updateTable(provider, "users", v2UsersAdditions),
      "add-unique users.unique_c_users_email (email)",
      "add-unique users.unique_c_users_fatherId (fatherId)",
      ...updateTable(provider, "accounts", ["create email"]),
      "add-unique accounts.unique_c_accounts_email (email)",
      ...(usesForeignKeys(provider)
        ? [
            "add-foreign-key users.users_accounts_account_fk",
            "add-foreign-key users.users_users_father_fk",
          ]
        : []),
      "update-table users [drop data]",
    ]);
  });

  it("2.0.0 -> 3.0.0 drops foreign keys first and columns last", () => {
    const ops = generateMigrationFromSchema(v2, v3, dropping(provider));
    expect(describeAll(ops)).toEqual([
      "drop-foreign-key users.users_accounts_account_fk",
      "drop-foreign-key users.users_users_father_fk",
      // MySQL cannot store a default for a `text` column, so its default never changes.
      ...(provider === "mysql" ? [] : updateTable(provider, "users", ["update image default"])),
      "drop-unique users.unique_c_users_email",
      "drop-unique users.unique_c_users_fatherId",
      ...updateTable(provider, "accounts", ["update email default"]),
      "add-unique accounts.id_email_uk (secret_id,email)",
      "drop-unique accounts.unique_c_accounts_email",
      ...v2OnlyUsersColumns.map((name) => `update-table users [drop ${name}]`),
    ]);
  });

  it("3.0.0 -> 4.0.0 converts data types and drops the unused table last", () => {
    const ops = generateMigrationFromSchema(v3, v4, dropping(provider));
    expect(describeAll(ops)).toEqual([
      ...updateTable(provider, "users", ["update name type", "update image type"]),
      "update-table users [drop email]",
      "drop-table accounts",
    ]);
  });

  it("puts renames and unused foreign keys before everything else", () => {
    const ops = generateMigrationFromSchema(v2, applyNameVariantsPrefix(v3, "p_"), { provider });
    expect(describeAll(ops).slice(0, 4)).toEqual([
      "drop-foreign-key users.users_accounts_account_fk",
      "drop-foreign-key users.users_users_father_fk",
      "rename-table users->p_users",
      "rename-table accounts->p_accounts",
    ]);
    // everything after the renames uses the new table names
    expect(
      describeAll(ops)
        .slice(4)
        .every((line) => !/ users| accounts/.test(line)),
    ).toBe(true);
  });

  it("drops unique constraints before the columns they cover", () => {
    const lines = describeAll(generateMigrationFromSchema(v2, v3, dropping(provider)));
    const lastDropUnique = lines.findLastIndex((line) => line.startsWith("drop-unique"));
    const firstDropColumn = lines.findIndex((line) => line.includes("[drop "));
    expect(lastDropUnique).toBeGreaterThanOrEqual(0);
    expect(firstDropColumn).toBeGreaterThan(lastDropUnique);
  });

  it("emits no foreign key operations in `fumadb` relation mode", () => {
    const steps: ReadonlyArray<readonly [AnySchema, AnySchema]> = [
      [empty, v2],
      [v1, v2],
      [v3, v4],
    ];
    for (const [from, to] of steps) {
      const ops = generateMigrationFromSchema(from, to, { provider, relationMode: "fumadb" });
      expect(ops.filter((op) => op.type === "add-foreign-key")).toEqual([]);
    }
  });

  it("never leaks the internal `enforce` marker", () => {
    const ops = generateMigrationFromSchema(v1, v2, { provider });
    expect(ops.some((op) => "enforce" in op)).toBe(false);
  });
});

describe("options", () => {
  it("drops nothing by default, so an unattended migration cannot lose data", () => {
    const lines = [
      ...describeAll(generateMigrationFromSchema(v1, v2, { provider: "postgresql" })),
      ...describeAll(generateMigrationFromSchema(v2, v3, { provider: "postgresql" })),
    ];
    expect(lines.filter((line) => line.includes("[drop "))).toEqual([]);
    expect(
      describeAll(generateMigrationFromSchema(v3, v4, { provider: "postgresql" })),
    ).not.toContain("drop-table accounts");
  });

  it("dropUnusedTables: false keeps a table that left the schema", () => {
    expect(
      describeAll(
        generateMigrationFromSchema(v3, v4, { provider: "postgresql", dropUnusedTables: false }),
      ),
    ).not.toContain("drop-table accounts");
    expect(
      describeAll(
        generateMigrationFromSchema(v3, v4, { provider: "postgresql", dropUnusedTables: true }),
      ),
    ).toContain("drop-table accounts");
  });

  it("still drops a foreign key that left the schema in `fumadb` mode", () => {
    // upstream does the same: the DDL uses `if exists`, so it is safe either way
    const ops = generateMigrationFromSchema(v2, v3, {
      provider: "postgresql",
      relationMode: "fumadb",
    });
    expect(describeAll(ops).filter((line) => line.startsWith("drop-foreign-key"))).toEqual([
      "drop-foreign-key users.users_accounts_account_fk",
      "drop-foreign-key users.users_users_father_fk",
    ]);
  });
});

describe("variant schemas", () => {
  const base = schema({
    version: "1.0.0",
    tables: {
      users: table("users", { id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))) }),
      posts: table("posts", {
        id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
        authorId: column("author_id", Schema.String.check(Schema.isMaxLength(255))),
      }),
    },
    relations: { posts: ({ one }) => ({ author: one("users", ["authorId", "id"]).foreignKey() }) },
  });

  const variant: AnySchema = variantSchema("admin", base, {
    tables: {
      users: table("app_users", {
        id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
        role: column("role", Schema.String),
      }),
    },
  });

  it("a foreign key onto a replaced table names the replacement", () => {
    // CockroachDB compiles the key into a separate `add-foreign-key`, so the
    // target name is visible in the operation list.
    const ops = generateMigrationFromSchema(empty, variant, { provider: "cockroachdb" });
    const key = ops.find((op) => op.type === "add-foreign-key");
    expect(key?.type).toBe("add-foreign-key");
    if (key?.type !== "add-foreign-key") throw new Error("expected an add-foreign-key operation");
    expect(key.value.referencedTable).toBe("app_users");
    expect(key.value.referencedColumns).toEqual(["id"]);
    expect(key.value.columns).toEqual(["author_id"]);
    expect(key.table).toBe("posts");
  });

  it("creates the replacement table, not the table it replaced", () => {
    for (const provider of providers) {
      const created = describeAll(generateMigrationFromSchema(empty, variant, { provider })).filter(
        (line) => line.startsWith("create-table"),
      );
      expect(created.some((line) => line.includes("app_users"))).toBe(true);
      expect(created.some((line) => /create-table users\b/.test(line))).toBe(false);
    }
  });
});

describe("default values", () => {
  const withDefault = (version: string, value: string) =>
    schema({
      version,
      tables: {
        users: table("users", {
          id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          bio: column("bio", Schema.String).default(value),
          title: column("title", Schema.String.check(Schema.isMaxLength(100))).default(value),
        }),
      },
    }) as AnySchema;

  it("ignores a changed `text` default on MySQL only", () => {
    const from = withDefault("1.0.0", "a");
    const to = withDefault("2.0.0", "b");

    expect(describeAll(generateMigrationFromSchema(from, to, { provider: "mysql" }))).toEqual([
      "update-table users [update title default]",
    ]);
    expect(describeAll(generateMigrationFromSchema(from, to, { provider: "postgresql" }))).toEqual([
      "update-table users [update bio default, update title default]",
    ]);
  });

  it("ignores a changed json or binary default on MySQL only", () => {
    // MySQL rejects a `DEFAULT` on `json` and `blob` exactly as it does on
    // `text`, so `src/sql/ddl.ts` never writes one and the diff must not
    // report a change. Both read `supportsLiteralDefault` in `schema/codec.ts`.
    const withBlobDefaults = (version: string, value: string) =>
      schema({
        version,
        tables: {
          users: table("users", {
            id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
            payload: column("payload", Schema.Unknown).default({ value }),
            blob: column("blob", Schema.Uint8Array).default(new TextEncoder().encode(value)),
            title: column("title", Schema.String.check(Schema.isMaxLength(100))).default(value),
          }),
        },
      }) as AnySchema;

    const from = withBlobDefaults("1.0.0", "a");
    const to = withBlobDefaults("2.0.0", "b");

    expect(describeAll(generateMigrationFromSchema(from, to, { provider: "mysql" }))).toEqual([
      "update-table users [update title default]",
    ]);
    expect(describeAll(generateMigrationFromSchema(from, to, { provider: "postgresql" }))).toEqual([
      "update-table users [update payload default, update blob default, update title default]",
    ]);
  });

  it("ignores runtime defaults, which never reach the database", () => {
    const from = schema({
      version: "1.0.0",
      tables: {
        users: table("users", {
          id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
        }),
      },
    }) as AnySchema;
    const to = schema({
      version: "2.0.0",
      tables: {
        users: table("users", { id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))) }),
      },
    }) as AnySchema;
    expect(describeAll(generateMigrationFromSchema(from, to, { provider: "postgresql" }))).toEqual(
      [],
    );
  });
});

describe("column operations", () => {
  it("renames a column before updating it, and carries the new definition", () => {
    const from = schema({
      version: "1.0.0",
      tables: {
        users: table("users", {
          id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          name: column("name", Schema.String),
        }),
      },
    }) as AnySchema;
    const to = schema({
      version: "2.0.0",
      tables: {
        users: table("users", {
          id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          name: column("full_name", Schema.NullOr(Schema.Int)),
        }),
      },
    }) as AnySchema;

    const ops = generateMigrationFromSchema(from, to, { provider: "postgresql" });
    expect(describeAll(ops)).toEqual([
      "update-table users [rename name->full_name, update full_name type nullable]",
    ]);

    const first = ops[0];
    if (first?.type !== "update-table") throw new Error("expected an update-table operation");
    const update = first.value[1];
    if (update?.type !== "update-column") throw new Error("expected an update-column action");
    expect(update.value.type).toBe("integer");
    expect(update.value.isNullable).toBe(true);
    expect(update.updateDefault).toBe(false);
  });

  it("produces nothing for identical schemas", () => {
    for (const provider of providers) {
      expect(generateMigrationFromSchema(v2, v2, { provider })).toEqual([]);
    }
  });
});

describe.each(providers)("unused required column on %s", (provider) => {
  it("dropUnusedColumns: false keeps nullable columns and makes required ones nullable", () => {
    const keeping = { provider, dropUnusedColumns: false } as const;
    // `data` is nullable, so it survives untouched
    expect(describeAll(generateMigrationFromSchema(v1, v2, keeping))).not.toContain(
      "update-table users [drop data]",
    );
    // every column removed in 3.0.0 is nullable
    expect(
      describeAll(generateMigrationFromSchema(v2, v3, keeping)).filter((line) =>
        line.includes("[drop "),
      ),
    ).toEqual([]);
    // `email` is required and has no default: it is kept and made nullable,
    // so inserts that omit it still succeed. Nothing is dropped.
    const ops = generateMigrationFromSchema(v3, v4, keeping);
    const lines = describeAll(ops);
    expect(lines.filter((line) => line.includes("[drop "))).toEqual([]);
    expect(lines).toContain("update-table users [update email nullable]");
    const alter = ops
      .flatMap((op) => (op.type === "update-table" ? op.value : []))
      .find((action) => action.type === "update-column" && action.name === "email");
    expect(alter?.type === "update-column" && alter.value.isNullable).toBe(true);
    // The source schema's column is not mutated.
    expect(v3.tables.users?.columns.email?.isNullable).toBe(false);
  });

  it("dropUnusedColumns: true drops a required column instead of altering it", () => {
    const lines = describeAll(
      generateMigrationFromSchema(v3, v4, { provider, dropUnusedColumns: true }),
    );
    expect(lines).toContain("update-table users [drop email]");
    expect(lines).not.toContain("update-table users [update email nullable]");
  });
});
