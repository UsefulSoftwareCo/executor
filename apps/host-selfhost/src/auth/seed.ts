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
  const adminEmail = config.bootstrapAdminEmail ?? "admin@localhost";

  // 1. Bootstrap admin (idempotent: look up by email first).
  // oxlint-disable-next-line executor/no-double-cast -- boundary: the SELECT column is the schema contract for the Better Auth `user` row read off the libSQL client
  const existingUser = (
    await client.execute({ sql: "SELECT id FROM user WHERE email = ?", args: [adminEmail] })
  ).rows[0] as unknown as { id: string } | undefined;
  let adminId = existingUser?.id;
  if (!adminId) {
    const password = config.bootstrapAdminPassword ?? randomBytes(18).toString("base64url");
    const created = await auth.api.createUser({
      body: { email: adminEmail, password, name: config.bootstrapAdminName, role: "admin" },
    });
    adminId = created.user.id;
    if (!config.bootstrapAdminPassword) {
      console.warn(
        `[executor] created bootstrap admin "${adminEmail}" with a generated password: ${password}\n` +
          `[executor] set EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD to choose your own and silence this.`,
      );
    }
  }

  // 2. The single organization (idempotent: look up by slug first).
  // oxlint-disable-next-line executor/no-double-cast -- boundary: the SELECT columns are the schema contract for the Better Auth `organization` row read off the libSQL client
  const existingOrg = (
    await client.execute({
      sql: "SELECT id, name FROM organization WHERE slug = ?",
      args: [config.orgSlug],
    })
  ).rows[0] as unknown as { id: string; name: string } | undefined;
  if (existingOrg) {
    return { organizationId: existingOrg.id, organizationName: existingOrg.name };
  }

  // System action: pass userId so the org is created with no session and the
  // admin becomes its owner (creates the membership row).
  const org = await auth.api.createOrganization({
    body: { name: config.organizationName, slug: config.orgSlug, userId: adminId },
  });
  if (!org) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: org creation must succeed for a usable instance
    throw new Error("Failed to create the bootstrap organization");
  }
  return { organizationId: org.id, organizationName: config.organizationName };
};
