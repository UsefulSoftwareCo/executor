/**
 * Column definitions.
 *
 * A column is an Effect `Schema` plus storage metadata. The schema's `Type`
 * is what queries return and accept; its `Encoded` side is what the database
 * stores, and the storage type is inferred from it (see `storage.ts`).
 */
import { Clock, Effect, Result, Schema } from "effect";
import { SchemaDefinitionError } from "../errors.ts";
import { generateId, generateUuid } from "../../implementation/cuid.ts";
import type { NameVariants } from "./names.ts";
import {
  type IdStorageType,
  inferStorageType,
  isIdStorageType,
  isStorageType,
  type StorageType,
} from "./storage.ts";
import type { AnyTable } from "./table.ts";

export type { IdStorageType, StorageType } from "./storage.ts";

/**
 * How a column gets a value when an insert omits it.
 *
 * - `Value`: a constant, also written as the database default.
 * - `Runtime`: generated on every insert by an Effect (`generated()`, `now()`, `generate(effect)`).
 */
export type ColumnDefault<T> =
  | {
      readonly _tag: "Value";
      /** The default on the schema's Type side, applied on insert. */
      readonly value: T;
      /** The same default on the Encoded side: what DDL writes and the diff compares. */
      readonly encoded: unknown;
    }
  | {
      readonly _tag: "Runtime";
      readonly kind: "auto" | "now" | "custom";
      readonly generate: Effect.Effect<T>;
    };

/** Options accepted by {@link column} and {@link idColumn}. */
export interface ColumnOptions {
  /** Override the storage type inferred from the schema. */
  readonly type?: StorageType | undefined;
}

const ColumnTypeId = Symbol.for("fumadb-effect/Column");

const initNames =
  (name: string | Partial<NameVariants>) =>
  (ormName: string): NameVariants =>
    typeof name === "string" ? { sql: name } : { sql: name.sql ?? ormName };

/**
 * A column of a table. Construct with {@link column}; `table()` links
 * `ormName` and `table` when the table is created.
 *
 * `S` is the column's Effect schema. Its `Type` is the value side, its
 * `Encoded` the stored side.
 */
export class Column<S extends Schema.Top = Schema.Top, HasDefault extends boolean = false> {
  readonly [ColumnTypeId] = ColumnTypeId;
  /** Type-level only: whether the column has a default (so an insert may omit it). */
  declare readonly hasDefault: HasDefault;
  /** The Effect schema of the column's value. */
  readonly schema: S;
  /** What the database stores. */
  type: StorageType;
  /** `true` when `type` was inferred from the schema rather than given with `{ type }`. */
  readonly typeInferred: boolean;
  /** Whether the column accepts `NULL` (the schema's encoded side accepts `null`). */
  readonly isNullable: boolean;
  ormName = "";
  isUnique = false;
  /** The column default, if any. Set through `default()`, `generate()`, `generated()`, or `now()`. */
  defaultValue: ColumnDefault<S["Type"]> | undefined = undefined;
  /** SAFETY: assigned by `table()` before the column is observable. */
  table: AnyTable = undefined as unknown as AnyTable;

  private initNames: (ormName: string) => NameVariants;

  /** The database-facing names. Assignable, so consumers can override them. */
  get names(): NameVariants {
    return this.initNames(this.ormName);
  }

  set names(names: NameVariants) {
    this.initNames = () => names;
  }

  constructor(
    schema: S,
    type: StorageType,
    nullable: boolean,
    names: (ormName: string) => NameVariants,
    typeInferred: boolean = true,
  ) {
    this.schema = schema;
    this.type = type;
    this.isNullable = nullable;
    this.initNames = names;
    this.typeInferred = typeInferred;
  }

  /**
   * Adopt the storage type of a column this one references through a foreign
   * key, when this column's type was only inferred. A `Schema.String` id is
   * `varchar(255)` while a `Schema.String` column is `string`; the foreign key
   * must use the key's width. An explicit `{ type }` is never overridden.
   */
  adoptStorageType(referenced: AnyColumn): void {
    if (!this.typeInferred || this.type === referenced.type) return;
    const compatible =
      (this.type === "string" || this.type.startsWith("varchar(")) &&
      (referenced.type === "string" ||
        referenced.type === "uuid" ||
        referenced.type.startsWith("varchar("));
    if (compatible) this.type = referenced.type;
  }

  /**
   * Add a column-level unique constraint. Duplicate `NULL` values stay allowed
   * on every provider. Unbounded `string`, `json`, and `binary` columns cannot
   * be unique: MySQL and SQL Server refuse to index them.
   */
  unique(unique: boolean = true): this {
    if (unique) assertIndexable(this, "unique()");
    this.isUnique = unique;
    return this;
  }

  /**
   * A constant default: written to the database as the column default and
   * applied on insert so every provider behaves the same. The value must
   * satisfy the column schema.
   */
  default(value: S["Type"]): Column<S, true> {
    const encoded = Schema.encodeUnknownResult(
      this.schema as unknown as Schema.ConstraintEncoder<unknown>,
    )(value);
    if (Result.isFailure(encoded)) {
      throw new SchemaDefinitionError(
        `Default of column "${this.ormName || this.names.sql}" does not match its schema: ${encoded.failure.message.split("\n")[0]}`,
      );
    }
    // A `date` column keeps only the UTC calendar day (see `toDriver`), so the
    // stored default is the day too; otherwise a from-database diff would
    // keep re-emitting the time part.
    const stored =
      this.type === "date" && encoded.success instanceof Date
        ? new Date(
            Date.UTC(
              encoded.success.getUTCFullYear(),
              encoded.success.getUTCMonth(),
              encoded.success.getUTCDate(),
            ),
          )
        : encoded.success;
    this.defaultValue = { _tag: "Value", value, encoded: stored };
    return this as unknown as Column<S, true>;
  }

  /** Generate the value with an Effect on every insert that omits the column. */
  generate(effect: Effect.Effect<S["Type"]>): Column<S, true> {
    this.defaultValue = { _tag: "Runtime", kind: "custom", generate: effect };
    return this as unknown as Column<S, true>;
  }

  /**
   * Generate an identifier on insert: a UUID v4 for a `uuid` column, a CUID2
   * for any other string column. The generated value is decoded through the
   * column schema, so a brand or refinement still applies.
   */
  generated(): Column<S, true> {
    if (this.type !== "string" && this.type !== "uuid" && !this.type.startsWith("varchar(")) {
      throw new SchemaDefinitionError(
        `generated() needs a string column; "${this.ormName || "?"}" is ${this.type}.`,
      );
    }
    const decode = Schema.decodeUnknownSync(
      this.schema as unknown as Schema.ConstraintDecoder<unknown>,
    );
    const source = this.type === "uuid" ? generateUuid : generateId;
    this.defaultValue = {
      _tag: "Runtime",
      kind: "auto",
      generate: Effect.map(source, (id) => decode(id) as S["Type"]),
    };
    return this as unknown as Column<S, true>;
  }

  /** Use the current time on insert. The storage type must be `date` or `timestamp`. */
  now(): Column<S, true> {
    if (this.type !== "date" && this.type !== "timestamp") {
      throw new SchemaDefinitionError(
        `now() needs a date or timestamp column; "${this.ormName || "?"}" is ${this.type}.`,
      );
    }
    const decode = Schema.decodeUnknownSync(
      this.schema as unknown as Schema.ConstraintDecoder<unknown>,
    );
    // The schema must accept a Date on its encoded side; check once here instead of on every insert.
    try {
      decode(new Date(0));
    } catch (cause) {
      throw new SchemaDefinitionError(
        `now() needs a schema that decodes a Date; "${this.ormName || this.names.sql}" does not: ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`,
      );
    }
    this.defaultValue = {
      _tag: "Runtime",
      kind: "now",
      // The schema's Type may be a Date or a DateTime: decode the encoded Date through it.
      generate: Effect.map(
        Clock.currentTimeMillis,
        (millis) => decode(new Date(millis)) as S["Type"],
      ),
    };
    return this as unknown as Column<S, true>;
  }

  /**
   * A detached copy, keeping the schema, storage type, flags, default, and
   * current names. `nullable` overrides the stored nullability only; the
   * schema is kept as it is.
   */
  clone(options: { readonly nullable?: boolean } = {}): Column<S, HasDefault> {
    const names = this.names;
    const cloned = new Column<S, HasDefault>(
      this.schema,
      this.type,
      options.nullable ?? this.isNullable,
      () => names,
      this.typeInferred,
    );
    cloned.ormName = this.ormName;
    cloned.isUnique = this.isUnique;
    cloned.defaultValue = this.defaultValue;
    cloned.table = this.table;
    return cloned;
  }

  /** Name of the constraint created for `unique()`. */
  getUniqueConstraintName(): string {
    return `unique_c_${this.table.ormName}_${this.ormName}`;
  }

  /** The default value for an insert that omitted this column, or `undefined` when there is no default. */
  generateDefault(): Effect.Effect<S["Type"] | undefined> {
    const def = this.defaultValue;
    if (def === undefined) return Effect.succeed(undefined);
    return def._tag === "Value" ? Effect.succeed(def.value) : def.generate;
  }

  /** Whether this column is the primary key of its table. */
  get isId(): boolean {
    return this instanceof IdColumn;
  }
}

/** The single primary key of a table. Construct with {@link idColumn}. */
export class IdColumn<
  S extends Schema.Top = Schema.Top,
  HasDefault extends boolean = false,
> extends Column<S, HasDefault> {
  readonly id = true;
  declare type: IdStorageType;

  override clone(options: { readonly nullable?: boolean } = {}): IdColumn<S, HasDefault> {
    const names = this.names;
    const cloned = new IdColumn<S, HasDefault>(
      this.schema,
      this.type,
      options.nullable ?? this.isNullable,
      () => names,
      this.typeInferred,
    );
    cloned.ormName = this.ormName;
    cloned.isUnique = this.isUnique;
    cloned.defaultValue = this.defaultValue;
    cloned.table = this.table;
    return cloned;
  }

  override default(value: S["Type"]): IdColumn<S, true> {
    return super.default(value) as unknown as IdColumn<S, true>;
  }

  override generate(effect: Effect.Effect<S["Type"]>): IdColumn<S, true> {
    return super.generate(effect) as unknown as IdColumn<S, true>;
  }

  override generated(): IdColumn<S, true> {
    return super.generated() as unknown as IdColumn<S, true>;
  }
}

/** Any column, regardless of its schema. */
export type AnyColumn = Column<Schema.Top, boolean>;

/**
 * Storage types that every provider can index. Unbounded text, JSON, and
 * binary columns cannot carry a unique constraint or a foreign key on MySQL
 * (`BLOB/TEXT column used in key specification without a key length`) or
 * SQL Server (`nvarchar(max)` is not a valid index key).
 */
export const isIndexable = (type: StorageType): boolean =>
  type !== "string" && type !== "json" && type !== "binary";

/** Raise a `SchemaDefinitionError` when `column` cannot be part of an index. */
export const assertIndexable = (column: AnyColumn, purpose: string): void => {
  if (isIndexable(column.type)) return;
  throw new SchemaDefinitionError(
    `${purpose} needs an indexable column; "${column.ormName || column.names.sql}" is stored as ${column.type}. Use a bounded schema such as Schema.String.check(Schema.isMaxLength(255)), or pass { type: "varchar(255)" }.`,
  );
};

/** Whether a value is a FumaDB column. */
export const isColumn = (value: unknown): value is AnyColumn =>
  typeof value === "object" && value !== null && ColumnTypeId in value;

/** Whether a column is the primary key of its table. */
export const isIdColumn = (column: AnyColumn): column is IdColumn<Schema.Top, boolean> =>
  column instanceof IdColumn;

const resolveStorage = (schema: Schema.Top, options: ColumnOptions | undefined, label: string) => {
  const inferred = inferStorageType(schema);
  const override = options?.type;
  if (override !== undefined && !isStorageType(override)) {
    throw new SchemaDefinitionError(`Column "${label}": "${override}" is not a storage type.`);
  }
  return { type: override ?? inferred.type, nullable: inferred.nullable };
};

/**
 * Define a column.
 *
 * @param name the SQL name, or `{ sql }` overrides (defaults to the ORM name).
 * @param schema the Effect schema of the value. Wrap it in `Schema.NullOr` for a nullable column.
 * @param options an explicit storage type when the inferred one is not what you want.
 */
export const column = <S extends Schema.Top>(
  name: string | Partial<NameVariants>,
  schema: S,
  options?: ColumnOptions,
): Column<S, false> => {
  const { nullable, type } = resolveStorage(schema, options, typeof name === "string" ? name : "?");
  return new Column<S, false>(schema, type, nullable, initNames(name), options?.type === undefined);
};

/**
 * Define the id column of a table. Each table has exactly one.
 *
 * The storage type must be `varchar(n)` or `uuid`. A plain string schema
 * becomes `varchar(255)`; a string schema with `Schema.isUUID()` becomes
 * `uuid`; use `options.type` for another width. The id cannot be nullable.
 */
export const idColumn = <S extends Schema.Top>(
  name: string | Partial<NameVariants>,
  schema: S,
  options?: ColumnOptions,
): IdColumn<S, false> => {
  const label = typeof name === "string" ? name : "?";
  const resolved = resolveStorage(schema, options, label);
  const type: StorageType = resolved.type === "string" ? "varchar(255)" : resolved.type;
  if (!isIdStorageType(type)) {
    throw new SchemaDefinitionError(
      `Id column "${label}" must be varchar(n) or uuid, not ${type}.`,
    );
  }
  if (resolved.nullable)
    throw new SchemaDefinitionError(`Id column "${label}" cannot be nullable.`);
  return new IdColumn<S, false>(schema, type, false, initNames(name), options?.type === undefined);
};
