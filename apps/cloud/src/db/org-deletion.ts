// ---------------------------------------------------------------------------
// Organization data purge — removes every local trace of an org in one txn
// ---------------------------------------------------------------------------
//
// Identity (accounts/organizations/memberships) and executor tenant data
// (integrations, connections, tools, secrets, ...) share ONE Postgres database
// (`combinedSchema` in `db.ts`), so deleting an org is a single transaction
// here rather than a fan-out across stores. Tenant rows carry the org id in a
// `tenant` column; secrets/tokens live in `blob`, namespaced by owner.
//
// External side effects (the WorkOS org, the Autumn customer) are NOT touched
// here — the caller (auth handler) sequences those around this purge.
//
// The `organizations` row itself is NOT deleted: it stays as a TOMBSTONE,
// marked `deleted_at`, with its memberships removed. The membership mirror's
// feeders write whatever WorkOS payload they hold — a login that fetched its
// membership list before the deletion can write it after this purge — and
// the tombstone is what makes those writes refuse: `upsertOrganization`
// never re-mints or renames a marked organization, and the mirror never
// inserts a membership of one. Without it the login would insert a fresh,
// live organization row plus an active membership, and the deleted
// organization would authorize again.

import { eq, or, sql } from "drizzle-orm";

import type { DrizzleDb } from "./db";
import { memberships, organizations } from "./schema";
import {
  artifact,
  blob,
  connection,
  definition,
  integration,
  oauth_client,
  oauth_session,
  plugin_storage,
  subject,
  tool,
  tool_call_log,
  tool_policy,
} from "./executor-schema";

// Escape LIKE wildcards (`\`, `%`, `_`) in the org id before using it as a
// prefix. WorkOS org ids contain underscores, and a bare `_` in a LIKE pattern
// matches any character, which would widen the match to unrelated tenants.
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, "\\$&");

/**
 * Delete all rows owned by `organizationId`: every executor tenant table, the
 * org's secret blobs (org- and user-scoped), and its local `memberships` —
 * and mark the identity row deleted as of `deletedAt` (an earlier mark
 * stands), keeping it as a tombstone. Idempotent — a second run deletes
 * nothing and keeps the first mark.
 */
export const purgeOrganizationData = (
  db: DrizzleDb,
  organizationId: string,
  deletedAt: Date,
): Promise<void> =>
  db.transaction(async (tx) => {
    // Executor tenant tables — every row is scoped by `tenant = organizationId`.
    await tx.delete(tool).where(eq(tool.tenant, organizationId));
    await tx.delete(definition).where(eq(definition.tenant, organizationId));
    await tx.delete(connection).where(eq(connection.tenant, organizationId));
    await tx.delete(integration).where(eq(integration.tenant, organizationId));
    await tx.delete(oauth_client).where(eq(oauth_client.tenant, organizationId));
    await tx.delete(oauth_session).where(eq(oauth_session.tenant, organizationId));
    await tx.delete(tool_policy).where(eq(tool_policy.tenant, organizationId));
    await tx.delete(plugin_storage).where(eq(plugin_storage.tenant, organizationId));
    await tx.delete(subject).where(eq(subject.tenant, organizationId));
    await tx.delete(artifact).where(eq(artifact.tenant, organizationId));
    // The audit trail is org data like any other: a deleted org keeps no rows.
    await tx.delete(tool_call_log).where(eq(tool_call_log.tenant, organizationId));

    // Secrets, OAuth tokens, and cached specs live in `blob`, namespaced by
    // owner: `o:<org>/<plugin>` (org scope) and `u:<org>:<subject>/<plugin>`
    // (per-user scope). Match both prefixes for this org.
    const esc = escapeLike(organizationId);
    await tx
      .delete(blob)
      .where(
        or(
          sql`${blob.namespace} LIKE ${`o:${esc}/%`} ESCAPE '\\'`,
          sql`${blob.namespace} LIKE ${`u:${esc}:%`} ESCAPE '\\'`,
        ),
      );

    // Identity mirror: the memberships go, the organization row stays as a
    // tombstone (see the header). `accounts` are intentionally left: a user
    // may belong to other orgs.
    await tx.delete(memberships).where(eq(memberships.organizationId, organizationId));
    await tx
      .update(organizations)
      .set({
        deletedAt: sql`coalesce(${organizations.deletedAt}, ${deletedAt.toISOString()}::timestamptz)`,
      })
      .where(eq(organizations.id, organizationId));
  });
