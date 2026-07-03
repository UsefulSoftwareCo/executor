// ---------------------------------------------------------------------------
// Cloud code migration: GC dead DCR `oauth_client` rows + backfill the
// surviving ones' `origin_issuer` (issue #1120, Part C).
//
// The cloud counterpart to the local libSQL boot migration
// (`sqlite-oauth-client-gc-migration` in @executor-js/sdk). It runs through the
// stamped `cloud_code_migration` ledger (see runner.ts), out-of-band via
// `scripts/migrate.ts`, with `--dry-run` support and an advisory lock.
//
// It is a CODE migration, not a numbered `.sql` one, deliberately: the DCR
// classification and the registrable-origin backfill are the SAME TypeScript
// predicates the local path and the runtime reuse lookup use
// (`classifyOAuthClientGc`, `registrableOriginOfUrl`). Re-encoding the eTLD+1
// registrable-origin logic and the DCR heuristic as Postgres regex/SQL would be
// a second, drift-prone source of truth for a migration that DELETES user data.
// Reading the (small) oauth_client table and deciding in-process keeps exactly
// one source of truth across both hosts.
// ---------------------------------------------------------------------------

import {
  classifyOAuthClientGc,
  isDcrClassifiedRow,
  registrableOriginOfUrl,
} from "@executor-js/sdk";

import type { CodeMigration, CodeMigrationContext } from "./runner";

interface OAuthClientRow {
  readonly tenant: string;
  readonly owner: string;
  readonly slug: string;
  readonly grant: string | null;
  readonly resource: string | null;
  readonly origin_kind: string | null;
  readonly origin_issuer: string | null;
  readonly token_url: string | null;
}

const readOAuthClients = (context: CodeMigrationContext): Promise<readonly OAuthClientRow[]> =>
  // `grant` is a reserved word in Postgres, so it must be quoted. Deterministic
  // row order keeps the dry-run report + logs stable.
  context.sql.unsafe<OAuthClientRow[]>(`
    SELECT
      tenant,
      owner,
      slug,
      "grant",
      resource,
      origin_kind,
      origin_issuer,
      token_url
    FROM oauth_client
    ORDER BY tenant, owner, slug
  `);

interface ConnectionCountRow {
  readonly tenant: string;
  readonly oauth_client_owner: string;
  readonly oauth_client: string;
  readonly count: string | number;
}

const referenceKey = (tenant: string, owner: string, slug: string): string =>
  `${tenant}\u0000${owner}\u0000${slug}`;

/** One grouped pass over `connection` instead of a COUNT per oauth_client row
 *  (N+1). Returns a Map from (tenant, oauth_client_owner, oauth_client) to the
 *  number of referencing connections. */
const readReferencingConnectionCounts = async (
  context: CodeMigrationContext,
): Promise<ReadonlyMap<string, number>> => {
  const rows = await context.sql.unsafe<ConnectionCountRow[]>(`
    SELECT tenant, oauth_client_owner, oauth_client, COUNT(*)::int AS count
      FROM connection
     WHERE oauth_client IS NOT NULL
     GROUP BY tenant, oauth_client_owner, oauth_client
  `);
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(
      referenceKey(row.tenant, row.oauth_client_owner, row.oauth_client),
      Number(row.count ?? 0),
    );
  }
  return counts;
};

export const gcDeadDcrOAuthClientsMigration: CodeMigration = {
  name: "2026-07-02-gc-dead-dcr-oauth-clients",
  run: async (context) => {
    const rows = await readOAuthClients(context);
    const referenceCounts = await readReferencingConnectionCounts(context);

    let deleted = 0;
    let backfilled = 0;
    let referencedDcr = 0;
    let stampedDcr = 0;
    let stampedManual = 0;

    for (const row of rows) {
      const isDcr = isDcrClassifiedRow(row);

      // Manual apps are never deleted or issuer-backfilled, but a legacy (null
      // origin_kind) manual row still gets an explicit `manual` stamp so every
      // surviving row ends this migration with a concrete classification.
      if (!isDcr) {
        if (row.origin_kind == null) {
          if (!context.dryRun) {
            await context.sql.unsafe(
              `UPDATE oauth_client SET origin_kind = 'manual'
                WHERE tenant = $1 AND owner = $2 AND slug = $3`,
              [row.tenant, row.owner, row.slug],
            );
          }
          stampedManual += 1;
        }
        continue;
      }

      const count = referenceCounts.get(referenceKey(row.tenant, row.owner, row.slug)) ?? 0;
      const decision = classifyOAuthClientGc(row, count);

      if (decision.action === "delete") {
        if (!context.dryRun) {
          await context.sql.unsafe(
            `DELETE FROM oauth_client WHERE tenant = $1 AND owner = $2 AND slug = $3`,
            [row.tenant, row.owner, row.slug],
          );
        }
        deleted += 1;
        continue;
      }

      referencedDcr += 1;
      // Surviving DCR row. Stamp a legacy (null origin_kind) survivor as DCR,
      // and backfill its `origin_issuer` from the registrable origin of
      // token_url when it has none, so the per-AS reuse lookup keys on it and
      // mints no new duplicate. Both fold into one UPDATE per row.
      const setClauses: string[] = [];
      const setArgs: unknown[] = [];
      if (row.origin_kind == null) {
        setClauses.push(`origin_kind = 'dynamic_client_registration'`);
        stampedDcr += 1;
      }
      if (row.origin_issuer == null) {
        const issuer = row.token_url == null ? null : registrableOriginOfUrl(row.token_url);
        if (issuer !== null) {
          setArgs.push(issuer);
          setClauses.push(`origin_issuer = $${setArgs.length}`);
          backfilled += 1;
        }
      }
      if (setClauses.length > 0 && !context.dryRun) {
        const whereBase = setArgs.length;
        await context.sql.unsafe(
          `UPDATE oauth_client SET ${setClauses.join(", ")}
            WHERE tenant = $${whereBase + 1} AND owner = $${whereBase + 2} AND slug = $${whereBase + 3}`,
          [...setArgs, row.tenant, row.owner, row.slug],
        );
      }
    }

    const verb = context.dryRun ? "would delete" : "deleted";
    const backfillVerb = context.dryRun ? "would backfill" : "backfilled";
    const stampVerb = context.dryRun ? "would stamp" : "stamped";
    return {
      summary:
        `${rows.length} oauth_client row(s): ${verb} ${deleted} orphaned DCR client(s), ` +
        `${backfillVerb} ${backfilled} of ${referencedDcr} referenced DCR client(s), ` +
        `${stampVerb} ${stampedDcr + stampedManual} legacy row(s) ` +
        `(${stampedDcr} dcr, ${stampedManual} manual)`,
    };
  },
};
