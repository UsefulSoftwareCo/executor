import { randomBytes } from "node:crypto";
import type { BetterAuthInstance, BetterAuthDbClient } from "./shared";

export interface SeedConfig {
  readonly orgSlug: string;
  readonly bootstrapAdminEmail?: string;
  readonly bootstrapAdminPassword?: string;
  readonly bootstrapAdminName?: string;
  readonly organizationName: string;
}

export const seedOrgAndAdmin = async (
  auth: BetterAuthInstance,
  client: BetterAuthDbClient,
  config: SeedConfig,
): Promise<{ organizationId: string; organizationName: string }> => {
  const result = await client.execute(
    "SELECT id, name, slug FROM organization ORDER BY createdAt ASC LIMIT 1",
  );
  const existingOrg = result.rows[0] as { id: string; name: string; slug: string } | undefined;
  if (existingOrg) {
    if (existingOrg.slug !== config.orgSlug) {
      await client.execute("UPDATE organization SET slug = ? WHERE id = ?", [
        config.orgSlug,
        existingOrg.id,
      ]);
    }
    return { organizationId: existingOrg.id, organizationName: existingOrg.name };
  }

  if (config.bootstrapAdminEmail && config.bootstrapAdminPassword) {
    const userResult = await client.execute("SELECT id FROM user WHERE email = ?", [
      config.bootstrapAdminEmail,
    ]);
    const existingUser = userResult.rows[0] as { id: string } | undefined;
    let adminId = existingUser?.id;
    if (!adminId) {
      const created = await auth.api.createUser({
        body: {
          email: config.bootstrapAdminEmail,
          password: config.bootstrapAdminPassword,
          name: config.bootstrapAdminName ?? "Admin",
          role: "admin",
        },
      });
      adminId = created.user.id;
    }
    const org = await auth.api.createOrganization({
      body: { name: config.organizationName, slug: config.orgSlug, userId: adminId },
    });
    if (!org) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: org creation must succeed for a usable instance
      throw new Error("Failed to create the bootstrap organization");
    }
    return { organizationId: org.id, organizationName: config.organizationName };
  }

  const organizationId = randomBytes(16).toString("hex");
  await client.execute("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)", [
    organizationId,
    config.organizationName,
    config.orgSlug,
    new Date().toISOString(),
  ]);
  return { organizationId, organizationName: config.organizationName };
};
