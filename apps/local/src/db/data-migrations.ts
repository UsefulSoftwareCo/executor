// ---------------------------------------------------------------------------
// The ordered boot-time data-migration registry for the local app. Entries
// run once and are stamped in the `data_migration` ledger (see
// @executor-js/sdk sqlite-data-migrations). Names are append-only and never
// renamed.
// ---------------------------------------------------------------------------

import {
  Effect,
  oauthClientGcSqliteMigration,
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
import { authConfigTransforms } from "./auth-config-migration";
import { LOCAL_V1_V2_LEDGER_NAME } from "./v1-v2-migration";

export const localDataMigrations: readonly SqliteDataMigration[] = [
  // The v1→v2 gate itself runs BEFORE the executor (and this registry) can
  // exist — see migrateLocalV1ToV2IfNeeded in executor.ts. Migrated v1 DBs are
  // stamped atomically inside the staged v2 build; fresh/pre-v2-native DBs get
  // the same stamp here so future boots skip legacy shape probing.
  { name: LOCAL_V1_V2_LEDGER_NAME, run: () => Effect.void },
  // Rewrite pre-canonical integration auth configs (incl. v1→v2 outputs)
  // into the shared placements model.
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
  // GC dead DCR oauth_client rows (old always-register duplicates) and backfill
  // the surviving DCR rows' origin_issuer from token_url (issue #1120, Part C).
  oauthClientGcSqliteMigration,
  // Stale-mark connections whose operations return NDJSON so their tool rows
  // rebuild with array-wrapped output schemas (mirrors cloud's drizzle 0010).
  openApiNdjsonOutputDataMigration,
];
