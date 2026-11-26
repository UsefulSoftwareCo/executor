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

export type ColumnDefault<T> =
  | {
      readonly _tag: "Value";
      readonly value: T;
      readonly encoded: unknown;
    }
  | {
      readonly _tag: "Runtime";
      readonly kind: "auto" | "now" | "custom";
      readonly generate: Effect.Effect<T>;
    };

export interface ColumnOptions {
  readonly type?: StorageType | undefined;
}

const ColumnTypeId = Symbol.for("fumadb-effect/Column");

const initNames =
  (name: string | Partial<NameVariants>) =>
  (ormName: string): NameVariants =>
    typeof name === "string" ? { sql: name } : { sql: name.sql ?? ormName };

export class Column<S extends Schema.Top = Schema.Top, HasDefault extends boolean = false> {
  readonly [ColumnTypeId] = ColumnTypeId;
  declare readonly hasDefault: HasDefault;
  readonly schema: S;
  type: StorageType;
  readonly typeInferred: boolean;
  readonly isNullable: boolean;
  ormName = "";
  isUnique = false;
  defaultValue: ColumnDefault<S["Type"]> | undefined = undefined;
  table: AnyTable = undefined as unknown as AnyTable;

  private initNames: (ormName: string) => NameVariants;

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

  adoptStorageType(referenced: AnyColumn): void {
    if (!this.typeInferred || this.type === referenced.type) return;
    const compatible =
      (this.type === "string" || this.type.startsWith("varchar(")) &&
      (referenced.type === "string" ||
        referenced.type === "uuid" ||
        referenced.type.startsWith("varchar("));
    if (compatible) this.type = referenced.type;
  }

  unique(unique: boolean = true): this {
    if (unique) assertIndexable(this, "unique()");
    this.isUnique = unique;
    return this;
  }

  default(value: S["Type"]): Column<S, true> {
    const encoded = Schema.encodeUnknownResult(
      this.schema as unknown as Schema.ConstraintEncoder<unknown>,
    )(value);
    if (Result.isFailure(encoded)) {
      throw new SchemaDefinitionError(
        `Default of column "${this.ormName || this.names.sql}" does not match its schema: ${encoded.failure.message.split("\n")[0]}`,
      );
    }
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

  generate(effect: Effect.Effect<S["Type"]>): Column<S, true> {
    this.defaultValue = { _tag: "Runtime", kind: "custom", generate: effect };
    return this as unknown as Column<S, true>;
  }

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

  now(): Column<S, true> {
    if (this.type !== "date" && this.type !== "timestamp") {
      throw new SchemaDefinitionError(
        `now() needs a date or timestamp column; "${this.ormName || "?"}" is ${this.type}.`,
      );
    }
    const decode = Schema.decodeUnknownSync(
      this.schema as unknown as Schema.ConstraintDecoder<unknown>,
    );
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
      generate: Effect.map(
        Clock.currentTimeMillis,
        (millis) => decode(new Date(millis)) as S["Type"],
      ),
    };
    return this as unknown as Column<S, true>;
  }

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

  getUniqueConstraintName(): string {
    return `unique_c_${this.table.ormName}_${this.ormName}`;
  }

  generateDefault(): Effect.Effect<S["Type"] | undefined> {
    const def = this.defaultValue;
    if (def === undefined) return Effect.succeed(undefined);
    return def._tag === "Value" ? Effect.succeed(def.value) : def.generate;
  }

  get isId(): boolean {
    return this instanceof IdColumn;
  }
}

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

export type AnyColumn = Column<Schema.Top, boolean>;

export const isIndexable = (type: StorageType): boolean =>
  type !== "string" && type !== "json" && type !== "binary";

export const assertIndexable = (column: AnyColumn, purpose: string): void => {
  if (isIndexable(column.type)) return;
  throw new SchemaDefinitionError(
    `${purpose} needs an indexable column; "${column.ormName || column.names.sql}" is stored as ${column.type}. Use a bounded schema such as Schema.String.check(Schema.isMaxLength(255)), or pass { type: "varchar(255)" }.`,
  );
};

export const isColumn = (value: unknown): value is AnyColumn =>
  typeof value === "object" && value !== null && ColumnTypeId in value;

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

export const column = <S extends Schema.Top>(
  name: string | Partial<NameVariants>,
  schema: S,
  options?: ColumnOptions,
): Column<S, false> => {
  const { nullable, type } = resolveStorage(schema, options, typeof name === "string" ? name : "?");
  return new Column<S, false>(schema, type, nullable, initNames(name), options?.type === undefined);
};

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
