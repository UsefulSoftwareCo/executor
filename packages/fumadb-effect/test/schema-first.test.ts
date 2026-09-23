/**
 * Schema-first tables: storage inference from Effect schemas, derived row /
 * insert / update structs, and schema-driven encoding.
 */
import { it } from "@effect/vitest";
import { DateTime, Effect, Option, Result, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { describe, expect } from "vitest";
import { SchemaDefinitionError } from "../src/contracts/errors.ts";
import { deserialize, serialize } from "../src/implementation/schema-codec.ts";
import { applyNameVariants, column, idColumn, schema, table } from "../src/schema.ts";
import { Condition, createBuilder } from "../src/contracts/condition.ts";
import { buildWhere } from "../src/implementation/sql/where.ts";
import { SqliteClient } from "@effect/sql-sqlite-node";
import type { Statement } from "effect/unstable/sql";
import { inferStorageType, schemaForStorageType } from "../src/contracts/schema/storage.ts";

const UserId = Schema.String.pipe(Schema.brand("UserId"));

/** Compile a condition against an in-memory SQLite client, returning `[sql, params]`. */
const buildWhereText = (
  condition: Condition,
): Result.Result<readonly [string, ReadonlyArray<unknown>], unknown> =>
  Effect.runSync(
    Effect.gen(function* () {
      const sql = yield* SqliteClient.make({ filename: ":memory:" });
      return Result.map(buildWhere(condition, sql, "sqlite"), (fragment: Statement.Fragment) =>
        sql`${fragment}`.compile(),
      );
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );

describe("storage inference", () => {
  const cases: ReadonlyArray<readonly [string, Schema.Top, string, boolean]> = [
    ["String", Schema.String, "string", false],
    ["NonEmptyString", Schema.NonEmptyString, "string", false],
    ["brand", UserId, "string", false],
    ["isMaxLength", Schema.String.check(Schema.isMaxLength(64)), "varchar(64)", false],
    ["isUUID", Schema.String.check(Schema.isUUID()), "uuid", false],
    ["Int", Schema.Int, "integer", false],
    ["Number", Schema.Number, "decimal", false],
    ["BigInt", Schema.BigInt, "bigint", false],
    ["Boolean", Schema.Boolean, "bool", false],
    ["Date", Schema.Date, "timestamp", false],
    ["DateTimeUtcFromDate", Schema.DateTimeUtcFromDate, "timestamp", false],
    ["Uint8Array", Schema.Uint8Array, "binary", false],
    ["Struct", Schema.Struct({ a: Schema.Number }), "json", false],
    ["Array", Schema.Array(Schema.String), "json", false],
    ["Unknown", Schema.Unknown, "json", false],
    ["Literals", Schema.Literals(["a", "b"]), "string", false],
    ["NullOr(String)", Schema.NullOr(Schema.String), "string", true],
    ["NullOr(Int)", Schema.NullOr(Schema.Int), "integer", true],
    ["NullOr(brand)", Schema.NullOr(UserId), "string", true],
    ["NullOr(Struct)", Schema.NullOr(Schema.Struct({ a: Schema.Number })), "json", true],
    ["Union(String, Number)", Schema.Union([Schema.String, Schema.Number]), "json", false],
  ];
  for (const [label, s, type, nullable] of cases) {
    it(`${label} -> ${type}${nullable ? " (nullable)" : ""}`, () => {
      expect(inferStorageType(s)).toEqual({ type, nullable });
    });
  }

  it("an explicit type overrides the inference", () => {
    expect(column("d", Schema.Date, { type: "date" }).type).toBe("date");
    expect(column("c", Schema.String, { type: "varchar(32)" }).type).toBe("varchar(32)");
  });

  it("id columns default a plain string to varchar(255) and reject other types", () => {
    expect(idColumn("id", Schema.String).type).toBe("varchar(255)");
    expect(idColumn("id", UserId).type).toBe("varchar(255)");
    expect(idColumn("id", Schema.String.check(Schema.isUUID())).type).toBe("uuid");
    expect(() => idColumn("id", Schema.Int)).toThrow(SchemaDefinitionError);
    expect(() => idColumn("id", Schema.NullOr(Schema.String))).toThrow(SchemaDefinitionError);
  });

  it("generated() and now() check the storage type", () => {
    expect(() => column("n", Schema.Int).generated()).toThrow(SchemaDefinitionError);
    expect(() => column("s", Schema.String).now()).toThrow(SchemaDefinitionError);
  });

  it("schemaForStorageType round-trips through inferStorageType", () => {
    for (const type of [
      "string",
      "varchar(10)",
      "uuid",
      "integer",
      "decimal",
      "bigint",
      "bool",
      "json",
      "binary",
      "timestamp",
    ] as const) {
      expect(inferStorageType(schemaForStorageType(type, false)).type).toBe(type);
      expect(inferStorageType(schemaForStorageType(type, true))).toEqual({ type, nullable: true });
    }
  });
});

describe("derived structs", () => {
  const users = table("users", {
    id: idColumn("id", UserId).generated(),
    name: column("name", Schema.String),
    email: column("email", Schema.NullOr(Schema.String)),
    age: column("age", Schema.Int).default(0),
    createdAt: column("created_at", Schema.DateTimeUtcFromDate).now(),
  });

  it("row has every column", () => {
    expect(Object.keys(users.row.fields).sort()).toEqual([
      "age",
      "createdAt",
      "email",
      "id",
      "name",
    ]);
    const decoded = Schema.decodeUnknownSync(users.row)({
      id: "u1",
      name: "n",
      email: null,
      age: 1,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    expect(DateTime.isDateTime(decoded.createdAt)).toBe(true);
  });

  it("insert makes defaulted and nullable columns optional", () => {
    const decode = Schema.decodeUnknownSync(users.insert);
    expect(decode({ name: "n" })).toEqual({ name: "n" });
    expect(() => decode({})).toThrow();
    const typed: typeof users.insert.Type = { name: "n" };
    void typed;
  });

  it("update omits the id and makes everything optional", () => {
    expect(Object.keys(users.update.fields).sort()).toEqual(["age", "createdAt", "email", "name"]);
    expect(Schema.decodeUnknownSync(users.update)({})).toEqual({});
  });
});

describe("schema-driven codec", () => {
  const t = table("t", {
    id: idColumn("id", Schema.String),
    when: column("when", Schema.DateTimeUtcFromDate),
    theme: column("theme", Schema.Literals(["light", "dark"])),
    settings: column("settings", Schema.Struct({ size: Schema.Int })),
  });

  it("encodes through the column schema before the driver encoding", () => {
    const now = DateTime.makeUnsafe("2024-05-06T07:08:09.010Z");
    expect(serialize(now, t.columns.when, "sqlite")).toEqual(
      Result.succeed(new Date("2024-05-06T07:08:09.010Z").getTime()),
    );
    expect(serialize(now, t.columns.when, "mysql")).toEqual(
      Result.succeed("2024-05-06 07:08:09.010"),
    );
    expect(serialize({ size: 3 }, t.columns.settings, "postgresql")).toEqual(
      Result.succeed('{"size":3}'),
    );
  });

  it("rejects a value the column schema does not accept, as InvalidInput", () => {
    const bad = serialize("blue", t.columns.theme, "sqlite");
    expect(Result.isFailure(bad) && bad.failure.reason).toBe("InvalidInput");
    const badStruct = serialize({ size: 1.5 }, t.columns.settings, "sqlite");
    expect(Result.isFailure(badStruct) && badStruct.failure.column).toBe("settings");
  });

  it("decodes through the column schema after the driver decoding", () => {
    const decoded = deserialize(1_700_000_000_000, t.columns.when, "sqlite");
    expect(Result.isSuccess(decoded) && DateTime.isDateTime(decoded.success)).toBe(true);
    expect(deserialize('{"size":3}', t.columns.settings, "sqlite")).toEqual(
      Result.succeed({ size: 3 }),
    );
  });

  it("rejects a stored value the column schema does not accept, as Decode", () => {
    const bad = deserialize('{"size":"x"}', t.columns.settings, "sqlite");
    expect(Result.isFailure(bad) && bad.failure.reason).toBe("Decode");
    const badLiteral = deserialize("blue", t.columns.theme, "postgresql");
    expect(Result.isFailure(badLiteral) && badLiteral.failure.reason).toBe("Decode");
  });

  it.effect("now() produces a value of the column's Type (a DateTime here)", () =>
    Effect.gen(function* () {
      const col = column("at", Schema.DateTimeUtcFromDate).now();
      const value = yield* col.generateDefault();
      expect(DateTime.isDateTime(value)).toBe(true);
    }),
  );
});

describe("schema() with Schema-first tables", () => {
  it("keeps derived structs on cloned tables", () => {
    const s = schema({
      version: "1.0.0",
      tables: {
        t: table("t", { id: idColumn("id", Schema.String), n: column("n", Schema.Int).default(1) }),
      },
    });
    const cloned = s.clone();
    expect(Object.keys(cloned.tables.t.insert.fields)).toEqual(["id", "n"]);
    expect(Schema.decodeUnknownSync(cloned.tables.t.insert)({ id: "a" })).toEqual({ id: "a" });
  });
});

describe("constant defaults on transforming columns", () => {
  it("keeps the Type-side value for inserts and the Encoded-side value for DDL", () => {
    const when = DateTime.makeUnsafe("2024-05-06T07:08:09.010Z");
    const col = column("when", Schema.DateTimeUtcFromDate).default(when);
    expect(col.defaultValue).toEqual({
      _tag: "Value",
      value: when,
      encoded: new Date("2024-05-06T07:08:09.010Z"),
    });
    const json = column(
      "prefs",
      Schema.Struct({ theme: Schema.Literals(["light", "dark"]) }),
    ).default({ theme: "light" });
    expect(json.defaultValue?._tag === "Value" && json.defaultValue.encoded).toEqual({
      theme: "light",
    });
  });

  it("rejects a default the column schema does not accept", () => {
    expect(() =>
      column("theme", Schema.Literals(["light", "dark"])).default("blue" as never),
    ).toThrow(SchemaDefinitionError);
  });
});

describe("storage inference edge cases", () => {
  it("rejects schemas that cannot be a column", () => {
    expect(() => inferStorageType(Schema.optionalKey(Schema.String))).toThrow(
      SchemaDefinitionError,
    );
    expect(() => inferStorageType(Schema.Undefined)).toThrow(SchemaDefinitionError);
    expect(() => inferStorageType(Schema.Never)).toThrow(SchemaDefinitionError);
    expect(() => inferStorageType(Schema.Option(Schema.String))).toThrow(/OptionFromNullOr/);
  });

  it("stores literal unions by the literal type and flattens nested unions", () => {
    expect(inferStorageType(Schema.Literals([1, 2]))).toEqual({ type: "integer", nullable: false });
    expect(inferStorageType(Schema.Literals([1, 2.5]))).toEqual({
      type: "decimal",
      nullable: false,
    });
    expect(inferStorageType(Schema.Literal(true))).toEqual({ type: "bool", nullable: false });
    expect(inferStorageType(Schema.NullOr(Schema.NullOr(Schema.String)))).toEqual({
      type: "string",
      nullable: true,
    });
    expect(inferStorageType(Schema.UndefinedOr(Schema.String))).toEqual({
      type: "string",
      nullable: true,
    });
    expect(inferStorageType(Schema.OptionFromNullOr(Schema.Int))).toEqual({
      type: "integer",
      nullable: true,
    });
    expect(inferStorageType(Schema.Union([Schema.Literal("a"), Schema.Number]))).toEqual({
      type: "json",
      nullable: false,
    });
  });

  it("transformations to text or numbers store as their encoded side", () => {
    expect(inferStorageType(Schema.DateTimeUtcFromString).type).toBe("string");
    expect(inferStorageType(Schema.DateFromMillis).type).toBe("integer");
    expect(inferStorageType(Schema.Uint8ArrayFromBase64).type).toBe("string");
  });
});

describe("OptionFromNullOr columns", () => {
  const t = table("t", {
    id: idColumn("id", Schema.String),
    note: column("note", Schema.OptionFromNullOr(Schema.String)),
  });

  it("decodes NULL to Option.none() and a value to Option.some()", () => {
    expect(deserialize(null, t.columns.note, "postgresql")).toEqual(Result.succeed(Option.none()));
    expect(deserialize("x", t.columns.note, "postgresql")).toEqual(
      Result.succeed(Option.some("x")),
    );
  });

  it("encodes Option.none() to NULL and Option.some() to the value", () => {
    expect(serialize(Option.none(), t.columns.note, "postgresql")).toEqual(Result.succeed(null));
    expect(serialize(Option.some("x"), t.columns.note, "postgresql")).toEqual(Result.succeed("x"));
  });

  it("a NULL in a non-nullable column stays null instead of failing", () => {
    const strict = table("s", {
      id: idColumn("id", Schema.String),
      name: column("name", Schema.String),
    });
    expect(deserialize(null, strict.columns.name, "sqlite")).toEqual(Result.succeed(null));
  });
});

describe("foreign key storage types", () => {
  it("a referencing column adopts the referenced key's width when its type was inferred", () => {
    const UserId = Schema.String.pipe(Schema.brand("UserId"));
    const s = schema({
      version: "1.0.0",
      tables: {
        users: table("users", { id: idColumn("id", UserId).generated() }),
        posts: table("posts", {
          id: idColumn("id", Schema.String),
          author: column("author", UserId),
        }),
      },
      relations: { posts: ({ one }) => ({ writer: one("users", ["author", "id"]).foreignKey() }) },
    });
    expect(s.tables.users.columns.id.type).toBe("varchar(255)");
    expect(s.tables.posts.columns.author.type).toBe("varchar(255)");
    expect(s.clone().tables.posts.columns.author.type).toBe("varchar(255)");
  });

  it("an explicit { type } on the referencing column is kept and validated", () => {
    expect(() =>
      schema({
        version: "1.0.0",
        tables: {
          users: table("users", { id: idColumn("id", Schema.String) }),
          posts: table("posts", {
            id: idColumn("id", Schema.String),
            author: column("author", Schema.String, { type: "string" }),
          }),
        },
        relations: {
          posts: ({ one }) => ({ writer: one("users", ["author", "id"]).foreignKey() }),
        },
      }),
    ).toThrow(/stored as string but references/);
  });

  it.effect("generated() on a uuid column produces a UUID that the schema accepts", () =>
    Effect.gen(function* () {
      const col = idColumn("id", Schema.String.check(Schema.isUUID())).generated();
      const id = yield* col.generateDefault();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }),
  );
});

describe("review findings", () => {
  it("a LIKE fragment is not validated as a whole value of a refined column", () => {
    // the builder accepts any string for string operators
    const t = table("t", {
      id: idColumn("id", Schema.String),
      theme: column("theme", Schema.Literals(["light", "dark"])),
    });
    const built = createBuilder(t.columns)("theme", "contains", "ar");
    expect(built._tag).toBe("Compare");
  });

  it("Option.none() in a where compares like null", () => {
    const t = table("t", {
      id: idColumn("id", Schema.String),
      note: column("note", Schema.OptionFromNullOr(Schema.String)),
    });
    const [sql] = Result.getOrThrow(
      buildWhereText(
        Condition.Compare({ column: t.columns.note, operator: "is", value: Option.none() }),
      ),
    );
    expect(sql).toContain("IS NULL");
    const [eq] = Result.getOrThrow(
      buildWhereText(
        Condition.Compare({ column: t.columns.note, operator: "=", value: Option.none() }),
      ),
    );
    expect(eq).toContain("NULL");
  });

  it("a bigint outside the 64-bit range is a typed InvalidInput on every provider", () => {
    const t = table("t", { id: idColumn("id", Schema.String), big: column("big", Schema.BigInt) });
    for (const provider of ["sqlite", "postgresql", "mysql", "mssql", "cockroachdb"] as const) {
      const out = serialize(2n ** 63n, t.columns.big, provider);
      expect(Result.isFailure(out) && out.failure.reason).toBe("InvalidInput");
      expect(Result.isSuccess(serialize(2n ** 63n - 1n, t.columns.big, provider))).toBe(true);
      expect(Result.isSuccess(serialize(-(2n ** 63n), t.columns.big, provider))).toBe(true);
    }
  });

  it("a stored blob that is not 8 bytes is a typed Decode failure, not a defect", () => {
    const t = table("t", { id: idColumn("id", Schema.String), big: column("big", Schema.BigInt) });
    const out = deserialize(new Uint8Array([1, 2, 3]), t.columns.big, "sqlite");
    expect(Result.isFailure(out) && out.failure.reason).toBe("Decode");
  });

  it("a date column keeps only the UTC calendar day on every provider", () => {
    const t = table("t", {
      id: idColumn("id", Schema.String),
      d: column("d", Schema.Date, { type: "date" }).default(new Date("2023-05-06T13:14:15.678Z")),
    });
    const day = new Date("2023-05-06T00:00:00Z");
    expect(serialize(new Date("2023-05-06T13:14:15.678Z"), t.columns.d, "sqlite")).toEqual(
      Result.succeed(day.getTime()),
    );
    expect(serialize(new Date("2023-05-06T13:14:15.678Z"), t.columns.d, "postgresql")).toEqual(
      Result.succeed("2023-05-06"),
    );
    expect(t.columns.d.defaultValue?._tag === "Value" && t.columns.d.defaultValue.encoded).toEqual(
      day,
    );
  });

  it("unique constraints reject unbounded text, json, and binary columns", () => {
    expect(() => column("a", Schema.String).unique()).toThrow(SchemaDefinitionError);
    expect(() => column("a", Schema.Unknown).unique()).toThrow(SchemaDefinitionError);
    expect(() => column("a", Schema.Uint8Array).unique()).toThrow(SchemaDefinitionError);
    expect(() =>
      table("t", { id: idColumn("id", Schema.String), a: column("a", Schema.String) }).unique(
        "uk",
        ["a"],
      ),
    ).toThrow(SchemaDefinitionError);
    expect(column("a", Schema.String.check(Schema.isMaxLength(10))).unique().isUnique).toBe(true);
  });

  it("now() rejects a schema that cannot decode a Date at definition time", () => {
    expect(() => column("c", Schema.String, { type: "timestamp" }).now()).toThrow(
      SchemaDefinitionError,
    );
  });

  it("applyNameVariants keeps the schema's static type", () => {
    const s = schema({
      version: "1.0.0",
      tables: { t: table("t", { id: idColumn("id", Schema.String), n: column("n", Schema.Int) }) },
    });
    const renamed = applyNameVariants(s, { t: { sql: "renamed" } });
    const version: "1.0.0" = renamed.version;
    expect(renamed.tables.t.names.sql).toBe("renamed");
    expect(renamed.tables.t.columns.n.type).toBe("integer");
    void version;
  });
});
