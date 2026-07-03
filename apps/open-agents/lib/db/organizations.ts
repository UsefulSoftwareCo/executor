import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "./client";
import { organizationMembers, organizations, users } from "./schema";

export const DEFAULT_ORGANIZATION_SLUG = "goaugment";
export const OPEN_AGENTS_SYSTEM_USER_ID = "open-agents-system";

async function ensureOpenAgentsSystemUser(): Promise<void> {
  const now = new Date();

  await db
    .insert(users)
    .values({
      id: OPEN_AGENTS_SYSTEM_USER_ID,
      username: OPEN_AGENTS_SYSTEM_USER_ID,
      email: null,
      emailVerified: true,
      name: "Open Agents System",
      avatarUrl: null,
      isAdmin: true,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        username: OPEN_AGENTS_SYSTEM_USER_ID,
        emailVerified: true,
        name: "Open Agents System",
        isAdmin: true,
        updatedAt: now,
      },
    });
}

export async function getDefaultOrganizationId(): Promise<string> {
  await ensureDefaultOrganization();

  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, DEFAULT_ORGANIZATION_SLUG))
    .limit(1);

  if (!organization) {
    throw new Error("Default organization is not configured");
  }

  return organization.id;
}

export async function ensureDefaultOrganization(): Promise<void> {
  await ensureOpenAgentsSystemUser();

  const now = new Date();
  await db
    .insert(organizations)
    .values({
      id: `org_${nanoid()}`,
      slug: DEFAULT_ORGANIZATION_SLUG,
      name: "GoAugment",
      createdBy: OPEN_AGENTS_SYSTEM_USER_ID,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: organizations.slug,
      set: {
        name: "GoAugment",
        updatedAt: now,
      },
    });

  await ensureUserDefaultOrganizationMembership(OPEN_AGENTS_SYSTEM_USER_ID, "admin");
}

export async function ensureUserDefaultOrganizationMembership(
  userId: string,
  role?: "admin" | "member",
): Promise<void> {
  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, DEFAULT_ORGANIZATION_SLUG))
    .limit(1);

  if (!organization) {
    await ensureDefaultOrganization();
    return ensureUserDefaultOrganizationMembership(userId, role);
  }

  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const membershipRole = role ?? (user?.email === "danaasbury@gmail.com" ? "admin" : "member");
  const now = new Date();

  const [existing] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, organization.id),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(organizationMembers)
      .set({
        role: existing.role === "admin" || membershipRole === "admin" ? "admin" : "member",
        updatedAt: now,
      })
      .where(
        and(
          eq(organizationMembers.orgId, organization.id),
          eq(organizationMembers.userId, userId),
        ),
      );
    return;
  }

  await db.insert(organizationMembers).values({
    orgId: organization.id,
    userId,
    role: membershipRole,
    addedBy: OPEN_AGENTS_SYSTEM_USER_ID,
    createdAt: now,
    updatedAt: now,
  });
}
