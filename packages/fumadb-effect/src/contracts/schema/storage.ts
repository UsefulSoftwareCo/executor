/**
 * Storage types: what the database stores for a column, independent of the
 * Effect schema that describes the column's value.
 *
 * `inferStorageType` reads the encoded side of a schema and picks a storage
 * type, so brands, refinements, and transformations never change the DDL.
 */
import { Schema, SchemaAST } from "effect";
import { SchemaDefinitionError } from "../errors.ts";

/** Every storage type FumaDB can create and migrate. */
export type StorageType =
  | "string"
  | `varchar(${number})`
  | "uuid"
  | "integer"
  | "decimal"
  | "bigint"
  | "bool"
  | "json"
  | "binary"
  | "date"
  | "timestamp";

/** Storage types an id column may use. */
export type IdStorageType = `varchar(${number})` | "uuid";

const VARCHAR = /^varchar\((\d+)\)$/;

/** Whether a string names a storage type. */
export const isStorageType = (value: string): value is StorageType =>
  value === "string" ||
  value === "uuid" ||
  value === "integer" ||
  value === "decimal" ||
  value === "bigint" ||
  value === "bool" ||
  value === "json" ||
  value === "binary" ||
  value === "date" ||
  value === "timestamp" ||
  VARCHAR.test(value);

/** Whether a storage type may back an id column. */
export const isIdStorageType = (type: StorageType): type is IdStorageType =>
  type === "uuid" || VARCHAR.test(type);

/** The `n` of `varchar(n)`, or `undefined` for other storage types. */
export const varcharLength = (type: StorageType): number | undefined => {
  const match = VARCHAR.exec(type);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

/** What `inferStorageType` learned from a schema. */
export interface InferredStorage {
  readonly type: StorageType;
  /** `true` when the encoded side accepts `null`. */
  readonly nullable: boolean;
}

type Check =
  | {
      readonly _tag: "Filter";
      readonly annotations?:
        | { readonly representation?: { readonly id?: string; readonly payload?: unknown } }
        | undefined;
    }
  | { readonly _tag: "FilterGroup"; readonly checks: ReadonlyArray<Check> };

const flattenChecks = (
  checks: ReadonlyArray<Check> | undefined,
): Array<Extract<Check, { _tag: "Filter" }>> => {
  const out: Array<Extract<Check, { _tag: "Filter" }>> = [];
  for (const check of checks ?? []) {
    if (check._tag === "FilterGroup") out.push(...flattenChecks(check.checks));
    else out.push(check);
  }
  return out;
};

const checkPayload = (ast: SchemaAST.AST, id: string): unknown => {
  for (const check of flattenChecks(ast.checks as ReadonlyArray<Check> | undefined)) {
    if (check.annotations?.representation?.id === id)
      return check.annotations.representation.payload ?? null;
  }
  return undefined;
};

const declarationId = (ast: SchemaAST.AST): string | undefined => {
  const representation = ast.annotations?.["representation"];
  return typeof representation === "object" &&
    representation !== null &&
    "id" in representation &&
    typeof representation.id === "string"
    ? representation.id
    : undefined;
};

/** The storage type of a literal, by the type of its value. */
const literalStorageType = (literal: unknown): StorageType => {
  switch (typeof literal) {
    case "number":
      return Number.isInteger(literal) ? "integer" : "decimal";
    case "bigint":
      return "bigint";
    case "boolean":
      return "bool";
    default:
      return "string";
  }
};

const scalarStorageType = (ast: SchemaAST.AST): StorageType => {
  switch (ast._tag) {
    case "String": {
      if (checkPayload(ast, "effect/schema/isUUID") !== undefined) return "uuid";
      const maxLength = checkPayload(ast, "effect/schema/isMaxLength");
      if (
        typeof maxLength === "object" &&
        maxLength !== null &&
        "maxLength" in maxLength &&
        typeof maxLength.maxLength === "number"
      ) {
        return `varchar(${maxLength.maxLength})`;
      }
      return "string";
    }
    case "Number":
      return checkPayload(ast, "effect/schema/isInt") !== undefined ? "integer" : "decimal";
    case "BigInt":
      return "bigint";
    case "Boolean":
      return "bool";
    case "Declaration": {
      const id = declarationId(ast);
      if (id === "effect/schema/Date") return "timestamp";
      if (id === "effect/schema/Uint8Array") return "binary";
      if (id === "effect/schema/Option") {
        throw new SchemaDefinitionError(
          "Schema.Option cannot be stored as is (its encoded form is an Option); use Schema.OptionFromNullOr for a nullable column that reads as an Option.",
        );
      }
      return "json";
    }
    case "Literal":
      return literalStorageType((ast as SchemaAST.Literal).literal);
    case "TemplateLiteral":
      return "string";
    default:
      return "json";
  }
};

/** Flatten nested unions and drop `Null` / `Undefined` members, reporting whether any were present. */
const unionMembers = (
  ast: SchemaAST.AST,
): { readonly members: ReadonlyArray<SchemaAST.AST>; readonly nullable: boolean } => {
  if (!SchemaAST.isUnion(ast)) return { members: [ast], nullable: false };
  const members: Array<SchemaAST.AST> = [];
  let nullable = false;
  for (const member of ast.types) {
    if (SchemaAST.isNull(member) || SchemaAST.isUndefined(member)) {
      nullable = true;
      continue;
    }
    const inner = unionMembers(member);
    members.push(...inner.members);
    nullable = nullable || inner.nullable;
  }
  return { members, nullable };
};

/**
 * Pick the storage type for a schema from its encoded side.
 *
 * A union with `Null` marks the column nullable; a union of literals or of
 * several scalars is stored as the scalar when every member agrees (a union
 * of string literals is a `string`), and as `json` otherwise.
 */
export const inferStorageType = (schema: Schema.Top): InferredStorage => {
  if (SchemaAST.isOptional(schema.ast)) {
    throw new SchemaDefinitionError(
      "A column schema cannot be optional (optionalKey / optional); wrap it in Schema.NullOr for a nullable column.",
    );
  }
  const encoded = SchemaAST.toEncoded(schema.ast);
  if (SchemaAST.isNever(encoded) || SchemaAST.isUndefined(encoded) || SchemaAST.isNull(encoded)) {
    throw new SchemaDefinitionError("A column schema must accept at least one non-null value.");
  }
  const { members, nullable } = unionMembers(encoded);
  const first = members[0];
  if (first === undefined)
    throw new SchemaDefinitionError("A column schema must accept at least one non-null value.");
  const types = new Set(members.map(scalarStorageType));
  if (types.size === 1) return { type: scalarStorageType(first), nullable };
  // integer and decimal literals mixed together still fit a decimal column
  if (types.size === 2 && types.has("integer") && types.has("decimal"))
    return { type: "decimal", nullable };
  return { type: "json", nullable };
};

/**
 * The plain Effect schema for a storage type: what a column reads as when
 * nothing more specific is known (introspection, the settings table).
 */
export const schemaForStorageType = (type: StorageType, nullable: boolean): Schema.Top => {
  const base = ((): Schema.Top => {
    const length = varcharLength(type);
    if (length !== undefined) return Schema.String.check(Schema.isMaxLength(length));
    switch (type) {
      case "string":
        return Schema.String;
      case "uuid":
        return Schema.String.check(Schema.isUUID());
      case "integer":
        return Schema.Int;
      case "decimal":
        return Schema.Number;
      case "bigint":
        return Schema.BigInt;
      case "bool":
        return Schema.Boolean;
      case "json":
        return Schema.Unknown;
      case "binary":
        return Schema.Uint8Array;
      case "date":
      case "timestamp":
        return Schema.Date;
      default:
        return Schema.Unknown;
    }
  })();
  return nullable ? Schema.NullOr(base as Schema.Constraint) : base;
};
