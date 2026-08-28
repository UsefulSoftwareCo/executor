// ---------------------------------------------------------------------------
// The ordered boot-time data-migration registry for the selfhost app.
// Entries run once and are stamped in the `data_migration` ledger (see
// @executor-js/sdk sqlite-data-migrations). Names are append-only and never
// renamed.
// ---------------------------------------------------------------------------

import {
  bigintStorageClassSqliteMigration,
  sqliteDataMigration,
  type SqliteDataMigration,
} from "@executor-js/sdk";
import { runSqliteAuthConfigMigration } from "@executor-js/sdk/http-auth";
import {
  openApiNdjsonOutputDataMigration,
  openApiOutputSchemaDataMigration,
  openApiSpecBlobDataMigration,
} from "@executor-js/plugin-openapi";
import { graphqlIntrospectionBlobDataMigration } from "@executor-js/plugin-graphql";
import { googleOpenApiOwnershipDataMigration } from "@executor-js/plugin-openapi/providers/google";

import { providerServiceSplitDataMigration } from "@executor-js/plugin-provider-service-split";
import { encryptedSecretsRepartitionDataMigration } from "@executor-js/plugin-encrypted-secrets";
import { authConfigTransforms } from "./auth-config-migration";

export const selfHostDataMigrations: readonly SqliteDataMigration[] = [
  // FIRST, because it un-bricks reads every later migration and the whole app
  // depend on: `bigint` columns an older build left in SQLite's INTEGER storage
  // class cannot be read by the bigint row mapper, so a single legacy
  // `connection.expires_at` failed every catalog read (issue #1771).
  bigintStorageClassSqliteMigration,
  // Rewrite pre-canonical integration auth configs into the shared
  // placements model.
  sqliteDataMigration("2026-06-05-auth-config-placements", (client) =>
    runSqliteAuthConfigMigration(client, authConfigTransforms),
  ),
  // Unwrap the retired {status, headers, data} transport envelope from
  // persisted openapi tool output schemas (mirrors cloud's drizzle 0002).
  openApiOutputSchemaDataMigration,
  // Move inline spec / introspection text out of integration.config into the
  // blob table (config keeps the content hash). Mirrors cloud's
  // migrate-specs-to-blobs script.
  openApiSpecBlobDataMigration,
  graphqlIntrospectionBlobDataMigration,
  googleOpenApiOwnershipDataMigration,
  providerServiceSplitDataMigration,
  // Stale-mark connections whose operations return NDJSON so their tool rows
  // rebuild with array-wrapped output schemas (mirrors cloud's drizzle 0010).
  openApiNdjsonOutputDataMigration,
  // Re-file credential rows the pre-fix provider stored under the acting
  // caller's partition instead of the owner embedded in the item id (#1453).
  encryptedSecretsRepartitionDataMigration,
];
