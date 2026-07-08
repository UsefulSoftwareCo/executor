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

import { eq, or, sql } from "drizzle-orm";

import type { DrizzleDb } from "./db";
import { organizations } from "./schema";
import {
  blob,
  connection,
  definition,
  integration,
  oauth_client,
  oauth_session,
  plugin_storage,
  tool,
  tool_policy,
} from "./executor-schema";

// Escape LIKE wildcards (`\`, `%`, `_`) in the org id before using it as a
// prefix. WorkOS org ids contain underscores, and a bare `_` in a LIKE pattern
// matches any character, which would widen the match to unrelated tenants.
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, "\\$&");

/**
 * Delete all rows owned by `organizationId`: every executor tenant table, the
 * org's secret blobs (org- and user-scoped), and the identity mirror row (which
 * cascades to local `memberships`). Idempotent — a second run deletes nothing.
 */
export const purgeOrganizationData = (db: DrizzleDb, organizationId: string): Promise<void> =>
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

    // Identity mirror — FK `ON DELETE CASCADE` removes local memberships too.
    // `accounts` are intentionally left: a user may belong to other orgs.
    await tx.delete(organizations).where(eq(organizations.id, organizationId));
  });
