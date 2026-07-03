import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { invalidateMembership } from "@open-agents/authz";
import type { DynamicResolveContext } from "eve/tools";
import postgres from "postgres";
import { resolveOpenAgentsProfile } from "./open-agents-profile";

const databaseUrl = process.env.POSTGRES_URL;
if (!databaseUrl) {
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: DB-backed test requires local Postgres configuration before hooks run
  throw new Error("POSTGRES_URL is required for Open Agents profile tests");
}

const testId = `profile_${Date.now().toString(36)}`;
const ids = {
  creator: `${testId}_creator`,
  viewer: `${testId}_viewer`,
  outsider: `${testId}_outsider`,
  group: `${testId}_group`,
  session: `${testId}_session`,
  chat: `${testId}_chat`,
  agentItemCreator: `${testId}_agent_creator`,
  agentItemViewer: `${testId}_agent_viewer`,
};

const sql = postgres(databaseUrl, { max: 1 });
let goaugmentOrgId = "";

beforeAll(async () => {
  const [org] = await sql<{ id: string }[]>`
    select id from organizations where slug = 'goaugment' limit 1
  `;
  if (!org) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: DB-backed test cannot build the fixture without the migrated default org
    throw new Error("goaugment organization is required for Open Agents profile tests");
  }
  goaugmentOrgId = org.id;
  await seedProfileFixture();
});

afterAll(async () => {
  await sql`delete from groups where id = ${ids.group} or id like 'profile_%_group'`;
  await sql`delete from users where id in (${ids.creator}, ${ids.viewer}, ${ids.outsider}) or id like 'profile_%'`;
  await sql.end();
});

beforeEach(() => {
  invalidateMembership();
});

describe("resolveOpenAgentsProfile", () => {
  test("resolves creator-owned user-scoped sessions", async () => {
    await sql`
      update sessions
      set scope_kind = 'user', scope_id = ${ids.creator}
      where id = ${ids.session}
    `;

    const profile = await resolveOpenAgentsProfile(contextFor(ids.creator));

    expect(profile.agentDisplayName).toBe("Creator Shared Agent");
    expect(profile.customInstructions).toBe("creator instructions");
  });

  test("keeps user-scoped sessions private", async () => {
    await sql`
      update sessions
      set scope_kind = 'user', scope_id = ${ids.creator}
      where id = ${ids.session}
    `;

    const profile = await resolveOpenAgentsProfile(contextFor(ids.viewer));

    expect(profile.workspaceRepos).toEqual([]);
    expect(profile.agentDisplayName).toBeUndefined();
  });

  test("resolves org-scoped sessions for anonymous Slack principals", async () => {
    await sql`
      update sessions
      set scope_kind = 'org', scope_id = ${goaugmentOrgId}
      where id = ${ids.session}
    `;

    const profile = await resolveOpenAgentsProfile(contextForActor("slack:T123:UUNLINKED"));

    expect(profile.agentName).toBe("shared-agent");
    expect(profile.agentDisplayName).toBe("Creator Shared Agent");
    expect(profile.workspaceRepos).toEqual([
      {
        owner: "GoAugment",
        repo: "augment-web",
        branch: "staging",
        directory: "augment-web",
      },
    ]);
  });

  test("resolves the creator's agent profile for a non-creator group member", async () => {
    await sql`
      update sessions
      set scope_kind = 'group', scope_id = ${ids.group}
      where id = ${ids.session}
    `;

    const profile = await resolveOpenAgentsProfile(contextFor(ids.viewer));

    expect(profile.agentName).toBe("shared-agent");
    expect(profile.agentDisplayName).toBe("Creator Shared Agent");
    expect(profile.customInstructions).toBe("creator instructions");
    expect(profile.tools).toEqual(["bash"]);
    expect(profile.workspaceRepos).toEqual([
      {
        owner: "GoAugment",
        repo: "augment-web",
        branch: "staging",
        directory: "augment-web",
      },
    ]);
  });
});

function contextFor(userId: string): DynamicResolveContext {
  return contextForActor(userId);
}

function contextForActor(actorId: string): DynamicResolveContext {
  return {
    session: {
      auth: {
        initiator: {
          subject: actorId,
          principalId: actorId,
          attributes: {
            openAgentsActor: actorId,
            openAgentsSessionId: ids.session,
            openAgentsChatId: ids.chat,
          },
        },
      },
    },
  } as DynamicResolveContext;
}

async function seedProfileFixture(): Promise<void> {
  await sql`
    insert into users (id, username, email, email_verified, name, is_admin)
    values
      (${ids.creator}, ${ids.creator}, ${`${ids.creator}@example.com`}, true, 'Creator', false),
      (${ids.viewer}, ${ids.viewer}, ${`${ids.viewer}@example.com`}, true, 'Viewer', false),
      (${ids.outsider}, ${ids.outsider}, ${`${ids.outsider}@example.com`}, true, 'Outsider', false)
    on conflict (id) do nothing
  `;
  await sql`
    insert into organization_members (org_id, user_id, role, added_by)
    values
      (${goaugmentOrgId}, ${ids.creator}, 'member', ${ids.creator}),
      (${goaugmentOrgId}, ${ids.viewer}, 'member', ${ids.creator}),
      (${goaugmentOrgId}, ${ids.outsider}, 'member', ${ids.creator})
    on conflict (org_id, user_id) do nothing
  `;
  await sql`
    insert into groups (id, org_id, name, source, created_by)
    values (${ids.group}, ${goaugmentOrgId}, 'Profile Test Group', 'manual', ${ids.creator})
    on conflict (id) do nothing
  `;
  await sql`
    insert into group_members (group_id, user_id, role, source, added_by)
    values
      (${ids.group}, ${ids.creator}, 'manager', 'manual', ${ids.creator}),
      (${ids.group}, ${ids.viewer}, 'member', 'manual', ${ids.creator})
    on conflict (group_id, user_id) do nothing
  `;
  await sql`
    insert into sessions (
      id,
      user_id,
      scope_kind,
      scope_id,
      title,
      status,
      workspace_repos,
      agent_name,
      sandbox_state
    ) values (
      ${ids.session},
      ${ids.creator},
      'group',
      ${ids.group},
      'Profile Test Session',
      'running',
      ${sql.json([
        {
          owner: "GoAugment",
          repo: "augment-web",
          branch: "staging",
          directory: "augment-web",
        },
      ])},
      'shared-agent',
      ${sql.json({ type: "vercel" })}
    )
    on conflict (id) do update set
      scope_kind = excluded.scope_kind,
      scope_id = excluded.scope_id,
      agent_name = excluded.agent_name
  `;
  await sql`
    insert into chats (id, session_id, title, model_id)
    values (${ids.chat}, ${ids.session}, 'Profile Test Chat', 'anthropic/claude-haiku-4.5')
    on conflict (id) do nothing
  `;
  await sql`
    insert into agent_library_items (id, user_id, scope_kind, scope_id, kind, item_id, item_json)
    values
      (
        ${ids.agentItemCreator},
        ${ids.creator},
        'user',
        ${ids.creator},
        'agent',
        'shared-agent',
        ${sql.json({
          slug: "shared-agent",
          name: "Creator Shared Agent",
          description: "creator version",
          tools: ["bash"],
          skills: [],
          systemPrompt: "creator instructions",
        })}
      ),
      (
        ${ids.agentItemViewer},
        ${ids.viewer},
        'user',
        ${ids.viewer},
        'agent',
        'shared-agent',
        ${sql.json({
          slug: "shared-agent",
          name: "Viewer Personal Agent",
          description: "viewer version",
          tools: ["grep"],
          skills: [],
          systemPrompt: "viewer instructions",
        })}
      )
    on conflict (scope_kind, scope_id, kind, item_id) do update set
      item_json = excluded.item_json,
      user_id = excluded.user_id
  `;
}
