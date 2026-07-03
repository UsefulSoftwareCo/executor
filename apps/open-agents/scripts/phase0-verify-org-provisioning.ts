import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
import {
  DEFAULT_ORGANIZATION_SLUG,
  ensureUserDefaultOrganizationMembership,
} from "../lib/db/organizations";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: join(appDir, ".env.local") });
dotenv.config({ path: join(appDir, ".env.development.local") });

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error("POSTGRES_URL is required");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
const probeUserId = "phase0-membership-probe";

try {
  await sql`
    insert into users (
      id,
      username,
      email,
      email_verified,
      name,
      is_admin,
      created_at,
      updated_at,
      last_login_at
    )
    values (
      ${probeUserId},
      ${probeUserId},
      'phase0-membership-probe@example.com',
      true,
      'Phase 0 Membership Probe',
      false,
      now(),
      now(),
      now()
    )
    on conflict (id) do update set
      updated_at = now(),
      last_login_at = now()
  `;

  await ensureUserDefaultOrganizationMembership(probeUserId);

  const [membership] = await sql<{ org_id: string; role: string }[]>`
    select organization_members.org_id, organization_members.role
    from organization_members
    inner join organizations on organizations.id = organization_members.org_id
    where organizations.slug = ${DEFAULT_ORGANIZATION_SLUG}
      and organization_members.user_id = ${probeUserId}
  `;

  if (!membership) {
    throw new Error("probe user was not provisioned into the default organization");
  }

  if (membership.role !== "member") {
    throw new Error(`probe user should be member, got ${membership.role}`);
  }

  console.log(
    JSON.stringify(
      {
        probeUserId,
        orgId: membership.org_id,
        role: membership.role,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end();
}
