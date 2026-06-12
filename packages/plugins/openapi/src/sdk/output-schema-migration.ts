// ---------------------------------------------------------------------------
// Data migration: unwrap the retired {status, headers, data} transport
// envelope from persisted OpenAPI tool output schemas. The runtime returns
// the upstream payload as `data` (status/headers live in the ToolResult
// `http` side channel), so persisted schemas must describe the payload
// only — otherwise describe previews show an envelope invocations no
// longer return. Mirrors the cloud drizzle migration
// (apps/cloud/drizzle/0002_unwrap_openapi_output_envelope.sql) for the
// libSQL-backed apps, where it runs once through the data-migration ledger.
//
// Idempotent: payload-shaped rows don't match the envelope signature, so
// re-running plans zero updates.
// ---------------------------------------------------------------------------

import { Effect, Option, Schema } from "effect";
import { DataMigrationError, type SqliteDataMigrationClient } from "@executor-js/sdk/core";

const MIGRATION_NAME = "2026-06-11-openapi-output-envelope-unwrap";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// `{"type": "integer"}` — the envelope's `status` property schema, exactly.
const isEnvelopeStatusSchema = (value: unknown): boolean =>
  isRecord(value) && Object.keys(value).length === 1 && value.type === "integer";

// `{"type": "object", "additionalProperties": {"type": "string"}}` — the
// envelope's `headers` property schema, exactly.
const isEnvelopeHeadersSchema = (value: unknown): boolean =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  value.type === "object" &&
  isRecord(value.additionalProperties) &&
  Object.keys(value.additionalProperties).length === 1 &&
  value.additionalProperties.type === "string";

/**
 * If `schema` is the retired transport envelope, return the payload schema
 * to persist instead (`null` when the envelope carried an empty `{}` data
 * schema — the new producer persists no output schema for those). Returns
 * undefined when the schema is not an envelope and the row must be left
 * untouched.
 */
export const unwrapOpenApiTransportEnvelope = (
  schema: unknown,
): { readonly outputSchema: unknown | null } | undefined => {
  if (!isRecord(schema)) return undefined;
  if (schema.type !== "object" || schema.additionalProperties !== false) return undefined;
  const required = schema.required;
  if (!Array.isArray(required) || required.length !== 3) return undefined;
  if (!["status", "headers", "data"].every((key) => required.includes(key))) return undefined;
  const properties = schema.properties;
  if (!isRecord(properties) || !("data" in properties)) return undefined;
  if (!isEnvelopeStatusSchema(properties.status)) return undefined;
  if (!isEnvelopeHeadersSchema(properties.headers)) return undefined;
  const data = properties.data;
  const outputSchema = isRecord(data) && Object.keys(data).length === 0 ? null : data;
  return { outputSchema };
};

const decodeJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

const execute = (
  client: SqliteDataMigrationClient,
  stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
) =>
  Effect.tryPromise({
    try: () => client.execute(stmt),
    catch: (cause) => new DataMigrationError({ migration: MIGRATION_NAME, cause }),
  });

/** Unwrap envelope-shaped openapi tool output schemas in a SQLite database.
 *  Returns the number of rows rewritten. The `tool` table may not exist yet
 *  on a fresh database — that counts as nothing to migrate. */
export const runSqliteOpenApiOutputSchemaMigration = (
  client: SqliteDataMigrationClient,
): Effect.Effect<number, DataMigrationError> =>
  Effect.gen(function* () {
    const exists = yield* execute(
      client,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool'",
    );
    if (exists.rows.length === 0) return 0;

    const result = yield* execute(
      client,
      "SELECT row_id, output_schema FROM tool WHERE plugin_id = 'openapi' AND output_schema IS NOT NULL",
    );
    const updates: { readonly rowId: string; readonly outputSchema: unknown | null }[] = [];
    for (const row of result.rows) {
      if (typeof row.row_id !== "string" || typeof row.output_schema !== "string") continue;
      const schema = decodeJsonOption(row.output_schema);
      if (Option.isNone(schema)) continue;
      const unwrapped = unwrapOpenApiTransportEnvelope(schema.value);
      if (unwrapped !== undefined) updates.push({ rowId: row.row_id, ...unwrapped });
    }
    if (updates.length === 0) return 0;

    const applyAll = Effect.gen(function* () {
      for (const update of updates) {
        yield* execute(client, {
          sql: "UPDATE tool SET output_schema = ? WHERE row_id = ?",
          args: [
            update.outputSchema === null ? null : JSON.stringify(update.outputSchema),
            update.rowId,
          ],
        });
      }
      yield* execute(client, "COMMIT");
    });

    yield* execute(client, "BEGIN");
    yield* applyAll.pipe(Effect.tapError(() => execute(client, "ROLLBACK").pipe(Effect.ignore)));
    return updates.length;
  });

/** Registry entry for the boot-time data-migration ledger. */
export const openApiOutputSchemaDataMigration = {
  name: MIGRATION_NAME,
  run: (client: SqliteDataMigrationClient) =>
    runSqliteOpenApiOutputSchemaMigration(client).pipe(Effect.asVoid),
};
