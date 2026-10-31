/** Startup diagnostics keep codes and schema versions without retaining driver messages or SQL. */
import { Schema } from "effect";

export class StorageMigrationFailed extends Schema.TaggedError<StorageMigrationFailed>()(
  "StorageMigrationFailed",
  {
    causeTags: Schema.Array(Schema.String),
    sqlState: Schema.optionalKey(Schema.String),
    migrationVersion: Schema.optionalKey(Schema.String),
  },
) {}

const safeTags = new Set([
  "StorageError",
  "MigrationError",
  "SqlError",
  "ConnectionError",
  "AuthenticationError",
  "AuthorizationError",
  "SqlSyntaxError",
  "UniqueViolation",
  "ConstraintError",
  "DeadlockError",
  "SerializationError",
  "LockTimeoutError",
  "StatementTimeoutError",
  "UnknownError",
  "Error",
  "TypeError",
  "RangeError",
  "DatabaseError",
]);
const sqlStatePattern = /^(?:[0-5][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/;

/** `migrationVersion` comes from the registered schemas, never the stored journal or driver. */
export const storageMigrationFailed = (cause: unknown, migrationVersion?: string) => {
  if (cause instanceof StorageMigrationFailed) return cause;
  const causeTags: Array<string> = [];
  let sqlState: string | undefined;
  let current = cause;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    const tag = Reflect.get(current, "_tag") ?? Reflect.get(current, "name");
    causeTags.push(typeof tag === "string" && safeTags.has(tag) ? tag : "UnknownError");
    const code = Reflect.get(current, "code");
    if (sqlState === undefined && typeof code === "string" && sqlStatePattern.test(code))
      sqlState = code;
    current = Reflect.get(current, "cause");
  }
  return new StorageMigrationFailed({
    causeTags,
    ...(sqlState === undefined ? {} : { sqlState }),
    ...(migrationVersion === undefined ? {} : { migrationVersion }),
  });
};
