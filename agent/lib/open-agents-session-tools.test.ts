import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { invalidateMembership } from "@open-agents/authz";
import postgres from "postgres";

const databaseUrl = process.env.POSTGRES_URL;
if (!databaseUrl) {
  throw new Error("POSTGRES_URL is required for Open Agents session tool tests");
}

const execMock = mock(async () => ({
  exitCode: 0,
  stderr: "",
  stdout: "shared sandbox\n",
  truncated: false,
}));
const connectSandboxMock = mock(async (sandboxState: unknown) => ({
  workingDirectory: "/vercel/sandbox",
  exec: execMock,
  sandboxState,
}));
const installConfiguredSessionClisMock = mock(async () => undefined);

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: connectSandboxMock,
}));
mock.module("@open-agents/sandbox/session-clis.js", () => ({
  installConfiguredSessionClis: installConfiguredSessionClisMock,
}));

const testId = `session_tools_${Date.now().toString(36)}`;
const ids = {
  creator: `${testId}_creator`,
  viewer: `${testId}_viewer`,
  outsider: `${testId}_outsider`,
  slackOwner: `slack:T123:${testId}_slack`,
  group: `${testId}_group`,
  session: `${testId}_session`,
  slackSession: `${testId}_slack_session`,
};

const sql = postgres(databaseUrl, { max: 1 });
let goaugmentOrgId = "";

beforeAll(async () => {
  const [org] = await sql<{ id: string }[]>`
    select id from organizations where slug = 'goaugment' limit 1
  `;
  if (!org) {
    throw new Error("goaugment organization is required for Open Agents session tool tests");
  }
  goaugmentOrgId = org.id;
  await seedFixture();
});

afterAll(async () => {
  await sql`delete from groups where id = ${ids.group}`;
  await sql`delete from users where id in (${ids.creator}, ${ids.viewer}, ${ids.outsider}, ${ids.slackOwner})`;
  await sql.end();
});

beforeEach(() => {
  invalidateMembership();
  execMock.mockClear();
  connectSandboxMock.mockClear();
  installConfiguredSessionClisMock.mockClear();
});

describe("Open Agents session workspace tools", () => {
  test("allow a non-creator group member to execute workspace tools", async () => {
    const { OPEN_AGENTS_SESSION_TOOLS } = await import("./open-agents-session-tools");

    const result = await OPEN_AGENTS_SESSION_TOOLS.bash.execute!(
      { command: "pwd" },
      contextFor(ids.viewer),
    );

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "shared sandbox\n",
      truncated: false,
    });
    expect(connectSandboxMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith("pwd", "/vercel/sandbox", 120000);
  });

  test("allows an anonymous Slack principal to execute org-scoped workspace tools", async () => {
    const { OPEN_AGENTS_SESSION_TOOLS } = await import("./open-agents-session-tools");

    const result = await OPEN_AGENTS_SESSION_TOOLS.bash.execute!(
      { command: "pwd" },
      contextForActor("slack:T123:UUNLINKED", ids.slackSession),
    );

    expect(result).toMatchObject({ stdout: "shared sandbox\n" });
    expect(connectSandboxMock).toHaveBeenCalledTimes(1);
  });

  test("rejects a user without access before connecting the sandbox", async () => {
    const { OPEN_AGENTS_SESSION_TOOLS } = await import("./open-agents-session-tools");

    await expect(
      OPEN_AGENTS_SESSION_TOOLS.bash.execute!({ command: "pwd" }, contextFor(ids.outsider)),
    ).rejects.toThrow("Session access denied");
    expect(connectSandboxMock).not.toHaveBeenCalled();
  });
});

function contextFor(userId: string) {
  return contextForActor(userId, ids.session);
}

function contextForActor(actorId: string, sessionId: string) {
  return {
    session: {
      auth: {
        initiator: {
          subject: actorId,
          principalId: actorId,
          attributes: {
            openAgentsActor: actorId,
            openAgentsSessionId: sessionId,
          },
        },
      },
    },
  } as never;
}

async function seedFixture(): Promise<void> {
  await sql`
    insert into users (id, username, email, email_verified, name, is_admin)
    values
      (${ids.creator}, ${ids.creator}, ${`${ids.creator}@example.com`}, true, 'Creator', false),
      (${ids.viewer}, ${ids.viewer}, ${`${ids.viewer}@example.com`}, true, 'Viewer', false),
      (${ids.outsider}, ${ids.outsider}, ${`${ids.outsider}@example.com`}, true, 'Outsider', false),
      (${ids.slackOwner}, ${ids.slackOwner.replace(/[^A-Za-z0-9_-]+/g, "_")}, null, false, 'Slack Participant', false)
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
    values (${ids.group}, ${goaugmentOrgId}, 'Session Tools Test Group', 'manual', ${ids.creator})
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
    insert into sessions (id, user_id, scope_kind, scope_id, title, status, sandbox_state)
    values (
      ${ids.session},
      ${ids.creator},
      'group',
      ${ids.group},
      'Session Tools Test',
      'running',
      ${sql.json({ type: "vercel", sandboxName: `${testId}_sandbox`, expiresAt: Date.now() + 3_600_000 })}
    )
    on conflict (id) do update set
      scope_kind = excluded.scope_kind,
      scope_id = excluded.scope_id,
      sandbox_state = excluded.sandbox_state
  `;
  await sql`
    insert into sessions (id, user_id, scope_kind, scope_id, title, status, sandbox_state)
    values (
      ${ids.slackSession},
      ${ids.slackOwner},
      'org',
      ${goaugmentOrgId},
      'Slack Session Tools Test',
      'running',
      ${sql.json({ type: "vercel", sandboxName: `${testId}_slack_sandbox`, expiresAt: Date.now() + 3_600_000 })}
    )
    on conflict (id) do update set
      scope_kind = excluded.scope_kind,
      scope_id = excluded.scope_id,
      sandbox_state = excluded.sandbox_state
  `;
}
