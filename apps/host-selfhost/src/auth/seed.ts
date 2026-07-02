import { randomBytes } from "node:crypto";

import type { Client } from "@libsql/client";

import type { SelfHostConfig } from "../config";
import type { Auth } from "./better-auth";

// ---------------------------------------------------------------------------
// Idempotent first-boot bootstrap: ensure the single organization and a
// bootstrap admin exist. Uses server-side auth.api calls (no session, no CLI)
// and queries the freshly-migrated Better Auth tables directly (through
// SelfHostDb's libSQL client — the SAME file Better Auth migrated, proving the
// cross-connection invariant) to stay idempotent across restarts. Returns the
// resolved org id/name, which the session-pin hook and the AuthProvider's
// org-name cache read.
// ---------------------------------------------------------------------------

export const seedOrgAndAdmin = async (
  auth: Auth,
  client: Client,
  config: SelfHostConfig,
): Promise<{ organizationId: string; organizationName: string }> => {
  // Idempotent: once the single organization exists, boot is past first-run.
  // This instance is SINGLE-org, so adopt whatever organization exists rather
  // than looking it up by slug — matching on slug would silently create a
  // second org (forking the instance) the first boot after EXECUTOR_ORG_SLUG
  // changes. A changed slug is a rename of the one org, applied here.
  // oxlint-disable-next-line executor/no-double-cast -- boundary: the SELECT columns are the schema contract for the Better Auth `organization` row read off the libSQL client
  const existingOrg = (
    await client.execute({
      sql: "SELECT id, name, slug FROM organization ORDER BY createdAt ASC LIMIT 1",
      args: [],
    })
  ).rows[0] as unknown as { id: string; name: string; slug: string } | undefined;
  if (existingOrg) {
    if (existingOrg.slug !== config.orgSlug) {
      await client.execute({
        sql: "UPDATE organization SET slug = ? WHERE id = ?",
        args: [config.orgSlug, existingOrg.id],
      });
    }
    return { organizationId: existingOrg.id, organizationName: existingOrg.name };
  }

  // Headless bootstrap: when BOTH admin email and password are set, pre-create
  // that admin as the org owner (CI / infra-as-code). Otherwise fall through to
  // the turnkey path so the first browser visitor claims the instance.
  if (config.bootstrapAdminEmail && config.bootstrapAdminPassword) {
    // oxlint-disable-next-line executor/no-double-cast -- boundary: the SELECT column is the schema contract for the Better Auth `user` row read off the libSQL client
    const existingUser = (
      await client.execute({
        sql: "SELECT id FROM user WHERE email = ?",
        args: [config.bootstrapAdminEmail],
      })
    ).rows[0] as unknown as { id: string } | undefined;
    let adminId = existingUser?.id;
    if (!adminId) {
      const created = await auth.api.createUser({
        body: {
          email: config.bootstrapAdminEmail,
          password: config.bootstrapAdminPassword,
          name: config.bootstrapAdminName,
          role: "admin",
        },
      });
      adminId = created.user.id;
    }
    // Pass userId so the org is created with no session and the admin becomes
    // its owner (creates the membership row).
    const org = await auth.api.createOrganization({
      body: { name: config.organizationName, slug: config.orgSlug, userId: adminId },
    });
    if (!org) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: org creation must succeed for a usable instance
      throw new Error("Failed to create the bootstrap organization");
    }
    return { organizationId: org.id, organizationName: config.organizationName };
  }

  // Turnkey first-run: create the single organization with NO members. The
  // first person to open the app signs up ungated and becomes the owner (the
  // signup gate enforces this — an org with zero members is unclaimed).
  const organizationId = randomBytes(16).toString("hex");
  await client.execute({
    sql: "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    args: [organizationId, config.organizationName, config.orgSlug, new Date().toISOString()],
  });
  return { organizationId, organizationName: config.organizationName };
};
