// ---------------------------------------------------------------------------
// The per-plugin auth-config transforms the one-off boot migration runs over
// the `integration` table (see `runSqliteAuthConfigMigration`). Each plugin
// owns the rewrite of its own legacy config shapes into the canonical
// placements model; this map only routes by `plugin_id`.
// ---------------------------------------------------------------------------

import type { AuthConfigTransform } from "@executor-js/sdk/http-auth";
import { migrateGraphqlAuthConfig } from "@executor-js/plugin-graphql";
import { migrateMcpAuthConfig } from "@executor-js/plugin-mcp";
import { migrateOpenApiAuthConfig } from "@executor-js/plugin-openapi";

export const authConfigTransforms: Record<string, AuthConfigTransform> = {
  mcp: migrateMcpAuthConfig,
  graphql: migrateGraphqlAuthConfig,
  openapi: migrateOpenApiAuthConfig,
};
