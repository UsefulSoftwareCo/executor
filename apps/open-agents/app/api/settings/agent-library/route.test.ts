import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentDefinition, AgentLibrarySummary, SkillDocument } from "@/lib/agents/definitions";

mock.module("server-only", () => ({}));

let currentSession: { user: { id: string } } | null = { user: { id: "admin-user" } };
const defaultOrgId = "org_8e4d1c1bf18f697072";
const accessDecisions = new Map<string, boolean>();
const accessCalls: Array<{
  actor: { kind: "user"; userId: string };
  scope: { scopeKind: string; scopeId: string };
  verb: string;
}> = [];
const savedAgents: Array<{
  input: unknown;
  userId?: string;
  scope: string;
  scopeId?: string;
}> = [];
const deletedAgents: Array<{ slug: string; userId?: string; scope: string; scopeId?: string }> = [];

const emptyLibrary: AgentLibrarySummary = {
  agents: [],
  skills: [],
  defaultAgentName: null,
};

const savedAgent: AgentDefinition = {
  slug: "triage",
  name: "Triage",
  description: "Triage agent",
  tools: [],
  repos: [],
  skills: [],
  systemPrompt: "Help.",
  path: "db:org:agent:triage",
  scope: "org",
};

const savedSkill: SkillDocument = {
  id: "triage-skill",
  name: "Triage Skill",
  description: "Triage skill",
  body: "Use this skill.",
  path: "db:org:skill:triage-skill",
  scope: "org",
};

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => currentSession,
}));

mock.module("@/lib/db/user-preferences", () => ({
  getUserPreferences: async () => ({ defaultAgentName: null }),
  updateUserPreferences: async (
    _userId: string,
    updates: { defaultAgentName?: string | null },
  ) => ({
    defaultAgentName: updates.defaultAgentName ?? null,
  }),
}));

mock.module("@open-agents/authz", () => ({
  canAccess: async (
    actor: { kind: "user"; userId: string },
    scope: { scopeKind: string; scopeId: string },
    verb: string,
  ) => {
    accessCalls.push({ actor, scope, verb });
    return (
      accessDecisions.get(`${actor.userId}:${scope.scopeKind}:${scope.scopeId}:${verb}`) ?? false
    );
  },
  getDefaultOrgId: async () => defaultOrgId,
}));

mock.module("@/lib/agents/repository", () => ({
  deleteAgentDefinition: async (
    slug: string,
    userId: string | undefined,
    scope: string,
    scopeId?: string,
  ) => {
    deletedAgents.push({ slug, userId, scope, scopeId });
  },
  deleteSkillDocument: async () => {},
  getAgentDefinition: async () => savedAgent,
  listAgentLibrary: async () => emptyLibrary,
  saveAgentDefinition: async (
    input: unknown,
    userId: string | undefined,
    scope: string,
    scopeId?: string,
  ) => {
    savedAgents.push({ input, userId, scope, scopeId });
    return { ...savedAgent, scope: scope as AgentDefinition["scope"] };
  },
  saveSkillDocument: async () => savedSkill,
}));

const routeModulePromise = import("./route");

function allowManage(userId: string, scopeKind: string, scopeId: string) {
  accessDecisions.set(`${userId}:${scopeKind}:${scopeId}:manage`, true);
}

function postAgent(scope: "user" | "group" | "org", scopeId?: string) {
  return new Request("http://localhost/api/settings/agent-library", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "agent",
      scope,
      scopeId,
      item: {
        slug: "triage",
        name: "Triage",
        description: "Triage agent",
        tools: [],
        repos: [],
        skills: [],
        systemPrompt: "Help.",
      },
    }),
  });
}

describe("/api/settings/agent-library scope authorization", () => {
  beforeEach(() => {
    currentSession = { user: { id: "admin-user" } };
    accessDecisions.clear();
    accessCalls.length = 0;
    savedAgents.length = 0;
    deletedAgents.length = 0;
  });

  test("org-scoped save succeeds for an org admin", async () => {
    allowManage("admin-user", "org", defaultOrgId);
    const { POST } = await routeModulePromise;

    const response = await POST(postAgent("org"));

    expect(response.status).toBe(200);
    expect(accessCalls).toEqual([
      {
        actor: { kind: "user", userId: "admin-user" },
        scope: { scopeKind: "org", scopeId: defaultOrgId },
        verb: "manage",
      },
    ]);
    expect(savedAgents).toHaveLength(1);
    expect(savedAgents[0]).toMatchObject({
      userId: "admin-user",
      scope: "org",
      scopeId: defaultOrgId,
    });
  });

  test("org-scoped save returns 403 for a non-admin member", async () => {
    currentSession = { user: { id: "member-user" } };
    const { POST } = await routeModulePromise;

    const response = await POST(postAgent("org"));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toContain("permission");
    expect(savedAgents).toHaveLength(0);
    expect(accessCalls[0]).toMatchObject({
      actor: { kind: "user", userId: "member-user" },
      scope: { scopeKind: "org", scopeId: defaultOrgId },
      verb: "manage",
    });
  });

  test("group-scoped save requires manage on that group", async () => {
    allowManage("admin-user", "group", "group-1");
    const { POST } = await routeModulePromise;

    const response = await POST(postAgent("group", "group-1"));

    expect(response.status).toBe(200);
    expect(savedAgents[0]).toMatchObject({ scope: "group", scopeId: "group-1" });
    expect(accessCalls[0]).toMatchObject({
      scope: { scopeKind: "group", scopeId: "group-1" },
      verb: "manage",
    });
  });

  test("non-admin org delete returns 403 before deleting", async () => {
    currentSession = { user: { id: "member-user" } };
    const { DELETE } = await routeModulePromise;

    const response = await DELETE(
      new Request("http://localhost/api/settings/agent-library?kind=agent&id=triage&scope=org", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(403);
    expect(deletedAgents).toHaveLength(0);
  });
});
