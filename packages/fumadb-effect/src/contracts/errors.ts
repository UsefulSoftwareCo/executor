/**
 * Typed failures shared by the whole package.
 *
 * Driver failures stay as Effect SQL's `SqlError`. The errors here describe
 * failures that belong to FumaDB itself: bad query input, an uninitialised
 * database, and migration planning or execution problems.
 *
 * Invalid schema definitions are programmer errors and are raised as
 * `SchemaDefinitionError` defects at construction time, not as typed failures.
 */
import { Schema } from "effect";

/**
 * Thrown (as a defect) when a schema, table, column, or relation is defined in
 * a way the engine cannot represent. Library authors see this while writing
 * their schema, never at runtime for a valid schema.
 */
export class SchemaDefinitionError extends Error {
  override readonly name = "SchemaDefinitionError";
}

/**
 * A query could not be built or its result could not be interpreted.
 *
 * - `UnknownTable`, `UnknownColumn`: the name does not exist in the schema.
 * - `InvalidInput`: an option is out of range (a negative limit, an unsupported operator).
 * - `MissingIdValue`: `create` needs the id to read the row back and none was given or generated.
 * - `NoMatchingRow`: `upsert` with `returning: true` had a `where` that can never match.
 * - `UnexpectedResult`: the driver returned a shape the adapter cannot decode.
 * - `Decode`: a stored value could not be turned into its column type (for example malformed JSON text).
 */
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

/**
 * The database has no FumaDB settings for this namespace, so no schema version
 * has been applied yet. Run the migrator first.
 */
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

/**
 * Migration planning or execution failed.
 *
 * - `AlreadyUpToDate`: `up` with no next version.
 * - `NoPrevious`: `down` with no previous version.
 * - `UnknownVersion`: the requested version is not in the schema list.
 * - `Unsupported`: the adapter or provider cannot perform the requested operation.
 * - `Introspection`: the database could not be read into a schema.
 * - `Execution`: a statement failed while applying the migration. `cause` holds the driver error and `statement` the SQL text.
 */
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
