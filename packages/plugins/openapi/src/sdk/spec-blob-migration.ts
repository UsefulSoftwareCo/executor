// ---------------------------------------------------------------------------
// Data migration: move inline OpenAPI spec text out of `integration.config`
// into the blob table (`spec/<sha256>`, config keeps `specHash`) — the
// libSQL-ledger counterpart of cloud's out-of-band migrate-specs-to-blobs
// script. Runs once per database through the data-migration ledger; the
// shared body lives in @executor-js/sdk (`runSqliteConfigBlobMigration`).
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import {
  runSqliteConfigBlobMigration,
  type SqliteDataMigrationClient,
} from "@executor-js/sdk/core";

const MIGRATION_NAME = "2026-06-12-openapi-spec-to-blob";

/** Registry entry for the boot-time data-migration ledger. */
export const openApiSpecBlobDataMigration = {
  name: MIGRATION_NAME,
  run: (client: SqliteDataMigrationClient) =>
    runSqliteConfigBlobMigration(client, {
      migrationName: MIGRATION_NAME,
      pluginId: "openapi",
      inlineField: "spec",
      hashField: "specHash",
      blobKeyPrefix: "spec",
    }).pipe(Effect.asVoid),
};
