/**
 * The value codec: the one place that knows how each provider stores every
 * FumaDB column type and what JavaScript value each Effect SQL driver hands
 * back.
 *
 * Observed driver behaviour (Effect SQL rc.115, see docs/DESIGN.md):
 *
 * | type      | postgresql          | cockroachdb        | mysql (mysql2)    | mssql (tedious)     | sqlite (node:sqlite)   |
 * | --------- | ------------------- | ------------------ | ----------------- | ------------------- | ---------------------- |
 * | string    | string              | string             | string            | string              | string                 |
 * | varchar   | string              | string             | string            | string              | string (stored `text`) |
 * | bigint    | bigint              | bigint             | string or number  | string              | 8-byte blob (BE)       |
 * | integer   | number              | bigint             | number            | number              | number                 |
 * | decimal   | string              | string             | string            | number              | number                 |
 * | bool      | boolean             | boolean            | number 0/1        | boolean             | number 0/1             |
 * | json      | parsed value        | parsed value       | parsed value      | string              | string                 |
 * | binary    | Uint8Array          | Uint8Array         | Buffer            | Buffer              | Uint8Array             |
 * | date      | "YYYY-MM-DD"        | "YYYY-MM-DD"       | Date              | Date                | number (ms)            |
 * | timestamp | number (ms, UTC)    | number (ms, UTC)   | Date              | Date                | number (ms)            |
 * | uuid      | string              | string             | string            | string (upper case) | string                 |
 *
 * `deserialize` normalises all of those to the storage value the column
 * schema expects on its encoded side; the column schema then decodes it. `serialize`
 * produces a value every driver can bind: JSON is sent as text, SQLite gets
 * numbers for dates and booleans and an 8-byte blob for bigints.
 */
import { Result, Schema } from "effect";
import { QueryError } from "../contracts/errors.ts";
import type { Provider } from "../contracts/provider.ts";
import type { AnyColumn } from "../contracts/schema/column.ts";
import type { StorageType } from "../contracts/schema/storage.ts";

/** Length, precision, and scale reported by the database for a column. */
export interface ColumnMetadata {
  readonly length?: number | undefined;
  readonly precision?: number | undefined;
  readonly scale?: number | undefined;
}

/**
 * The FumaDB column types a raw database type can map to, most specific
 * first. `"varchar(n)"` stands for a varchar whose length is not known.
 */
export const dbToSchemaType = (
  rawType: string,
  provider: Provider,
  metadata: ColumnMetadata,
): ReadonlyArray<StorageType | "varchar(n)"> => {
  const dbType = rawType.toLowerCase();
  const varcharOrString = (): ReadonlyArray<StorageType | "varchar(n)"> =>
    metadata.length !== undefined && metadata.length > 0
      ? [`varchar(${metadata.length})`]
      : ["varchar(n)", "string"];

  switch (provider) {
    case "sqlite":
      switch (dbType) {
        // Most likely first: an introspected column must be able to read its own data.
        case "integer":
        case "int":
          return ["integer", "bigint", "bool", "timestamp", "date"];
        case "text":
          return ["string", "varchar(n)", "uuid", "json", "bigint"];
        case "real":
        case "numeric":
          return ["decimal"];
        case "blob":
          return ["bigint", "binary"];
        default:
          return [dbType as StorageType];
      }
    case "postgresql":
    case "cockroachdb":
      switch (dbType) {
        case "uuid":
          return ["uuid"];
        case "int2":
        case "int4":
        case "integer":
        case "smallint":
          return ["integer"];
        case "int8":
        case "bigint":
          return ["bigint", "integer"];
        case "decimal":
        case "real":
        case "numeric":
        case "float4":
        case "float8":
        case "double precision":
          return ["decimal"];
        case "timestamp":
        case "timestamptz":
        case "timestamp without time zone":
        case "timestamp with time zone":
          return ["timestamp"];
        case "date":
          return ["date"];
        case "varchar":
        case "character varying":
          return varcharOrString();
        case "text":
        case "bpchar":
        case "character":
          return ["string"];
        case "boolean":
        case "bool":
          return ["bool"];
        case "bytea":
          return ["binary"];
        case "json":
        case "jsonb":
          return ["json"];
        default:
          return [dbType as StorageType];
      }
    case "mysql":
      switch (dbType) {
        case "bool":
        case "boolean":
        case "tinyint":
          return ["bool", "integer"];
        case "integer":
        case "int":
        case "smallint":
        case "mediumint":
          return ["integer"];
        case "bigint":
          return ["bigint"];
        case "decimal":
        case "numeric":
        case "float":
        case "double":
          return ["decimal"];
        case "datetime":
        case "timestamp":
          return ["timestamp"];
        case "date":
          return ["date"];
        case "char":
          return metadata.length === 36 ? ["uuid", "varchar(36)"] : varcharOrString();
        case "varchar":
          return varcharOrString();
        case "text":
        case "mediumtext":
        case "longtext":
          return ["string"];
        case "json":
          return ["json"];
        case "longblob":
        case "blob":
        case "mediumblob":
        case "tinyblob":
          return ["binary"];
        default:
          return [dbType as StorageType];
      }
    case "mssql":
      switch (dbType) {
        case "uniqueidentifier":
          return ["uuid"];
        case "int":
        case "smallint":
        case "tinyint":
          return ["integer"];
        case "bigint":
          return ["bigint"];
        case "decimal":
        case "float":
        case "real":
        case "numeric":
          return ["decimal"];
        case "bit":
          return ["bool"];
        case "datetime":
        case "datetime2":
          return ["timestamp"];
        case "date":
          return ["date"];
        case "nvarchar":
        case "varchar":
          // `max` is reported as -1 (nvarchar) or an absent length.
          if (metadata.length !== undefined && metadata.length > 0)
            return [`varchar(${metadata.length})`];
          return ["string", "json"];
        case "ntext":
        case "text":
          return ["string", "json"];
        case "binary":
        case "varbinary":
          return ["binary"];
        default:
          return [dbType as StorageType];
      }
  }
};

/** The SQL type used when creating or altering a column on a provider. */
export const schemaToDbType = (
  column: { readonly type: StorageType },
  provider: Provider,
): string => {
  const { type } = column;
  switch (provider) {
    case "sqlite":
      switch (type) {
        case "uuid":
        case "json":
        case "string":
          return "text";
        case "integer":
        case "timestamp":
        case "date":
        case "bool":
          return "integer";
        case "binary":
        case "bigint":
          return "blob";
        case "decimal":
          return "real";
        default:
          // SQLite has no varchar; everything textual is `text`.
          return "text";
      }
    case "mssql":
      switch (type) {
        case "uuid":
          return "uniqueidentifier";
        case "bool":
          return "bit";
        // `datetime` has a 3.33 ms tick and rounds; `datetime2(3)` is exact to the millisecond.
        case "timestamp":
          return "datetime2(3)";
        case "integer":
          return "int";
        // `varchar` is a single-byte codepage type and turns non-Latin1 text into `?`.
        case "string":
          return "nvarchar(max)";
        case "binary":
          return "varbinary(max)";
        // Only SQL Server 2025 has a native json type.
        case "json":
          return "nvarchar(max)";
        // A bare `decimal` is `DECIMAL(18, 0)` on SQL Server, which rounds
        // every fractional value away. 38 is the highest precision it accepts;
        // 19 fractional digits hold every digit of a double.
        case "decimal":
          return "decimal(38,19)";
        default:
          if (type.startsWith("varchar(")) return `n${type}`;
          return type;
      }
    case "postgresql":
    case "cockroachdb":
      switch (type) {
        case "uuid":
          return "uuid";
        case "bool":
          return "boolean";
        case "json":
          return "json";
        case "string":
          return "text";
        case "binary":
          return "bytea";
        default:
          return type;
      }
    case "mysql":
      switch (type) {
        case "uuid":
          return "char(36)";
        // `timestamp` has second precision, a 1970-2038 range, and goes through
        // the session time zone; `datetime(3)` stores the UTC text we send.
        case "timestamp":
          return "datetime(3)";
        case "bool":
          return "boolean";
        case "string":
          return "text";
        case "binary":
          return "longblob";
        // A bare `decimal` is `DECIMAL(10, 0)` on MySQL, which rounds every
        // fractional value away.
        case "decimal":
          // A bare `decimal` is `DECIMAL(10, 0)` on MySQL. 65 is the highest
          // precision it accepts; 30 fractional digits hold every digit of a double.
          return "decimal(65,30)";
        default:
          return type;
      }
  }
};

/**
 * Whether the provider can store a literal `DEFAULT` for a column of this type.
 *
 * MySQL keeps `string`, `json`, and `binary` in a `text`, `json`, or `blob`
 * column and rejects a `DEFAULT` on all three. FumaDB generates the default on
 * insert there instead, so the DDL must leave it out and the schema diff must
 * not report it as a change; both read this one predicate.
 */
export const supportsLiteralDefault = (
  column: { readonly type: StorageType },
  provider: Provider,
): boolean =>
  provider !== "mysql" ||
  (column.type !== "string" && column.type !== "json" && column.type !== "binary");

/**
 * Providers whose driver already returns a parsed JavaScript value for a
 * `json` column. On the others the column is stored as text and the codec
 * parses it.
 */
const parsesJson = (provider: Provider): boolean =>
  provider === "postgresql" || provider === "cockroachdb" || provider === "mysql";

/** A date or timestamp string without a zone designator is UTC (that is how it was written). */
const parseUtcTimestamp = (value: string): Date => {
  if (value.length === 10) return new Date(`${value}T00:00:00Z`);
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`);
};

/** The same wall-clock fields, taken as UTC instead of the process time zone. */
const localComponentsAsUtc = (value: Date): Date =>
  new Date(
    Date.UTC(
      value.getFullYear(),
      value.getMonth(),
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds(),
      value.getMilliseconds(),
    ),
  );

const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;

/** A plain `Uint8Array` (not a `Buffer`) over the same bytes. */
const toPlainBytes = (value: Uint8Array): Uint8Array =>
  value.constructor === Uint8Array
    ? value
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

const bigintToBytes = (value: bigint): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value);
  return bytes;
};

const bytesToBigint = (value: Uint8Array): bigint =>
  new DataView(value.buffer, value.byteOffset, value.byteLength).getBigInt64(0);

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** The UTC calendar day of a `Date`, at midnight. */
const utcDay = (value: Date): Date =>
  new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));

/**
 * Turn a driver value into the column's storage value (the encoded side of
 * its schema). Values already in the right shape pass through unchanged.
 * Fails with a `QueryError` of reason `"Decode"` when stored JSON text is
 * malformed.
 */
export const fromDriver = (
  value: unknown,
  column: AnyColumn,
  provider: Provider,
): Result.Result<unknown, QueryError> => {
  if (value === null || value === undefined) return Result.succeed(null);
  switch (column.type) {
    case "json": {
      // On postgresql, cockroachdb, and mysql the driver has already parsed
      // the column, so a stored JSON *string* arrives as a JavaScript string
      // and must not be parsed again.
      if (parsesJson(provider) || typeof value !== "string") return Result.succeed(value);
      try {
        return Result.succeed(JSON.parse(value) as unknown);
      } catch (cause) {
        return Result.fail(
          new QueryError({
            reason: "Decode",
            message: `stored value of column "${column.ormName}" is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
            table: column.table.ormName,
            column: column.ormName,
          }),
        );
      }
    }
    case "bool":
      if (typeof value === "number") return Result.succeed(value === 1);
      if (typeof value === "bigint") return Result.succeed(value === 1n);
      if (typeof value === "string") return Result.succeed(value === "1" || value === "true");
      return Result.succeed(value);
    case "bigint":
      if (typeof value === "string" || typeof value === "number")
        return Result.succeed(BigInt(value));
      if (isBytes(value)) {
        if (value.byteLength !== 8) {
          return Result.fail(
            new QueryError({
              reason: "Decode",
              message: `stored value of column "${column.ormName}" is a ${value.byteLength}-byte blob, not the 8-byte bigint the column expects`,
              table: column.table.ormName,
              column: column.ormName,
            }),
          );
        }
        return Result.succeed(bytesToBigint(value));
      }
      return Result.succeed(value);
    case "integer":
      if (typeof value === "bigint" || typeof value === "string")
        return Result.succeed(Number(value));
      return Result.succeed(value);
    case "decimal":
      if (typeof value === "string" || typeof value === "bigint")
        return Result.succeed(Number(value));
      return Result.succeed(value);
    case "binary":
      return Result.succeed(isBytes(value) ? toPlainBytes(value) : value);
    case "date":
    case "timestamp":
      if (typeof value === "number" || typeof value === "bigint")
        return Result.succeed(new Date(Number(value)));
      if (typeof value === "string") return Result.succeed(parseUtcTimestamp(value));
      // mysql2 parses the stored UTC text with local-time components; read them back as UTC.
      if (value instanceof Date && provider === "mysql")
        return Result.succeed(localComponentsAsUtc(value));
      return Result.succeed(value);
    case "uuid":
      // SQL Server reports `uniqueidentifier` in upper case; comparisons are case-insensitive.
      return Result.succeed(
        provider === "mssql" && typeof value === "string" ? value.toLowerCase() : value,
      );
    default:
      // Every textual type is already a string on every provider.
      return Result.succeed(value);
  }
};

/**
 * Turn a storage value (the encoded side of the column schema) into something
 * the provider's driver can bind. `undefined` stays `undefined` so callers
 * can omit the column.
 */
export const toDriver = (value: unknown, column: AnyColumn, provider: Provider): unknown => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  switch (column.type) {
    case "json":
      return JSON.stringify(value);
    case "date":
      if (!(value instanceof Date)) return value;
      // A `date` keeps only the UTC calendar day on every provider.
      if (provider === "sqlite") return utcDay(value).getTime();
      return value.toISOString().slice(0, 10);
    case "timestamp":
      if (!(value instanceof Date)) return value;
      if (provider === "sqlite") return value.getTime();
      if (provider === "mysql" || provider === "mssql")
        return value.toISOString().slice(0, 23).replace("T", " ");
      return value;
    case "decimal":
      // Sent as text so the database parses the exact digits instead of a float parameter.
      return typeof value === "number" &&
        (provider === "postgresql" || provider === "mysql" || provider === "mssql")
        ? String(value)
        : value;
    case "bool":
      return provider === "sqlite" && typeof value === "boolean" ? (value ? 1 : 0) : value;
    case "bigint":
      return provider === "sqlite" && typeof value === "bigint" ? bigintToBytes(value) : value;
    case "binary":
      return isBytes(value) ? toPlainBytes(value) : value;
    default:
      return value;
  }
};

const decoders = new WeakMap<
  AnyColumn,
  (input: unknown) => Result.Result<unknown, Schema.SchemaError>
>();
const encoders = new WeakMap<
  AnyColumn,
  (input: unknown) => Result.Result<unknown, Schema.SchemaError>
>();

const decoderFor = (column: AnyColumn) => {
  let decoder = decoders.get(column);
  if (decoder === undefined) {
    decoder = Schema.decodeUnknownResult(
      column.schema as unknown as Schema.ConstraintDecoder<unknown>,
    );
    decoders.set(column, decoder);
  }
  return decoder;
};

const encoderFor = (column: AnyColumn) => {
  let encoder = encoders.get(column);
  if (encoder === undefined) {
    encoder = Schema.encodeUnknownResult(
      column.schema as unknown as Schema.ConstraintEncoder<unknown>,
    );
    encoders.set(column, encoder);
  }
  return encoder;
};

const issueMessage = (error: Schema.SchemaError): string =>
  error.message.split("\n")[0] ?? error.message;

/**
 * Driver value -> column value: `fromDriver`, then the column schema's decoder.
 *
 * A `NULL` in a nullable column is decoded through the schema, so
 * `Schema.NullOr(X)` yields `null` and `Schema.OptionFromNullOr(X)` yields
 * `Option.none()`. A `NULL` in a column whose schema does not accept it (a
 * column added after the rows were written) stays `null`. A value the schema
 * rejects fails with `QueryError` (`Decode`).
 */
export const deserialize = (
  value: unknown,
  column: AnyColumn,
  provider: Provider,
): Result.Result<unknown, QueryError> => {
  const stored = fromDriver(value, column, provider);
  if (Result.isFailure(stored)) return stored;
  if (stored.success === null && !column.isNullable) return Result.succeed(null);
  const decoded = decoderFor(column)(stored.success);
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success)
    : Result.fail(
        new QueryError({
          reason: "Decode",
          message: `stored value of column "${column.ormName}" does not match its schema: ${issueMessage(decoded.failure)}`,
          table: column.table.ormName,
          column: column.ormName,
        }),
      );
};

/**
 * Column value -> driver value: the column schema's encoder, then `toDriver`.
 * `undefined` and `null` pass through. A value the schema rejects fails with
 * `QueryError` (`InvalidInput`).
 */
export const serialize = (
  value: unknown,
  column: AnyColumn,
  provider: Provider,
): Result.Result<unknown, QueryError> => {
  if (value === undefined || value === null)
    return Result.succeed(toDriver(value, column, provider));
  const encoded = encoderFor(column)(value);
  if (
    Result.isSuccess(encoded) &&
    column.type === "bigint" &&
    typeof encoded.success === "bigint"
  ) {
    // Every provider stores a signed 64-bit integer; SQLite's blob encoding would wrap silently.
    if (encoded.success < INT64_MIN || encoded.success > INT64_MAX) {
      return Result.fail(
        new QueryError({
          reason: "InvalidInput",
          message: `value ${encoded.success} for column "${column.ormName}" is outside the 64-bit range a bigint column stores`,
          table: column.table.ormName,
          column: column.ormName,
        }),
      );
    }
  }
  return Result.isSuccess(encoded)
    ? Result.succeed(toDriver(encoded.success, column, provider))
    : Result.fail(
        new QueryError({
          reason: "InvalidInput",
          message: `value for column "${column.ormName}" does not match its schema: ${issueMessage(encoded.failure)}`,
          table: column.table.ormName,
          column: column.ormName,
        }),
      );
};
