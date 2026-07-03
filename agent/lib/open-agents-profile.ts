import type { DynamicResolveContext } from "eve/tools";
import postgres from "postgres";
import type { WorkspaceRepo } from "../../apps/open-agents/lib/workspace-repos";

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

type AgentLibraryScopeKind = "user" | "org";

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
};
type AgentLibraryItemRow<TItemJson> = {
  itemId: string;
  itemJson: TItemJson;
};

const DEFAULT_ORG_SCOPE_ID = "default";
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

function getAgentLibraryOrgScopeId(): string {
  return process.env.OPEN_AGENTS_ORG_SCOPE_ID?.trim() || DEFAULT_ORG_SCOPE_ID;
}

function getStringAttribute(
  attributes: Readonly<Record<string, string | readonly string[]>> | undefined,
  key: string,
): string | undefined {
  const value = attributes?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getOpenAgentsUserId(ctx: DynamicResolveContext): string | undefined {
  const auth = ctx.session.auth.initiator ?? ctx.session.auth.current;
  return auth?.subject ?? auth?.principalId;
}

function getOpenAgentsSessionId(ctx: DynamicResolveContext): string | undefined {
  const attributes = ctx.session.auth.initiator?.attributes ?? ctx.session.auth.current?.attributes;
  return getStringAttribute(attributes, "openAgentsSessionId");
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

function databaseScopesForRead(userId?: string) {
  return [
    ...(userId ? ([{ kind: "user" as const, id: userId }] as const) : []),
    { kind: "org" as const, id: getAgentLibraryOrgScopeId() },
  ];
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
  userId?: string,
): Promise<AgentLibraryAgentJson | null> {
  for (const scope of databaseScopesForRead(userId)) {
    const row = await getDatabaseItem<AgentLibraryAgentJson>(scope, "agent", agentName);
    if (row) {
      return row.itemJson;
    }
  }

  return null;
}

async function getOpenAgentsSession(sessionId: string, userId?: string) {
  const sql = getOpenAgentsProfileSql();
  const [session] = await sql<OpenAgentsSessionRow[]>`
    select
      user_id as "userId",
      agent_name as "agentName",
      workspace_repos as "workspaceRepos"
    from sessions
    where id = ${sessionId}
    limit 1
  `;

  if (!session || (userId && session.userId !== userId)) {
    return null;
  }

  return session;
}

async function listDatabaseSkills(userId?: string): Promise<OpenAgentsSkillProfile[]> {
  const skills = new Map<string, OpenAgentsSkillProfile>();
  const sql = getOpenAgentsProfileSql();

  for (const scope of [...databaseScopesForRead(userId)].reverse()) {
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
  userId?: string,
): Promise<OpenAgentsSkillProfile[]> {
  if (!patterns || patterns.length === 0) {
    return [];
  }

  return filterSkillsForAgent(await listDatabaseSkills(userId), patterns);
}

export async function resolveOpenAgentsProfile(
  ctx: DynamicResolveContext,
): Promise<OpenAgentsSessionProfile> {
  const userId = getOpenAgentsUserId(ctx);
  const sessionId = getOpenAgentsSessionId(ctx);
  const session = sessionId ? await getOpenAgentsSession(sessionId, userId) : null;
  const agentName = session?.agentName ?? undefined;
  const agent = agentName ? await getDatabaseAgent(agentName, userId) : null;
  const headerToolProfile = getOpenAgentsToolProfile(ctx);
  const skills = await resolveSkillProfiles(agent?.skills, userId);

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
