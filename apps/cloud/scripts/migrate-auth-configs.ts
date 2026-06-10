/* oxlint-disable executor/no-try-catch-or-throw, executor/no-json-parse -- boundary: out-of-band migration script over a raw postgres connection */
// ---------------------------------------------------------------------------
// One-off data migration: rewrite pre-canonical integration auth configs
// into the shared placements model. Run OUT-OF-BAND against the database
// BEFORE deploying code that only decodes the canonical shape (the same
// rule as schema migrations — Workers never migrate at request time):
//
//   bun run db:migrate-auth:prod      # op run --env-file=.env.production
//   bun run db:migrate-auth:dev       # against the local PGlite dev db
//
// Idempotent — canonical rows plan zero updates, so re-running is safe.
// Pass --dry-run to print the plan without writing.
// ---------------------------------------------------------------------------

import postgres from "postgres";
import { planAuthConfigMigration, type AuthConfigMigrationRow } from "@executor-js/sdk/http-auth";
import { migrateGraphqlAuthConfig } from "@executor-js/plugin-graphql";
import { migrateMcpAuthConfig } from "@executor-js/plugin-mcp";
import { migrateOpenApiAuthConfig } from "@executor-js/plugin-openapi";

const transforms = {
  mcp: migrateMcpAuthConfig,
  graphql: migrateGraphqlAuthConfig,
  openapi: migrateOpenApiAuthConfig,
};

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

const sql = postgres(connectionString, { max: 1, prepare: false });

try {
  const rows = await sql<{ row_id: string; plugin_id: string; config: unknown }[]>`
    SELECT row_id, plugin_id, config FROM integration
  `;

  const inputs: AuthConfigMigrationRow[] = rows.map((row) => ({
    rowId: row.row_id,
    pluginId: row.plugin_id,
    // postgres-js parses json columns; tolerate text just in case.
    config: typeof row.config === "string" ? JSON.parse(row.config) : row.config,
  }));

  const updates = planAuthConfigMigration(inputs, transforms);
  console.log(`${rows.length} integration row(s), ${updates.length} to rewrite`);

  if (dryRun) {
    for (const update of updates) console.log(`  would rewrite ${update.rowId}`);
  } else if (updates.length > 0) {
    await sql.begin(async (tx) => {
      for (const update of updates) {
        await tx`
          UPDATE integration
          SET config = ${tx.json(update.config as never)}
          WHERE row_id = ${update.rowId}
        `;
      }
    });
    console.log(`rewrote ${updates.length} row(s)`);
  }
} finally {
  await sql.end();
}
