import { Schema } from "effect";

export class SchemaDefinitionError extends Error {
  override readonly name = "SchemaDefinitionError";
}

export class QueryError extends Schema.TaggedError<QueryError>("fumadb/QueryError")("QueryError", {
  reason: Schema.Literals([
    "UnknownTable",
    "UnknownColumn",
    "InvalidInput",
    "MissingIdValue",
    "NoMatchingRow",
    "UnexpectedResult",
    "Decode",
  ]),
  message: Schema.String,
  table: Schema.optionalKey(Schema.String),
  column: Schema.optionalKey(Schema.String),
}) {}

export class NotInitialized extends Schema.TaggedError<NotInitialized>("fumadb/NotInitialized")(
  "NotInitialized",
  {
    namespace: Schema.String,
  },
) {
  override get message(): string {
    return `FumaDB "${this.namespace}" is not initialized.`;
  }
}

export class MigrationError extends Schema.TaggedError<MigrationError>("fumadb/MigrationError")(
  "MigrationError",
  {
    reason: Schema.Literals([
      "AlreadyUpToDate",
      "NoPrevious",
      "UnknownVersion",
      "Unsupported",
      "Introspection",
      "Execution",
    ]),
    message: Schema.String,
    statement: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const creationSteps = {
  clear: "remove the unfinished copy left beside",
  create: "create a new copy beside",
  "set aside": "move aside the unrecognised contents of",
  "move into place": "move the new copy into place as",
} as const;

export class PgliteCreationFailed extends Schema.TaggedError<PgliteCreationFailed>(
  "fumadb/PgliteCreationFailed",
)("PgliteCreationFailed", {
  database: Schema.String,
  step: Schema.Literals(["clear", "create", "set aside", "move into place"]),
  code: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `Could not ${creationSteps[this.step]} the database ${this.database}${this.code === undefined ? "" : ` (${this.code})`}.`;
  }
}
