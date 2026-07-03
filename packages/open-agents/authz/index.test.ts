import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  AuthzError,
  canAccess,
  getDefaultOrgId,
  invalidateMembership,
  requireChatAccess,
  parseActor,
  requireSessionAccess,
  resolveMembership,
  serializeActor,
  type Actor,
  type OpenAgentsAuthzSql,
  type Scope,
  type Verb,
} from "./index";

const databaseUrl = process.env.POSTGRES_URL;
if (!databaseUrl) {
  throw new Error("POSTGRES_URL is required for authz tests");
}

const schemaName = `authz_test_${Date.now().toString(36)}`;
const sql = postgres(databaseUrl, { max: 1 }) as OpenAgentsAuthzSql;
const verbs = ["read", "write", "manage", "admin"] as const;

const actors = {
  member: { kind: "user", userId: "user_member" },
  manager: { kind: "user", userId: "user_manager" },
  admin: { kind: "user", userId: "user_admin" },
  outsider: { kind: "user", userId: "user_outsider" },
  otherOrgAdmin: { kind: "user", userId: "user_other_org_admin" },
  linkedSlack: { kind: "slack", teamId: "team_a", slackUserId: "slack_member" },
  anonymousSlack: { kind: "slack", teamId: "team_a", slackUserId: "slack_anonymous" },
  serviceOrg: { kind: "service", automationId: "automation_org" },
} satisfies Record<string, Actor>;

const scopes = {
  ownUser: { scopeKind: "user", scopeId: "user_member" },
  otherUser: { scopeKind: "user", scopeId: "user_outsider" },
  group: { scopeKind: "group", scopeId: "group_a" },
  org: { scopeKind: "org", scopeId: "org_a" },
} satisfies Record<string, Scope>;

beforeAll(async () => {
  await sql`create schema ${sql(schemaName)}`;
  await sql`set search_path to ${sql(schemaName)}`;
  await createTables();
  await seedData();
});

afterAll(async () => {
  await sql`drop schema if exists ${sql(schemaName)} cascade`;
  await sql.end();
});

beforeEach(() => {
  invalidateMembership();
});

describe("actor header serialization", () => {
  test("round trips canonical user, Slack, and service actors", () => {
    expect(parseActor(serializeActor(actors.member))).toEqual(actors.member);
    expect(parseActor(serializeActor(actors.anonymousSlack))).toEqual(actors.anonymousSlack);
    expect(parseActor(serializeActor(actors.serviceOrg))).toEqual(actors.serviceOrg);
  });

  test("parses legacy bare user ids as user actors", () => {
    expect(parseActor("user_member")).toEqual(actors.member);
  });
});

describe("canAccess", () => {
  test("applies each verb across user, group, and org scopes", async () => {
    await expectVerbMatrix(actors.member, scopes.ownUser, {
      read: true,
      write: true,
      manage: true,
      admin: true,
    });
    await expectVerbMatrix(actors.member, scopes.group, {
      read: true,
      write: true,
      manage: false,
      admin: false,
    });
    await expectVerbMatrix(actors.member, scopes.org, {
      read: true,
      write: true,
      manage: false,
      admin: false,
    });
  });

  test("denies non-members", async () => {
    for (const scope of [scopes.ownUser, scopes.group, scopes.org]) {
      await expectVerbMatrix(actors.outsider, scope, {
        read: false,
        write: false,
        manage: false,
        admin: false,
      });
    }
  });

  test("grants group managers manage/admin on their group", async () => {
    await expectVerbMatrix(actors.manager, scopes.group, {
      read: true,
      write: true,
      manage: true,
      admin: true,
    });
  });

  test("grants org admins access to group and org scopes", async () => {
    await expectVerbMatrix(actors.admin, scopes.group, {
      read: true,
      write: true,
      manage: true,
      admin: true,
    });
    await expectVerbMatrix(actors.admin, scopes.org, {
      read: true,
      write: true,
      manage: true,
      admin: true,
    });
  });

  test("keeps user scopes isolated from org admins", async () => {
    await expectVerbMatrix(actors.admin, scopes.ownUser, {
      read: false,
      write: false,
      manage: false,
      admin: false,
    });
    await expectVerbMatrix(actors.otherOrgAdmin, scopes.ownUser, {
      read: false,
      write: false,
      manage: false,
      admin: false,
    });
  });

  test("denies slack and service actors manage/admin", async () => {
    await expectVerbMatrix(actors.linkedSlack, scopes.group, {
      read: true,
      write: true,
      manage: false,
      admin: false,
    });
    await expectVerbMatrix(
      actors.anonymousSlack,
      scopes.org,
      {
        read: true,
        write: true,
        manage: false,
        admin: false,
      },
      { anonymousSlackOrgId: "org_a" },
    );
    await expectVerbMatrix(actors.serviceOrg, scopes.org, {
      read: true,
      write: true,
      manage: false,
      admin: false,
    });
  });
});

describe("resource helpers", () => {
  test("requireSessionAccess returns scope and honors creator admin", async () => {
    await expect(
      requireSessionAccess(actors.member, "session_group_b_created_by_member", "admin", { sql }),
    ).resolves.toEqual({ scopeKind: "group", scopeId: "group_b" });
    await expect(
      requireSessionAccess(actors.outsider, "session_group", "read", { sql }),
    ).rejects.toMatchObject({ name: "AuthzError", status: 403 });
    await expect(
      requireSessionAccess(actors.member, "missing_session", "read", { sql }),
    ).rejects.toMatchObject({ name: "AuthzError", status: 404 });
  });

  test("requireChatAccess uses chat override before session fallback", async () => {
    await expect(
      requireChatAccess(actors.manager, "chat_inherits_group", "write", { sql }),
    ).resolves.toEqual({ scopeKind: "group", scopeId: "group_a" });
    await expect(
      requireChatAccess(actors.admin, "chat_overrides_to_org", "write", { sql }),
    ).resolves.toEqual({ scopeKind: "org", scopeId: "org_a" });
    await expect(
      requireChatAccess(actors.outsider, "missing_chat", "read", { sql }),
    ).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("membership cache", () => {
  test("reuses cached memberships until invalidated", async () => {
    await expect(
      canAccess({ kind: "user", userId: "user_cache" }, scopes.org, "read", { sql }),
    ).resolves.toBe(false);

    await sql`
      insert into organization_members (org_id, user_id, role)
      values ('org_a', 'user_cache', 'member')
    `;

    await expect(
      canAccess({ kind: "user", userId: "user_cache" }, scopes.org, "read", { sql }),
    ).resolves.toBe(false);

    invalidateMembership("user_cache");

    await expect(
      canAccess({ kind: "user", userId: "user_cache" }, scopes.org, "read", { sql }),
    ).resolves.toBe(true);
  });
});

describe("organization lookup and membership resolution", () => {
  test("resolves the goaugment organization id", async () => {
    await expect(getDefaultOrgId({ sql })).resolves.toBe("org_a");
  });

  test("resolves linked slack users through their Open Agents user", async () => {
    const membership = await resolveMembership(actors.linkedSlack, { sql });

    expect([...membership.orgIds]).toEqual(["org_a"]);
    expect([...membership.groupIds]).toEqual(["group_a"]);
  });
});

async function expectVerbMatrix(
  actor: Actor,
  scope: Scope,
  expected: Record<Verb, boolean>,
  options: Parameters<typeof canAccess>[3] = { sql },
): Promise<void> {
  for (const verb of verbs) {
    await expect(canAccess(actor, scope, verb, { sql, ...options })).resolves.toBe(expected[verb]);
  }
}

async function createTables(): Promise<void> {
  await sql`
    create table organizations (
      id text primary key,
      slug text not null unique,
      name text not null,
      created_by text not null
    )
  `;
  await sql`
    create table organization_members (
      org_id text not null,
      user_id text not null,
      role text not null,
      primary key (org_id, user_id)
    )
  `;
  await sql`
    create table groups (
      id text primary key,
      org_id text not null,
      name text not null,
      source text not null,
      created_by text not null
    )
  `;
  await sql`
    create table group_members (
      group_id text not null,
      user_id text not null,
      role text not null,
      source text not null,
      primary key (group_id, user_id)
    )
  `;
  await sql`
    create table slack_user_links (
      id text primary key,
      user_id text not null,
      slack_team_id text not null,
      slack_user_id text not null
    )
  `;
  await sql`
    create table automation_definitions (
      id text primary key,
      scope_kind text not null,
      scope_id text not null
    )
  `;
  await sql`
    create table sessions (
      id text primary key,
      user_id text not null,
      scope_kind text not null,
      scope_id text not null
    )
  `;
  await sql`
    create table chats (
      id text primary key,
      session_id text not null,
      scope_kind text,
      scope_id text
    )
  `;
}

async function seedData(): Promise<void> {
  await sql`
    insert into organizations (id, slug, name, created_by)
    values
      ('org_a', 'goaugment', 'GoAugment', 'user_admin'),
      ('org_b', 'other', 'Other', 'user_other_org_admin')
  `;
  await sql`
    insert into organization_members (org_id, user_id, role)
    values
      ('org_a', 'user_member', 'member'),
      ('org_a', 'user_manager', 'member'),
      ('org_a', 'user_admin', 'admin'),
      ('org_b', 'user_other_org_admin', 'admin')
  `;
  await sql`
    insert into groups (id, org_id, name, source, created_by)
    values
      ('group_a', 'org_a', 'Group A', 'manual', 'user_admin'),
      ('group_b', 'org_b', 'Group B', 'manual', 'user_other_org_admin')
  `;
  await sql`
    insert into group_members (group_id, user_id, role, source)
    values
      ('group_a', 'user_member', 'member', 'manual'),
      ('group_a', 'user_manager', 'manager', 'manual'),
      ('group_b', 'user_other_org_admin', 'manager', 'manual')
  `;
  await sql`
    insert into slack_user_links (id, user_id, slack_team_id, slack_user_id)
    values ('slack_link_member', 'user_member', 'team_a', 'slack_member')
  `;
  await sql`
    insert into automation_definitions (id, scope_kind, scope_id)
    values
      ('automation_org', 'org', 'org_a'),
      ('automation_group', 'group', 'group_a')
  `;
  await sql`
    insert into sessions (id, user_id, scope_kind, scope_id)
    values
      ('session_user', 'user_member', 'user', 'user_member'),
      ('session_group', 'user_member', 'group', 'group_a'),
      ('session_group_b_created_by_member', 'user_member', 'group', 'group_b')
  `;
  await sql`
    insert into chats (id, session_id, scope_kind, scope_id)
    values
      ('chat_inherits_group', 'session_group', null, null),
      ('chat_overrides_to_org', 'session_user', 'org', 'org_a')
  `;
}
