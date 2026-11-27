import { Schema } from "effect";

const CauseTag = Schema.Literals([
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
const maxDepth = 8;
const sqlStatePattern = /^(?:[0-5][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/u;

export class StorageMigrationFailed extends Schema.TaggedError<StorageMigrationFailed>()(
  "StorageMigrationFailed",
  {
    causeTags: Schema.Array(CauseTag).check(Schema.isMaxLength(maxDepth)),
    sqlState: Schema.optionalKey(Schema.String.check(Schema.isPattern(sqlStatePattern))),
    migrationVersion: Schema.optionalKey(
      Schema.String.check(Schema.isPattern(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u)),
    ),
  },
) {}

const isCauseTag = Schema.is(CauseTag);

const fromCause = (cause: unknown, migrationVersion: string | undefined) => {
  if (cause instanceof StorageMigrationFailed) return cause;
  const causeTags: Array<typeof CauseTag.Type> = [];
  let sqlState: string | undefined;
  let current = cause;
  for (
    let depth = 0;
    depth < maxDepth && typeof current === "object" && current !== null;
    depth++
  ) {
    const tag = Reflect.get(current, "_tag") ?? Reflect.get(current, "name");
    causeTags.push(isCauseTag(tag) ? tag : "UnknownError");
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

export const storageMigrationFailed = (cause: unknown, migrationVersion?: string) => {
  try {
    return fromCause(cause, migrationVersion);
  } catch {
    return new StorageMigrationFailed({
      causeTags: ["UnknownError"],
      ...(migrationVersion === undefined ? {} : { migrationVersion }),
    });
  }
};
