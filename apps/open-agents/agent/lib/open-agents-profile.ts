import { createOpenAgentsAuthz, parseActor, type Actor, type Scope } from "@open-agents/authz";
import type { DynamicResolveContext } from "eve/tools";
import postgres from "postgres";
import type { WorkspaceRepo } from "../../lib/workspace-repos";

export const OPEN_AGENTS_PROFILE_TOOLS = [
  "todo",
  "read_file",
  "write_file",
  "grep",
  "glob",
  "bash",
  "web_fetch",
  "load_skill",
] as const;

export type OpenAgentsProfileTool = (typeof OPEN_AGENTS_PROFILE_TOOLS)[number];

export type OpenAgentsSkillProfile = {
  id: string;
  name: string;
  description: string;
  markdown: string;
};

export type OpenAgentsSessionProfile = {
  agentName?: string;
  agentDisplayName?: string;
  customInstructions?: string;
  tools: OpenAgentsProfileTool[];
  skills: OpenAgentsSkillProfile[];
  workspaceRepos: WorkspaceRepo[];
};

type AgentLibraryScopeKind = "user" | "group" | "org";

type AgentLibraryAgentJson = {
  slug: string;
  name: string;
  description: string;
  tools: OpenAgentsProfileTool[];
  skills: string[];
  systemPrompt: string;
};

type AgentLibrarySkillJson = {
  id: string;
  name: string;
  description: string;
  body: string;
};

type OpenAgentsProfileSql = ReturnType<typeof postgres>;
type OpenAgentsSessionRow = {
  userId: string;
  agentName: string | null;
  workspaceRepos: WorkspaceRepo[];
  scopeKind: Scope["scopeKind"];
  scopeId: string;
  chatScopeKind: Scope["scopeKind"] | null;
  chatScopeId: string | null;
};
type AgentLibraryItemRow<TItemJson> = {
  itemId: string;
  itemJson: TItemJson;
};

const OPEN_AGENTS_PROFILE_TOOL_SET = new Set<string>(OPEN_AGENTS_PROFILE_TOOLS);
const DB_POOL_MAX_CONNECTIONS = 1;
const DB_IDLE_TIMEOUT_SECONDS = 10;

const globalForOpenAgentsProfile = globalThis as typeof globalThis & {
  openAgentsProfileSql?: OpenAgentsProfileSql;
};

function getOpenAgentsProfileSql(): OpenAgentsProfileSql {
  return (globalForOpenAgentsProfile.openAgentsProfileSql ??= postgres(process.env.POSTGRES_URL!, {
    idle_timeout: DB_IDLE_TIMEOUT_SECONDS,
    max: DB_POOL_MAX_CONNECTIONS,
  }));
}

function getStringAttribute(
  attributes: Readonly<Record<string, string | readonly string[]>> | undefined,
  key: string,
): string | undefined {
  const value = attributes?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getOpenAgentsSessionId(ctx: DynamicResolveContext): string | undefined {
  const attributes = ctx.session.auth.initiator?.attributes ?? ctx.session.auth.current?.attributes;
  return getStringAttribute(attributes, "openAgentsSessionId");
}

function getOpenAgentsChatId(ctx: DynamicResolveContext): string | undefined {
  const attributes = ctx.session.auth.initiator?.attributes ?? ctx.session.auth.current?.attributes;
  return getStringAttribute(attributes, "openAgentsChatId");
}

function getOpenAgentsActor(ctx: DynamicResolveContext): Actor | undefined {
  const auth = ctx.session.auth.initiator ?? ctx.session.auth.current;
  const actorId =
    getStringAttribute(auth?.attributes, "openAgentsActor") ?? auth?.subject ?? auth?.principalId;
  return actorId ? parseActor(actorId) : undefined;
}

function getOpenAgentsToolProfile(ctx: DynamicResolveContext): OpenAgentsProfileTool[] | undefined {
  const attributes = ctx.session.auth.initiator?.attributes ?? ctx.session.auth.current?.attributes;
  const value = getStringAttribute(attributes, "openAgentsToolProfile");
  if (!value) {
    return undefined;
  }

  const tools = value
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool): tool is OpenAgentsProfileTool => OPEN_AGENTS_PROFILE_TOOL_SET.has(tool));

  return tools.length > 0 ? tools : [];
}

function defaultTools(): OpenAgentsProfileTool[] {
  return [...OPEN_AGENTS_PROFILE_TOOLS];
}

function normalizeProfileTools(
  tools: readonly OpenAgentsProfileTool[] | undefined,
): OpenAgentsProfileTool[] {
  if (!tools || tools.length === 0) {
    return defaultTools();
  }

  return [...tools];
}

function getEffectiveSessionScope(session: OpenAgentsSessionRow): Scope {
  return {
    scopeKind: session.chatScopeKind ?? session.scopeKind,
    scopeId: session.chatScopeId ?? session.scopeId,
  };
}

async function getGroupOrgScope(groupId: string): Promise<{ kind: "org"; id: string } | undefined> {
  const sql = getOpenAgentsProfileSql();
  const [group] = await sql<{ orgId: string }[]>`
    select org_id as "orgId"
    from groups
    where id = ${groupId}
    limit 1
  `;
  return group ? { kind: "org", id: group.orgId } : undefined;
}

async function databaseScopesForSession(session: OpenAgentsSessionRow) {
  const effectiveScope = getEffectiveSessionScope(session);
  const scopes: { kind: AgentLibraryScopeKind; id: string }[] = [
    { kind: "user", id: session.userId },
  ];

  if (effectiveScope.scopeKind === "user") {
    const defaultOrgId = await createOpenAgentsAuthz({
      sql: getOpenAgentsProfileSql(),
    }).getDefaultOrgId();
    scopes.push({ kind: "org", id: defaultOrgId });
    return scopes;
  }

  scopes.push({ kind: effectiveScope.scopeKind, id: effectiveScope.scopeId });
  if (effectiveScope.scopeKind === "group") {
    const orgScope = await getGroupOrgScope(effectiveScope.scopeId);
    if (orgScope) {
      scopes.push(orgScope);
    }
  }

  return scopes;
}

async function getDatabaseItem<TItemJson>(
  scope: { kind: AgentLibraryScopeKind; id: string },
  kind: "agent" | "skill",
  itemId: string,
): Promise<AgentLibraryItemRow<TItemJson> | undefined> {
  const sql = getOpenAgentsProfileSql();
  const [row] = await sql<AgentLibraryItemRow<TItemJson>[]>`
    select
      item_id as "itemId",
      item_json as "itemJson"
    from agent_library_items
    where
      scope_kind = ${scope.kind}
      and scope_id = ${scope.id}
      and kind = ${kind}
      and item_id = ${itemId}
    limit 1
  `;

  return row;
}

async function getDatabaseAgent(
  agentName: string,
  scopes: readonly { kind: AgentLibraryScopeKind; id: string }[],
): Promise<AgentLibraryAgentJson | null> {
  for (const scope of scopes) {
    const row = await getDatabaseItem<AgentLibraryAgentJson>(scope, "agent", agentName);
    if (row) {
      return row.itemJson;
    }
  }

  return null;
}

async function getOpenAgentsSession(sessionId: string, chatId?: string) {
  const sql = getOpenAgentsProfileSql();
  const [session] = await sql<OpenAgentsSessionRow[]>`
    select
      sessions.user_id as "userId",
      sessions.agent_name as "agentName",
      sessions.workspace_repos as "workspaceRepos",
      sessions.scope_kind as "scopeKind",
      sessions.scope_id as "scopeId",
      chats.scope_kind as "chatScopeKind",
      chats.scope_id as "chatScopeId"
    from sessions
    left join chats on chats.session_id = sessions.id and chats.id = ${chatId ?? null}
    where sessions.id = ${sessionId}
    limit 1
  `;

  return session ?? null;
}

async function listDatabaseSkills(
  scopes: readonly { kind: AgentLibraryScopeKind; id: string }[],
): Promise<OpenAgentsSkillProfile[]> {
  const skills = new Map<string, OpenAgentsSkillProfile>();
  const sql = getOpenAgentsProfileSql();

  for (const scope of [...scopes].reverse()) {
    const rows = await sql<AgentLibraryItemRow<AgentLibrarySkillJson>[]>`
      select
        item_id as "itemId",
        item_json as "itemJson"
      from agent_library_items
      where
        scope_kind = ${scope.kind}
        and scope_id = ${scope.id}
        and kind = 'skill'
    `;

    for (const row of rows) {
      const item = row.itemJson;
      skills.set(item.id, {
        id: item.id,
        name: item.name,
        description: item.description,
        markdown: item.body,
      });
    }
  }

  return [...skills.values()];
}

function lastPathSegment(value: string): string {
  const segments = value.split("/").filter(Boolean);
  return segments.at(-1) ?? value;
}

function matchesAgentPattern(pattern: string, candidates: readonly string[]): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedPattern) {
    return false;
  }

  return candidates.some((candidate) => {
    const normalizedCandidate = candidate.trim().toLowerCase();
    if (normalizedPattern.endsWith("/*")) {
      const prefix = normalizedPattern.slice(0, -2);
      return normalizedCandidate === prefix || normalizedCandidate.startsWith(`${prefix}/`);
    }
    if (normalizedPattern.endsWith(".*")) {
      const prefix = normalizedPattern.slice(0, -2);
      return normalizedCandidate === prefix || normalizedCandidate.startsWith(`${prefix}.`);
    }
    if (normalizedPattern.endsWith("*")) {
      return normalizedCandidate.startsWith(normalizedPattern.slice(0, -1));
    }
    return normalizedCandidate === normalizedPattern;
  });
}

function filterSkillsForAgent(
  skills: OpenAgentsSkillProfile[],
  patterns: readonly string[] | undefined,
): OpenAgentsSkillProfile[] {
  if (!patterns || patterns.length === 0) {
    return [];
  }

  return skills.filter((skill) =>
    patterns.some((pattern) =>
      matchesAgentPattern(pattern, [skill.id, skill.name, lastPathSegment(skill.id)]),
    ),
  );
}

async function resolveSkillProfiles(
  patterns: readonly string[] | undefined,
  scopes: readonly { kind: AgentLibraryScopeKind; id: string }[],
): Promise<OpenAgentsSkillProfile[]> {
  if (!patterns || patterns.length === 0) {
    return [];
  }

  return filterSkillsForAgent(await listDatabaseSkills(scopes), patterns);
}

export async function resolveOpenAgentsProfile(
  ctx: DynamicResolveContext,
): Promise<OpenAgentsSessionProfile> {
  const actor = getOpenAgentsActor(ctx);
  const sessionId = getOpenAgentsSessionId(ctx);
  const chatId = getOpenAgentsChatId(ctx);
  const session = sessionId ? await getOpenAgentsSession(sessionId, chatId) : null;

  if (session) {
    if (!actor) {
      return {
        tools: defaultTools(),
        skills: [],
        workspaceRepos: [],
      };
    }

    const authz = createOpenAgentsAuthz({ sql: getOpenAgentsProfileSql() });
    const anonymousSlackOrgId = await authz.getDefaultOrgId();
    const scopedAuthz = createOpenAgentsAuthz({
      anonymousSlackOrgId,
      sql: getOpenAgentsProfileSql(),
    });
    const canWriteSession = await scopedAuthz.canAccess(
      actor,
      getEffectiveSessionScope(session),
      "write",
    );
    if (!canWriteSession) {
      return {
        tools: defaultTools(),
        skills: [],
        workspaceRepos: [],
      };
    }
  }

  const scopes = session ? await databaseScopesForSession(session) : [];
  const agentName = session?.agentName ?? undefined;
  const agent = agentName ? await getDatabaseAgent(agentName, scopes) : null;
  const headerToolProfile = getOpenAgentsToolProfile(ctx);
  const skills = await resolveSkillProfiles(agent?.skills, scopes);

  return {
    ...(agentName ? { agentName } : {}),
    ...(agent?.name ? { agentDisplayName: agent.name } : {}),
    ...(agent?.systemPrompt ? { customInstructions: agent.systemPrompt } : {}),
    tools: headerToolProfile ?? normalizeProfileTools(agent?.tools),
    skills,
    workspaceRepos: session?.workspaceRepos ?? [],
  };
}

export function dynamicSkillName(skill: OpenAgentsSkillProfile): string {
  return skill.id
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}
