// ---------------------------------------------------------------------------
// Data migration: move inline GraphQL introspection snapshots out of
// `integration.config` into the blob table (`introspection/<sha256>`, config
// keeps `introspectionHash`) — the libSQL-ledger counterpart of cloud's
// out-of-band migrate-specs-to-blobs script. Runs once per database through
// the data-migration ledger; the shared body lives in @executor-js/sdk
// (`runSqliteConfigBlobMigration`).
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import {
  runSqliteConfigBlobMigration,
  type SqliteDataMigrationClient,
} from "@executor-js/sdk/core";

const MIGRATION_NAME = "2026-06-12-graphql-introspection-to-blob";

/** Registry entry for the boot-time data-migration ledger. */
export const graphqlIntrospectionBlobDataMigration = {
  name: MIGRATION_NAME,
  run: (client: SqliteDataMigrationClient) =>
    runSqliteConfigBlobMigration(client, {
      migrationName: MIGRATION_NAME,
      pluginId: "graphql",
      inlineField: "introspectionJson",
      hashField: "introspectionHash",
      blobKeyPrefix: "introspection",
    }).pipe(Effect.asVoid),
};
