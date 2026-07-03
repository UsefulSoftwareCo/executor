import postgres from "postgres";

export type ScopeKind = "user" | "group" | "org";
export type Scope = {
  scopeKind: ScopeKind;
  scopeId: string;
};

export type Actor =
  | { kind: "user"; userId: string }
  | { kind: "slack"; teamId: string; slackUserId: string }
  | { kind: "service"; automationId: string };

export type Verb = "read" | "write" | "manage" | "admin";

export type Membership = {
  orgIds: ReadonlySet<string>;
  groupIds: ReadonlySet<string>;
  adminOrgIds: ReadonlySet<string>;
  managerGroupIds: ReadonlySet<string>;
};

export type AuthzOptions = {
  sql?: OpenAgentsAuthzSql;
  anonymousSlackOrgId?: string;
  anonymousSlackGroupIds?: readonly string[];
};

export type OpenAgentsAuthzSql = ReturnType<typeof postgres>;

export class AuthzError extends Error {
  readonly status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.name = "AuthzError";
    this.status = status;
  }
}

type ResolvedMembership = Membership & {
  userId?: string;
  serviceScope?: Scope;
};

type OrganizationMemberRow = { orgId: string; role: "admin" | "member" };
type GroupMemberRow = { groupId: string; role: "manager" | "member" };
type SlackUserLinkRow = { userId: string };
type SlackWorkspaceLinkRow = { orgId: string };
type AutomationDefinitionScopeRow = { scopeKind: string; scopeId: string };
type SessionAccessRow = {
  userId: string;
  scopeKind: ScopeKind;
  scopeId: string;
};
type ChatAccessRow = {
  userId: string;
  sessionScopeKind: ScopeKind;
  sessionScopeId: string;
  chatScopeKind: ScopeKind | null;
  chatScopeId: string | null;
};
type GroupScopeRow = { orgId: string };
type OrganizationRow = { id: string };
type RegclassRow = { exists: boolean };

type CacheEntry = {
  expiresAt: number;
  membership: ResolvedMembership;
};

const DB_POOL_MAX_CONNECTIONS = 1;
const DB_IDLE_TIMEOUT_SECONDS = 10;
const MEMBERSHIP_CACHE_TTL_MS = 60_000;
const DEFAULT_ORG_SLUG = "goaugment";

const membershipCache = new Map<string, CacheEntry>();
let defaultOrgCache: { expiresAt: number; id: string } | undefined;

const globalForOpenAgentsAuthz = globalThis as typeof globalThis & {
  openAgentsAuthzSql?: OpenAgentsAuthzSql;
};

export function getOpenAgentsAuthzSql(): OpenAgentsAuthzSql {
  return (globalForOpenAgentsAuthz.openAgentsAuthzSql ??= postgres(process.env.POSTGRES_URL!, {
    idle_timeout: DB_IDLE_TIMEOUT_SECONDS,
    max: DB_POOL_MAX_CONNECTIONS,
  }));
}

export function invalidateMembership(_userId?: string): void {
  membershipCache.clear();
  defaultOrgCache = undefined;
}

export class OpenAgentsAuthz {
  readonly sql: OpenAgentsAuthzSql;
  readonly anonymousSlackOrgId: string | undefined;
  readonly anonymousSlackGroupIds: readonly string[];
  readonly requestMembershipCache = new Map<string, ResolvedMembership>();

  constructor(options: AuthzOptions = {}) {
    this.sql = options.sql ?? getOpenAgentsAuthzSql();
    this.anonymousSlackOrgId = options.anonymousSlackOrgId;
    this.anonymousSlackGroupIds = options.anonymousSlackGroupIds ?? [];
  }

  async resolveMembership(actor: Actor): Promise<Membership> {
    return this.resolveActorMembership(actor);
  }

  async canAccess(actor: Actor, scope: Scope, verb: Verb): Promise<boolean> {
    return this.canAccessScope(actor, scope, verb);
  }

  async requireSessionAccess(actor: Actor, sessionId: string, verb: Verb): Promise<Scope> {
    const [session] = await this.sql<SessionAccessRow[]>`
      select
        user_id as "userId",
        scope_kind as "scopeKind",
        scope_id as "scopeId"
      from sessions
      where id = ${sessionId}
      limit 1
    `;

    if (!session) {
      throw new AuthzError("Session not found", 404);
    }

    const scope = { scopeKind: session.scopeKind, scopeId: session.scopeId };
    if (verb === "admin" && actor.kind === "user" && actor.userId === session.userId) {
      return scope;
    }

    if (!(await this.canAccessScope(actor, scope, verb))) {
      throw new AuthzError("Session access denied");
    }

    return scope;
  }

  async requireChatAccess(actor: Actor, chatId: string, verb: Verb): Promise<Scope> {
    const [chat] = await this.sql<ChatAccessRow[]>`
      select
        sessions.user_id as "userId",
        sessions.scope_kind as "sessionScopeKind",
        sessions.scope_id as "sessionScopeId",
        chats.scope_kind as "chatScopeKind",
        chats.scope_id as "chatScopeId"
      from chats
      inner join sessions on sessions.id = chats.session_id
      where chats.id = ${chatId}
      limit 1
    `;

    if (!chat) {
      throw new AuthzError("Chat not found", 404);
    }

    const scope = {
      scopeKind: chat.chatScopeKind ?? chat.sessionScopeKind,
      scopeId: chat.chatScopeId ?? chat.sessionScopeId,
    };

    if (verb === "admin" && actor.kind === "user" && actor.userId === chat.userId) {
      return scope;
    }

    if (!(await this.canAccessScope(actor, scope, verb))) {
      throw new AuthzError("Chat access denied");
    }

    return scope;
  }

  async getDefaultOrgId(): Promise<string> {
    const now = Date.now();
    if (defaultOrgCache && defaultOrgCache.expiresAt > now) {
      return defaultOrgCache.id;
    }

    const [organization] = await this.sql<OrganizationRow[]>`
      select id
      from organizations
      where slug = ${DEFAULT_ORG_SLUG}
      limit 1
    `;

    if (!organization) {
      throw new AuthzError("Default organization is not configured", 500);
    }

    defaultOrgCache = {
      id: organization.id,
      expiresAt: now + MEMBERSHIP_CACHE_TTL_MS,
    };
    return organization.id;
  }

  private async canAccessScope(actor: Actor, scope: Scope, verb: Verb): Promise<boolean> {
    if ((actor.kind === "slack" || actor.kind === "service") && (verb === "manage" || verb === "admin")) {
      return false;
    }

    const membership = await this.resolveActorMembership(actor);

    if (membership.serviceScope && matchesScope(membership.serviceScope, scope)) {
      return verb === "read" || verb === "write";
    }

    if (scope.scopeKind === "user") {
      return membership.userId === scope.scopeId;
    }

    if (scope.scopeKind === "org") {
      if (verb === "read" || verb === "write") {
        return membership.orgIds.has(scope.scopeId) || membership.adminOrgIds.has(scope.scopeId);
      }
      return membership.adminOrgIds.has(scope.scopeId);
    }

    if (membership.managerGroupIds.has(scope.scopeId)) {
      return true;
    }

    const groupOrgId = await this.getGroupOrgId(scope.scopeId);
    if (groupOrgId && membership.adminOrgIds.has(groupOrgId)) {
      return true;
    }

    return (verb === "read" || verb === "write") && membership.groupIds.has(scope.scopeId);
  }

  private async resolveActorMembership(actor: Actor): Promise<ResolvedMembership> {
    const cacheKey = actorCacheKey(actor, this.anonymousSlackOrgId, this.anonymousSlackGroupIds);
    const requestCached = this.requestMembershipCache.get(cacheKey);
    if (requestCached) {
      return requestCached;
    }

    const now = Date.now();
    const cached = membershipCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      this.requestMembershipCache.set(cacheKey, cached.membership);
      return cached.membership;
    }

    const membership = await this.loadActorMembership(actor);
    this.requestMembershipCache.set(cacheKey, membership);
    membershipCache.set(cacheKey, {
      membership,
      expiresAt: now + MEMBERSHIP_CACHE_TTL_MS,
    });
    return membership;
  }

  private async loadActorMembership(actor: Actor): Promise<ResolvedMembership> {
    if (actor.kind === "user") {
      return this.loadUserMembership(actor.userId);
    }

    if (actor.kind === "slack") {
      return this.loadSlackMembership(actor);
    }

    return this.loadServiceMembership(actor.automationId);
  }

  private async loadUserMembership(userId: string): Promise<ResolvedMembership> {
    const organizationRows = await this.sql<OrganizationMemberRow[]>`
      select
        org_id as "orgId",
        role
      from organization_members
      where user_id = ${userId}
    `;
    const groupRows = await this.sql<GroupMemberRow[]>`
      select
        group_id as "groupId",
        role
      from group_members
      where user_id = ${userId}
    `;

    return buildMembership({
      userId,
      organizationRows,
      groupRows,
    });
  }

  private async loadSlackMembership(actor: Extract<Actor, { kind: "slack" }>): Promise<ResolvedMembership> {
    const [linkedUser] = await this.sql<SlackUserLinkRow[]>`
      select user_id as "userId"
      from slack_user_links
      where slack_team_id = ${actor.teamId}
        and slack_user_id = ${actor.slackUserId}
      limit 1
    `;

    if (linkedUser) {
      return this.loadUserMembership(linkedUser.userId);
    }

    const orgIds = new Set<string>();
    const groupIds = new Set(this.anonymousSlackGroupIds);

    if (this.anonymousSlackOrgId) {
      orgIds.add(this.anonymousSlackOrgId);
    }

    if (await this.tableExists("slack_workspace_links")) {
      const [workspace] = await this.sql<SlackWorkspaceLinkRow[]>`
        select org_id as "orgId"
        from slack_workspace_links
        where slack_team_id = ${actor.teamId}
        limit 1
      `;
      if (workspace) {
        orgIds.add(workspace.orgId);
      }
    }

    return emptyMembership({ orgIds, groupIds });
  }

  private async loadServiceMembership(automationId: string): Promise<ResolvedMembership> {
    const [automation] = await this.sql<AutomationDefinitionScopeRow[]>`
      select
        scope_kind as "scopeKind",
        scope_id as "scopeId"
      from automation_definitions
      where id = ${automationId}
      limit 1
    `;

    const membership = emptyMembership();
    if (automation && isScopeKind(automation.scopeKind)) {
      return {
        ...membership,
        serviceScope: {
          scopeKind: automation.scopeKind,
          scopeId: automation.scopeId,
        },
      };
    }

    return membership;
  }

  private async getGroupOrgId(groupId: string): Promise<string | undefined> {
    const [group] = await this.sql<GroupScopeRow[]>`
      select org_id as "orgId"
      from groups
      where id = ${groupId}
      limit 1
    `;
    return group?.orgId;
  }

  private async tableExists(tableName: string): Promise<boolean> {
    const [row] = await this.sql<RegclassRow[]>`
      select to_regclass(${tableName}) is not null as "exists"
    `;
    return row?.exists ?? false;
  }
}

export function createOpenAgentsAuthz(options: AuthzOptions = {}): OpenAgentsAuthz {
  return new OpenAgentsAuthz(options);
}

export async function resolveMembership(
  actor: Actor,
  options: AuthzOptions = {},
): Promise<Membership> {
  return createOpenAgentsAuthz(options).resolveMembership(actor);
}

export async function canAccess(
  actor: Actor,
  scope: Scope,
  verb: Verb,
  options: AuthzOptions = {},
): Promise<boolean> {
  return createOpenAgentsAuthz(options).canAccess(actor, scope, verb);
}

export async function requireSessionAccess(
  actor: Actor,
  sessionId: string,
  verb: Verb,
  options: AuthzOptions = {},
): Promise<Scope> {
  return createOpenAgentsAuthz(options).requireSessionAccess(actor, sessionId, verb);
}

export async function requireChatAccess(
  actor: Actor,
  chatId: string,
  verb: Verb,
  options: AuthzOptions = {},
): Promise<Scope> {
  return createOpenAgentsAuthz(options).requireChatAccess(actor, chatId, verb);
}

export async function getDefaultOrgId(options: AuthzOptions = {}): Promise<string> {
  return createOpenAgentsAuthz(options).getDefaultOrgId();
}

function buildMembership({
  userId,
  organizationRows,
  groupRows,
}: {
  userId: string;
  organizationRows: readonly OrganizationMemberRow[];
  groupRows: readonly GroupMemberRow[];
}): ResolvedMembership {
  const orgIds = new Set<string>();
  const adminOrgIds = new Set<string>();
  const groupIds = new Set<string>();
  const managerGroupIds = new Set<string>();

  for (const row of organizationRows) {
    orgIds.add(row.orgId);
    if (row.role === "admin") {
      adminOrgIds.add(row.orgId);
    }
  }

  for (const row of groupRows) {
    groupIds.add(row.groupId);
    if (row.role === "manager") {
      managerGroupIds.add(row.groupId);
    }
  }

  return { userId, orgIds, groupIds, adminOrgIds, managerGroupIds };
}

function emptyMembership({
  orgIds = new Set<string>(),
  groupIds = new Set<string>(),
}: {
  orgIds?: Set<string>;
  groupIds?: Set<string>;
} = {}): ResolvedMembership {
  return {
    orgIds,
    groupIds,
    adminOrgIds: new Set(),
    managerGroupIds: new Set(),
  };
}

function actorCacheKey(
  actor: Actor,
  anonymousSlackOrgId: string | undefined,
  anonymousSlackGroupIds: readonly string[],
): string {
  const anonymousSlackKey = [anonymousSlackOrgId ?? "", ...anonymousSlackGroupIds].join(":");
  if (actor.kind === "user") {
    return `user:${actor.userId}`;
  }
  if (actor.kind === "slack") {
    return `slack:${actor.teamId}:${actor.slackUserId}:${anonymousSlackKey}`;
  }
  return `service:${actor.automationId}`;
}

function matchesScope(left: Scope, right: Scope): boolean {
  return left.scopeKind === right.scopeKind && left.scopeId === right.scopeId;
}

function isScopeKind(value: string): value is ScopeKind {
  return value === "user" || value === "group" || value === "org";
}
