import type { SandboxState } from "@open-agents/sandbox";
import type { HandleMessageStreamEvent, SessionState } from "eve/client";
import type { ModelVariant } from "@/lib/model-variants";
import type { GlobalSkillRef } from "@/lib/skills/global-skill-refs";
import type { WorkspaceRepo } from "@/lib/workspace-repos";
import { users } from "./auth-schema";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export * from "../executor/schema";
export { accounts, authSessions, users, verification } from "./auth-schema";

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("organizations_slug_idx").on(table.slug)],
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    addedBy: text("added_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId] }),
    index("organization_members_user_idx").on(table.userId),
  ],
);

export const groups = pgTable(
  "groups",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    source: text("source", { enum: ["manual", "slack_channel"] }).notNull(),
    slackTeamId: text("slack_team_id"),
    slackChannelId: text("slack_channel_id"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("groups_org_idx").on(table.orgId),
    uniqueIndex("groups_slack_channel_idx")
      .on(table.orgId, table.slackTeamId, table.slackChannelId)
      .where(sql`${table.source} = 'slack_channel'`),
  ],
);

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["member", "manager"] }).notNull(),
    source: text("source", { enum: ["manual", "slack_sync"] }).notNull(),
    addedBy: text("added_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    index("group_members_user_idx").on(table.userId),
  ],
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type", {
      enum: ["User", "Organization"],
    }).notNull(),
    repositorySelection: text("repository_selection", {
      enum: ["all", "selected"],
    }).notNull(),
    installationUrl: text("installation_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("github_installations_user_installation_idx").on(
      table.userId,
      table.installationId,
    ),
    uniqueIndex("github_installations_user_account_idx").on(table.userId, table.accountLogin),
  ],
);

export const slackUserLinks = pgTable(
  "slack_user_links",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slackTeamId: text("slack_team_id").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    slackUserName: text("slack_user_name"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("slack_user_links_user_idx").on(table.userId),
    uniqueIndex("slack_user_links_identity_idx").on(table.slackTeamId, table.slackUserId),
  ],
);

export const slackThreadSessions = pgTable(
  "slack_thread_sessions",
  {
    slackTeamId: text("slack_team_id").notNull(),
    slackChannelId: text("slack_channel_id").notNull(),
    slackThreadTs: text("slack_thread_ts").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    linkPostedAt: timestamp("link_posted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.slackTeamId, table.slackChannelId, table.slackThreadTs],
    }),
    index("slack_thread_sessions_user_idx").on(table.userId),
    uniqueIndex("slack_thread_sessions_chat_idx").on(table.chatId),
  ],
);

export const vercelProjectLinks = pgTable(
  "vercel_project_links",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    projectId: text("project_id").notNull(),
    projectName: text("project_name").notNull(),
    teamId: text("team_id"),
    teamSlug: text("team_slug"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.repoOwner, table.repoName],
    }),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopeKind: text("scope_kind", { enum: ["user", "group", "org"] }).notNull(),
    scopeId: text("scope_id").notNull(),
    title: text("title").notNull(),
    status: text("status", {
      enum: ["running", "completed", "failed", "archived"],
    })
      .notNull()
      .default("running"),
    // Repository info
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    branch: text("branch"),
    cloneUrl: text("clone_url"),
    vercelProjectId: text("vercel_project_id"),
    vercelProjectName: text("vercel_project_name"),
    vercelTeamId: text("vercel_team_id"),
    vercelTeamSlug: text("vercel_team_slug"),
    workspaceRepos: jsonb("workspace_repos").$type<WorkspaceRepo[]>().notNull().default([]),
    // Whether this session uses a new auto-generated branch
    isNewBranch: boolean("is_new_branch").default(false).notNull(),
    // Optional per-session override for auto commit + push behavior.
    // null means "use the user's default preference".
    autoCommitPushOverride: boolean("auto_commit_push_override"),
    // Optional per-session override for auto PR creation after auto-commit.
    // null means "use the user's default preference".
    autoCreatePrOverride: boolean("auto_create_pr_override"),
    globalSkillRefs: jsonb("global_skill_refs").$type<GlobalSkillRef[]>().notNull().default([]),
    agentName: text("agent_name"),
    // Unified sandbox state
    sandboxState: jsonb("sandbox_state").$type<SandboxState>(),
    // Lifecycle orchestration state for sandbox management
    lifecycleState: text("lifecycle_state", {
      enum: [
        "provisioning",
        "active",
        "hibernating",
        "hibernated",
        "restoring",
        "archived",
        "failed",
      ],
    }),
    lifecycleVersion: integer("lifecycle_version").notNull().default(0),
    lastActivityAt: timestamp("last_activity_at"),
    sandboxExpiresAt: timestamp("sandbox_expires_at"),
    hibernateAfter: timestamp("hibernate_after"),
    lifecycleRunId: text("lifecycle_run_id"),
    lifecycleError: text("lifecycle_error"),
    // Git stats (for display in session list)
    linesAdded: integer("lines_added").default(0),
    linesRemoved: integer("lines_removed").default(0),
    // PR info if created
    prNumber: integer("pr_number"),
    prStatus: text("pr_status", {
      enum: ["open", "merged", "closed"],
    }),
    // Cached diff for offline viewing
    cachedDiff: jsonb("cached_diff"),
    cachedDiffUpdatedAt: timestamp("cached_diff_updated_at"),
    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_scope_idx").on(table.scopeKind, table.scopeId),
  ],
);

export const chats = pgTable(
  "chats",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    scopeKind: text("scope_kind", { enum: ["user", "group", "org"] }),
    scopeId: text("scope_id"),
    modelId: text("model_id").default("anthropic/claude-haiku-4.5"),
    lastAssistantMessageAt: timestamp("last_assistant_message_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("chats_session_id_idx").on(table.sessionId),
    index("chats_scope_idx").on(table.scopeKind, table.scopeId),
  ],
);

export const eveChatSessionStates = pgTable("eve_chat_session_states", {
  chatId: text("chat_id")
    .primaryKey()
    .references(() => chats.id, { onDelete: "cascade" }),
  state: jsonb("state").$type<SessionState>().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const eveChatEvents = pgTable(
  "eve_chat_events",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    streamIndex: integer("stream_index").notNull(),
    eventType: text("event_type").notNull(),
    event: jsonb("event").$type<HandleMessageStreamEvent>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.streamIndex] })],
);

export const shares = pgTable(
  "shares",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("shares_chat_id_idx").on(table.chatId)],
);

export const chatReads = pgTable(
  "chat_reads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.chatId] }),
    index("chat_reads_chat_id_idx").on(table.chatId),
  ],
);

export const docs = pgTable(
  "docs",
  {
    id: text("id").primaryKey(),
    scopeKind: text("scope_kind", { enum: ["user", "group", "org"] }).notNull(),
    scopeId: text("scope_id").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("design_doc"),
    markdownCache: text("markdown_cache"),
    markdownCacheSeq: integer("markdown_cache_seq").notNull().default(0),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("docs_scope_idx").on(table.scopeKind, table.scopeId),
    index("docs_created_by_idx").on(table.createdBy),
  ],
);

export type AutomationDefinitionJson = {
  id?: string;
  version?: number;
  name: string;
  description?: string;
  enabled?: boolean;
  scope: {
    kind:
      | "system"
      | "user"
      | "group"
      | "org"
      | "thread"
      | "session"
      | "repo"
      | "automation"
      | "external-thread";
    id: string;
  };
  owner: {
    kind: "user" | "app-bot" | "service-account";
    id: string;
  };
  identity: {
    kind: "user" | "app-bot" | "service-account";
    userId?: string;
    botId?: string;
    accountId?: string;
  };
  triggers: Array<Record<string, unknown>>;
  conditions: Array<Record<string, unknown>>;
  concurrency: Record<string, unknown>;
  correlation: Record<string, unknown>;
  agent?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  policy: Record<string, unknown>;
  state?: Record<string, unknown>;
  action: Record<string, unknown>;
  outputs: Array<Record<string, unknown>>;
};

export const automationDefinitions = pgTable(
  "automation_definitions",
  {
    id: text("id").primaryKey(),
    currentVersionId: text("current_version_id"),
    scopeKind: text("scope_kind", {
      enum: ["system", "user", "group", "org", "thread", "session", "repo", "automation", "external-thread"],
    }).notNull(),
    scopeId: text("scope_id").notNull(),
    ownerKind: text("owner_kind", {
      enum: ["user", "app-bot", "service-account"],
    }).notNull(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("automation_definitions_scope_idx").on(table.scopeKind, table.scopeId),
    index("automation_definitions_owner_idx").on(table.ownerKind, table.ownerId),
    index("automation_definitions_enabled_idx").on(table.enabled),
  ],
);

export const automationVersions = pgTable(
  "automation_versions",
  {
    id: text("id").primaryKey(),
    automationId: text("automation_id")
      .notNull()
      .references(() => automationDefinitions.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definitionJson: jsonb("definition_json").$type<AutomationDefinitionJson>().notNull(),
    definitionHash: text("definition_hash").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    changeSummary: text("change_summary"),
  },
  (table) => [
    uniqueIndex("automation_versions_automation_version_idx").on(table.automationId, table.version),
    index("automation_versions_automation_idx").on(table.automationId),
  ],
);

export const automationEvents = pgTable(
  "automation_events",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    type: text("type").notNull(),
    version: integer("version").notNull().default(1),
    scopeKind: text("scope_kind", {
      enum: ["system", "user", "group", "org", "thread", "session", "repo", "automation"],
    }).notNull(),
    scopeId: text("scope_id").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    subjectUrl: text("subject_url"),
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    actorJson: jsonb("actor_json").$type<Record<string, unknown>>(),
    trust: text("trust", { enum: ["internal", "partner", "public"] })
      .notNull()
      .default("internal"),
    connectorId: text("connector_id"),
    installationId: text("installation_id"),
    occurredAt: timestamp("occurred_at").notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    correlationKey: text("correlation_key"),
    payloadJson: jsonb("payload_json").notNull(),
    rawPayloadRef: text("raw_payload_ref"),
    linksJson: jsonb("links_json").$type<Array<{ label: string; url: string }>>(),
  },
  (table) => [
    uniqueIndex("automation_events_dedupe_idx").on(
      table.source,
      table.scopeKind,
      table.scopeId,
      table.dedupeKey,
    ),
    index("automation_events_route_idx").on(table.source, table.type, table.receivedAt),
    index("automation_events_subject_idx").on(table.subjectKind, table.subjectId),
    index("automation_events_correlation_idx").on(table.correlationKey),
  ],
);

export const automationInvocations = pgTable(
  "automation_invocations",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => automationEvents.id, { onDelete: "cascade" }),
    automationId: text("automation_id")
      .notNull()
      .references(() => automationDefinitions.id, { onDelete: "cascade" }),
    automationVersionId: text("automation_version_id")
      .notNull()
      .references(() => automationVersions.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["matched", "skipped", "duplicate", "blocked"],
    }).notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("automation_invocations_event_version_idx").on(
      table.eventId,
      table.automationId,
      table.automationVersionId,
    ),
    index("automation_invocations_automation_idx").on(table.automationId),
  ],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: text("id").primaryKey(),
    invocationId: text("invocation_id")
      .notNull()
      .references(() => automationInvocations.id, { onDelete: "cascade" }),
    automationId: text("automation_id")
      .notNull()
      .references(() => automationDefinitions.id, { onDelete: "cascade" }),
    automationVersionId: text("automation_version_id")
      .notNull()
      .references(() => automationVersions.id, { onDelete: "cascade" }),
    eveSessionId: text("eve_session_id"),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    chatId: text("chat_id").references(() => chats.id, { onDelete: "set null" }),
    correlationKey: text("correlation_key"),
    status: text("status", {
      enum: [
        "pending",
        "running",
        "succeeded",
        "succeeded_with_findings",
        "skipped",
        "needs_review",
        "blocked",
        "failed",
        "cancelled",
        "timed_out",
        "expired",
      ],
    })
      .notNull()
      .default("pending"),
    policySnapshotJson: jsonb("policy_snapshot_json").notNull(),
    agentSnapshotJson: jsonb("agent_snapshot_json"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("automation_runs_automation_idx").on(table.automationId),
    index("automation_runs_invocation_idx").on(table.invocationId),
    index("automation_runs_status_idx").on(table.status),
    index("automation_runs_correlation_idx").on(table.correlationKey),
  ],
);

export const automationRunAttempts = pgTable(
  "automation_run_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at"),
    errorJson: jsonb("error_json"),
  },
  (table) => [
    uniqueIndex("automation_run_attempts_run_number_idx").on(table.runId, table.attemptNumber),
  ],
);

export const automationState = pgTable(
  "automation_state",
  {
    automationId: text("automation_id")
      .notNull()
      .references(() => automationDefinitions.id, { onDelete: "cascade" }),
    scope: text("scope", {
      enum: ["automation", "trigger", "correlation", "run"],
    }).notNull(),
    key: text("key").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    stateJson: jsonb("state_json").notNull(),
    lastSuccessfulRunId: text("last_successful_run_id"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.automationId, table.scope, table.key],
    }),
    index("automation_state_scope_idx").on(table.scope, table.key),
  ],
);

export const automationCorrelations = pgTable(
  "automation_correlations",
  {
    automationId: text("automation_id")
      .notNull()
      .references(() => automationDefinitions.id, { onDelete: "cascade" }),
    correlationKey: text("correlation_key").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    chatId: text("chat_id").references(() => chats.id, { onDelete: "set null" }),
    externalThreadId: text("external_thread_id"),
    stateJson: jsonb("state_json").notNull().default({}),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.automationId, table.correlationKey] }),
    index("automation_correlations_subject_idx").on(table.subjectKind, table.subjectId),
    index("automation_correlations_session_idx").on(table.sessionId, table.chatId),
  ],
);

export const automationArtifacts = pgTable(
  "automation_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    schemaJson: jsonb("schema_json"),
    dataRef: text("data_ref"),
    dataJson: jsonb("data_json"),
    checksum: text("checksum"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("automation_artifacts_run_idx").on(table.runId)],
);

export const automationApprovals = pgTable(
  "automation_approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status", {
      enum: ["requested", "approved", "denied", "cancelled", "expired"],
    })
      .notNull()
      .default("requested"),
    requestJson: jsonb("request_json").notNull(),
    decisionJson: jsonb("decision_json"),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    decidedAt: timestamp("decided_at"),
    decidedBy: text("decided_by"),
    workflowHookToken: text("workflow_hook_token"),
  },
  (table) => [
    index("automation_approvals_run_idx").on(table.runId),
    index("automation_approvals_status_idx").on(table.status),
  ],
);

export const automationTimelineEvents = pgTable(
  "automation_timeline_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    timestamp: timestamp("timestamp").defaultNow().notNull(),
    type: text("type").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    visibility: text("visibility", { enum: ["trace", "router", "user"] })
      .notNull()
      .default("trace"),
  },
  (table) => [
    index("automation_timeline_events_run_idx").on(table.runId),
    index("automation_timeline_events_type_idx").on(table.type),
  ],
);

export const automationOutbox = pgTable(
  "automation_outbox",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").references(() => automationRuns.id, {
      onDelete: "cascade",
    }),
    destination: text("destination").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    status: text("status", {
      enum: ["pending", "sent", "failed", "cancelled"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("automation_outbox_status_idx").on(table.status),
    index("automation_outbox_run_idx").on(table.runId),
  ],
);

export const automationMessageQueue = pgTable(
  "automation_message_queue",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").references(() => automationRuns.id, {
      onDelete: "set null",
    }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageJson: jsonb("message_json").notNull(),
    status: text("status", {
      enum: ["queued", "claimed", "started", "cancelled", "failed"],
    })
      .notNull()
      .default("queued"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    claimedAt: timestamp("claimed_at"),
    startedEveSessionId: text("started_eve_session_id"),
    lastError: text("last_error"),
  },
  (table) => [
    index("automation_message_queue_chat_status_idx").on(table.chatId, table.status),
    index("automation_message_queue_run_idx").on(table.runId),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type NewOrganizationMember = typeof organizationMembers.$inferInsert;
export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type GroupMember = typeof groupMembers.$inferSelect;
export type NewGroupMember = typeof groupMembers.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type VercelProjectLink = typeof vercelProjectLinks.$inferSelect;
export type NewVercelProjectLink = typeof vercelProjectLinks.$inferInsert;
export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type EveChatSessionState = typeof eveChatSessionStates.$inferSelect;
export type NewEveChatSessionState = typeof eveChatSessionStates.$inferInsert;
export type EveChatEvent = typeof eveChatEvents.$inferSelect;
export type NewEveChatEvent = typeof eveChatEvents.$inferInsert;
export type Share = typeof shares.$inferSelect;
export type NewShare = typeof shares.$inferInsert;
export type ChatRead = typeof chatReads.$inferSelect;
export type NewChatRead = typeof chatReads.$inferInsert;
export type Doc = typeof docs.$inferSelect;
export type NewDoc = typeof docs.$inferInsert;
export type GitHubInstallation = typeof githubInstallations.$inferSelect;
export type NewGitHubInstallation = typeof githubInstallations.$inferInsert;
export type SlackUserLink = typeof slackUserLinks.$inferSelect;
export type NewSlackUserLink = typeof slackUserLinks.$inferInsert;
export type AutomationDefinition = typeof automationDefinitions.$inferSelect;
export type NewAutomationDefinition = typeof automationDefinitions.$inferInsert;
export type AutomationVersion = typeof automationVersions.$inferSelect;
export type NewAutomationVersion = typeof automationVersions.$inferInsert;
export type AutomationEvent = typeof automationEvents.$inferSelect;
export type NewAutomationEvent = typeof automationEvents.$inferInsert;
export type AutomationInvocation = typeof automationInvocations.$inferSelect;
export type NewAutomationInvocation = typeof automationInvocations.$inferInsert;
export type AutomationRun = typeof automationRuns.$inferSelect;
export type NewAutomationRun = typeof automationRuns.$inferInsert;
export type AutomationState = typeof automationState.$inferSelect;
export type NewAutomationState = typeof automationState.$inferInsert;
export type AutomationCorrelation = typeof automationCorrelations.$inferSelect;
export type NewAutomationCorrelation = typeof automationCorrelations.$inferInsert;
export type AutomationMessageQueueItem = typeof automationMessageQueue.$inferSelect;
export type NewAutomationMessageQueueItem = typeof automationMessageQueue.$inferInsert;

export const agentLibraryItems = pgTable(
  "agent_library_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopeKind: text("scope_kind", { enum: ["user", "org"] })
      .notNull()
      .default("user"),
    scopeId: text("scope_id").notNull(),
    kind: text("kind", { enum: ["agent", "skill"] }).notNull(),
    itemId: text("item_id").notNull(),
    itemJson: jsonb("item_json").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("agent_library_items_user_kind_idx").on(table.userId, table.kind),
    index("agent_library_items_scope_kind_scope_id_kind_idx").on(
      table.scopeKind,
      table.scopeId,
      table.kind,
    ),
    uniqueIndex("agent_library_items_scope_kind_scope_id_kind_item_idx").on(
      table.scopeKind,
      table.scopeId,
      table.kind,
      table.itemId,
    ),
  ],
);

export type AgentLibraryItem = typeof agentLibraryItems.$inferSelect;
export type NewAgentLibraryItem = typeof agentLibraryItems.$inferInsert;

// User preferences for settings
export const userPreferences = pgTable("user_preferences", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  defaultModelId: text("default_model_id").default("anthropic/claude-haiku-4.5"),
  defaultSubagentModelId: text("default_subagent_model_id"),
  defaultSandboxType: text("default_sandbox_type", {
    enum: ["vercel"],
  }).default("vercel"),
  defaultDiffMode: text("default_diff_mode", {
    enum: ["unified", "split"],
  }).default("unified"),
  autoCommitPush: boolean("auto_commit_push").notNull().default(false),
  autoCreatePr: boolean("auto_create_pr").notNull().default(false),
  alertsEnabled: boolean("alerts_enabled").notNull().default(true),
  alertSoundEnabled: boolean("alert_sound_enabled").notNull().default(true),
  publicUsageEnabled: boolean("public_usage_enabled").notNull().default(false),
  globalSkillRefs: jsonb("global_skill_refs").$type<GlobalSkillRef[]>().notNull().default([]),
  defaultAgentName: text("default_agent_name"),
  modelVariants: jsonb("model_variants").$type<ModelVariant[]>().notNull().default([]),
  enabledModelIds: jsonb("enabled_model_ids").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserPreferences = typeof userPreferences.$inferSelect;
export type NewUserPreferences = typeof userPreferences.$inferInsert;

// Usage tracking — one row per assistant turn (append-only)
export const usageEvents = pgTable("usage_events", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  source: text("source", { enum: ["web"] })
    .notNull()
    .default("web"),
  agentType: text("agent_type", { enum: ["main", "subagent"] })
    .notNull()
    .default("main"),
  provider: text("provider"),
  modelId: text("model_id"),
  inputTokens: integer("input_tokens").notNull().default(0),
  cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  toolCallCount: integer("tool_call_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
