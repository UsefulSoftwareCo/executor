import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: join(appDir, ".env.local") });
dotenv.config({ path: join(appDir, ".env.development.local") });

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error("POSTGRES_URL is required");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function count(query: Promise<Array<{ count: string | number | bigint }>>): Promise<number> {
  const rows = await query;
  return Number(rows[0]?.count ?? 0);
}

try {
  const requiredTables = [
    "organizations",
    "organization_members",
    "groups",
    "group_members",
    "docs",
  ];

  const tableRows = await sql<{ table_name: string }[]>`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in ${sql(requiredTables)}
  `;
  const tables = new Set(tableRows.map((row) => row.table_name));
  for (const table of requiredTables) {
    assert(tables.has(table), `missing table ${table}`);
  }

  const columnRows = await sql<{ table_name: string; column_name: string; is_nullable: string }[]>`
    select table_name, column_name, is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and (
        (table_name = 'sessions' and column_name in ('scope_kind', 'scope_id')) or
        (table_name = 'chats' and column_name in ('scope_kind', 'scope_id')) or
        (table_name = 'docs' and column_name in ('scope_kind', 'scope_id', 'created_by'))
      )
  `;
  const columnKey = (table: string, column: string) => `${table}.${column}`;
  const columns = new Map(columnRows.map((row) => [columnKey(row.table_name, row.column_name), row]));

  for (const column of ["scope_kind", "scope_id"]) {
    const sessionColumn = columns.get(columnKey("sessions", column));
    assert(sessionColumn, `missing sessions.${column}`);
    assert(sessionColumn.is_nullable === "NO", `sessions.${column} must be not null`);

    const chatColumn = columns.get(columnKey("chats", column));
    assert(chatColumn, `missing chats.${column}`);
    assert(chatColumn.is_nullable === "YES", `chats.${column} must be nullable override`);
  }

  for (const column of ["scope_kind", "scope_id", "created_by"]) {
    const docColumn = columns.get(columnKey("docs", column));
    assert(docColumn, `missing docs.${column}`);
    assert(docColumn.is_nullable === "NO", `docs.${column} must be not null`);
  }

  const indexRows = await sql<{ index_name: string }[]>`
    select indexname as index_name
    from pg_indexes
    where schemaname = 'public'
      and indexname in (
        'organizations_slug_idx',
        'groups_slack_channel_idx',
        'sessions_scope_idx',
        'chats_scope_idx',
        'docs_scope_idx'
      )
  `;
  const indexes = new Set(indexRows.map((row) => row.index_name));
  for (const index of [
    "organizations_slug_idx",
    "groups_slack_channel_idx",
    "sessions_scope_idx",
    "chats_scope_idx",
    "docs_scope_idx",
  ]) {
    assert(indexes.has(index), `missing index ${index}`);
  }

  const [systemUser] = await sql<{ id: string }[]>`
    select id from users where id = 'open-agents-system'
  `;
  assert(systemUser, "missing open-agents-system user");

  const [org] = await sql<{ id: string; slug: string; name: string }[]>`
    select id, slug, name from organizations where slug = 'goaugment'
  `;
  assert(org, "missing goaugment organization");

  const userCount = await count(sql`select count(*) from users`);
  const memberCount = await count(sql`
    select count(*)
    from organization_members
    where org_id = ${org.id}
  `);
  assert(memberCount === userCount, `organization member count ${memberCount} does not match users ${userCount}`);

  const adminCount = await count(sql`
    select count(*)
    from organization_members
    where org_id = ${org.id} and role = 'admin'
  `);
  assert(adminCount >= 1, "goaugment organization needs at least one admin");

  const nullSessionScopes = await count(sql`
    select count(*)
    from sessions
    where scope_kind is null or scope_id is null
  `);
  assert(nullSessionScopes === 0, `found ${nullSessionScopes} sessions with null scope`);

  const nonUserSessionScopes = await count(sql`
    select count(*)
    from sessions
    where scope_kind <> 'user' or scope_id <> user_id
  `);
  assert(nonUserSessionScopes === 0, `found ${nonUserSessionScopes} pre-existing sessions not backfilled to user scope`);

  const defaultOrgLibraryRows = await count(sql`
    select count(*)
    from agent_library_items
    where scope_kind = 'org' and scope_id = 'default'
  `);
  assert(defaultOrgLibraryRows === 0, `found ${defaultOrgLibraryRows} org library rows still using default scope id`);

  const legacyDefinitionScopes = await count(sql`
    select count(*)
    from automation_definitions
    where scope_kind not in ('user', 'group', 'org')
  `);
  assert(legacyDefinitionScopes === 0, `found ${legacyDefinitionScopes} automation definitions with legacy scopes`);

  const legacyEventScopes = await count(sql`
    select count(*)
    from automation_events
    where scope_kind not in ('user', 'group', 'org')
  `);
  assert(legacyEventScopes === 0, `found ${legacyEventScopes} automation events with legacy scopes`);

  const systemAdminCount = await count(sql`
    select count(*)
    from organization_members
    where org_id = ${org.id}
      and user_id = 'open-agents-system'
      and role = 'admin'
  `);
  assert(systemAdminCount === 1, "open-agents-system must be an org admin");

  const summary = {
    orgId: org.id,
    systemUserId: systemUser.id,
    users: userCount,
    organizationMembers: memberCount,
    organizationAdmins: adminCount,
    systemAdminMemberships: systemAdminCount,
    sessionsWithoutScope: nullSessionScopes,
    defaultOrgLibraryRows,
    legacyAutomationDefinitionScopes: legacyDefinitionScopes,
    legacyAutomationEventScopes: legacyEventScopes,
    scopeKindStorage: "text columns by existing Drizzle convention; canonical values verified in stored rows",
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await sql.end();
}
