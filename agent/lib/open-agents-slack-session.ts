import { connectSandbox, type SandboxState } from "@open-agents/sandbox";
import { installConfiguredSessionClis } from "@open-agents/sandbox/session-clis.js";
import { getVercelOidcToken } from "@vercel/oidc";
import {
  Client,
  isCurrentTurnBoundaryEvent,
  type HandleMessageStreamEvent,
  type SessionState,
} from "eve/client";
import type { SlackMessage } from "eve/channels/slack";
import { nanoid } from "nanoid";
import postgres from "postgres";
import {
  getDefaultHookWorkspaceRepos,
  type WorkspaceRepo,
} from "../../apps/open-agents/lib/workspace-repos";

export type OpenAgentsSlackSession = {
  chatId: string;
  created: boolean;
  linkPostedAt: Date | null;
  sandboxSources: Array<{ repo: string; branch?: string; directory?: string }>;
  sessionId: string;
  sessionUrl: string;
  userId: string;
};

export type OpenAgentsSlackTurnResult =
  | {
      status: "busy";
    }
  | {
      eveSessionId: string;
      message?: string;
      status: "completed" | "failed" | "waiting";
    };

type SlackUserLinkRow = {
  userId: string;
};

type SlackThreadSessionRow = {
  chatId: string;
  linkPostedAt: Date | null;
  sessionId: string;
  userId: string;
};

type EveChatSessionStateRow = {
  state: SessionState;
};

type LatestEveChatEventRow = {
  event: HandleMessageStreamEvent;
};

type RepoTarget = {
  owner: string;
  repo: string;
};

const APP_DEFAULT_MODEL_ID = "anthropic/claude-sonnet-4.6";
const DEFAULT_SLACK_TEAM_ID = "default";
const DB_POOL_MAX_CONNECTIONS = 1;
const DB_IDLE_TIMEOUT_SECONDS = 10;
const DEFAULT_SANDBOX_TIMEOUT_MS = 5 * 60 * 60 * 1000 - 30 * 1000;
const DEFAULT_SANDBOX_VCPUS = 4;
const DEFAULT_SANDBOX_PORTS = [3000, 5173, 4321, 8000];
const SANDBOX_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

const globalForSlackSessions = globalThis as typeof globalThis & {
  openAgentsSlackSessionSql?: ReturnType<typeof postgres>;
};

function getSql() {
  return (globalForSlackSessions.openAgentsSlackSessionSql ??= postgres(process.env.POSTGRES_URL!, {
    idle_timeout: DB_IDLE_TIMEOUT_SECONDS,
    max: DB_POOL_MAX_CONNECTIONS,
  }));
}

function normalizeSlackTeamId(slackTeamId: string | null | undefined): string {
  const trimmed = slackTeamId?.trim();
  return trimmed ? trimmed : DEFAULT_SLACK_TEAM_ID;
}

function normalizeSlackUserId(slackUserId: string): string {
  return slackUserId.trim().toUpperCase();
}

function parseRepoTarget(text: string): RepoTarget | null {
  const githubUrlMatch = text.match(
    /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#\s]|$)/i,
  );
  if (githubUrlMatch?.[1] && githubUrlMatch[2]) {
    return { owner: githubUrlMatch[1], repo: githubUrlMatch[2] };
  }

  const explicitRepoMatch = text.match(
    /\brepo(?:sitory)?\s*[:=]?\s*([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/i,
  );
  if (explicitRepoMatch?.[1] && explicitRepoMatch[2]) {
    return { owner: explicitRepoMatch[1], repo: explicitRepoMatch[2] };
  }

  return null;
}

function cleanTitle(text: string): string {
  const title = text
    .replace(/<@[A-Z0-9]+>/g, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!title) {
    return "Slack triage workspace";
  }

  return title.length > 96 ? `${title.slice(0, 95)}...` : title;
}

function getPublicBaseUrl(): string {
  const explicit = process.env.OPEN_AGENTS_PUBLIC_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }

  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (productionHost) {
    return `https://${productionHost}`.replace(/\/$/, "");
  }

  const deploymentHost = process.env.VERCEL_URL?.trim();
  if (deploymentHost) {
    return `https://${deploymentHost}`.replace(/\/$/, "");
  }

  return "http://localhost:3000";
}

async function getLinkedOpenAgentsUserId(input: {
  slackTeamId?: string | null;
  slackUserId: string;
}): Promise<string | null> {
  const sql = getSql();
  const slackUserId = normalizeSlackUserId(input.slackUserId);
  const slackTeamId = normalizeSlackTeamId(input.slackTeamId);
  const [exactLink] = await sql<SlackUserLinkRow[]>`
    select user_id as "userId"
    from slack_user_links
    where slack_team_id = ${slackTeamId}
      and slack_user_id = ${slackUserId}
    limit 1
  `;
  if (exactLink) {
    return exactLink.userId;
  }

  if (slackTeamId === DEFAULT_SLACK_TEAM_ID) {
    return null;
  }

  const [defaultTeamLink] = await sql<SlackUserLinkRow[]>`
    select user_id as "userId"
    from slack_user_links
    where slack_team_id = ${DEFAULT_SLACK_TEAM_ID}
      and slack_user_id = ${slackUserId}
    limit 1
  `;

  return defaultTeamLink?.userId ?? null;
}

function getSessionSources(input: {
  repoTarget: RepoTarget | null;
  workspaceRepos: WorkspaceRepo[];
}) {
  if (input.repoTarget) {
    return {
      repoOwner: input.repoTarget.owner,
      repoName: input.repoTarget.repo,
      branch: "main",
      cloneUrl: `https://github.com/${input.repoTarget.owner}/${input.repoTarget.repo}`,
      workspaceRepos: [],
      sandboxSources: [
        {
          repo: `https://github.com/${input.repoTarget.owner}/${input.repoTarget.repo}`,
          branch: "main",
        },
      ],
    };
  }

  return {
    repoOwner: null,
    repoName: null,
    branch: null,
    cloneUrl: null,
    workspaceRepos: input.workspaceRepos,
    sandboxSources: input.workspaceRepos.map((repo) => ({
      repo: repo.cloneUrl,
      branch: repo.branch,
      directory: repo.directory,
    })),
  };
}

function sessionUrl(sessionId: string, chatId: string): string {
  return `${getPublicBaseUrl()}/sessions/${sessionId}/chats/${chatId}`;
}

async function getSlackThreadSession(input: {
  slackChannelId: string;
  slackTeamId: string;
  slackThreadTs: string;
}): Promise<OpenAgentsSlackSession | null> {
  const sql = getSql();
  const [row] = await sql<SlackThreadSessionRow[]>`
    select
      chat_id as "chatId",
      link_posted_at as "linkPostedAt",
      session_id as "sessionId",
      user_id as "userId"
    from slack_thread_sessions
    where slack_team_id = ${input.slackTeamId}
      and slack_channel_id = ${input.slackChannelId}
      and slack_thread_ts = ${input.slackThreadTs}
    limit 1
  `;

  return row
    ? {
        ...row,
        created: false,
        sandboxSources: [],
        sessionUrl: sessionUrl(row.sessionId, row.chatId),
      }
    : null;
}

async function createSlackThreadSession(input: {
  slackChannelId: string;
  slackTeamId: string;
  slackThreadTs: string;
  text: string;
  userId: string;
}): Promise<OpenAgentsSlackSession> {
  const sql = getSql();
  const sessionId = nanoid();
  const chatId = nanoid();
  const repoTarget = parseRepoTarget(input.text);
  const workspaceRepos = repoTarget ? [] : getDefaultHookWorkspaceRepos();
  const sessionSources = getSessionSources({ repoTarget, workspaceRepos });

  await sql.begin(async (tx) => {
    await tx`
      insert into sessions (
        id,
        user_id,
        title,
        status,
        repo_owner,
        repo_name,
        branch,
        clone_url,
        workspace_repos,
        sandbox_state,
        lifecycle_state,
        lifecycle_version
      )
      values (
        ${sessionId},
        ${input.userId},
        ${cleanTitle(input.text)},
        'running',
        ${sessionSources.repoOwner},
        ${sessionSources.repoName},
        ${sessionSources.branch},
        ${sessionSources.cloneUrl},
        ${tx.json(sessionSources.workspaceRepos)},
        ${tx.json({ type: "vercel" })},
        'provisioning',
        0
      )
    `;

    await tx`
      insert into chats (
        id,
        session_id,
        title,
        model_id
      )
      values (
        ${chatId},
        ${sessionId},
        'Slack',
        ${APP_DEFAULT_MODEL_ID}
      )
    `;

    await tx`
      insert into slack_thread_sessions (
        slack_team_id,
        slack_channel_id,
        slack_thread_ts,
        user_id,
        session_id,
        chat_id
      )
      values (
        ${input.slackTeamId},
        ${input.slackChannelId},
        ${input.slackThreadTs},
        ${input.userId},
        ${sessionId},
        ${chatId}
      )
    `;
  });

  return {
    chatId,
    created: true,
    linkPostedAt: null,
    sandboxSources: sessionSources.sandboxSources,
    sessionId,
    sessionUrl: sessionUrl(sessionId, chatId),
    userId: input.userId,
  };
}

export async function getOrCreateOpenAgentsSlackSession(input: {
  slackChannelId: string;
  slackTeamId?: string | null;
  slackThreadTs: string;
  slackUserId: string;
  text: string;
}): Promise<OpenAgentsSlackSession | null> {
  const slackTeamId = normalizeSlackTeamId(input.slackTeamId);
  const existing = await getSlackThreadSession({
    slackChannelId: input.slackChannelId,
    slackTeamId,
    slackThreadTs: input.slackThreadTs,
  });
  if (existing) {
    return existing;
  }

  const userId = await getLinkedOpenAgentsUserId({
    slackTeamId,
    slackUserId: input.slackUserId,
  });
  if (!userId) {
    return null;
  }

  return createSlackThreadSession({
    slackChannelId: input.slackChannelId,
    slackTeamId,
    slackThreadTs: input.slackThreadTs,
    text: input.text,
    userId,
  });
}

export async function initializeOpenAgentsSlackSessionSandbox(session: OpenAgentsSlackSession) {
  console.info("[slack-session] initializing sandbox", {
    sessionId: session.sessionId,
    sourceCount: session.sandboxSources.length,
  });

  try {
    await initializeSandbox({
      sessionId: session.sessionId,
      sandboxSources: session.sandboxSources,
    });
  } catch (error) {
    await markSandboxInitializationFailed({
      sessionId: session.sessionId,
      error,
    });
    throw error;
  }

  console.info("[slack-session] sandbox initialized", {
    sessionId: session.sessionId,
  });
}

export async function markOpenAgentsSlackSessionLinkPosted(session: OpenAgentsSlackSession) {
  const sql = getSql();
  await sql`
    update slack_thread_sessions
    set
      link_posted_at = now(),
      updated_at = now()
    where chat_id = ${session.chatId}
  `;
}

export async function runOpenAgentsSlackTurn(input: {
  message: SlackMessage;
  session: OpenAgentsSlackSession;
}): Promise<OpenAgentsSlackTurnResult> {
  console.info("[slack-session] starting Eve turn", {
    chatId: input.session.chatId,
    sessionId: input.session.sessionId,
    textLength: slackMessageText(input.message).length,
  });

  const latestEvent = await getLatestEveChatEvent(input.session.chatId);
  if (latestEvent && !isCurrentTurnBoundaryEvent(latestEvent)) {
    console.info("[slack-session] Eve turn is busy", {
      chatId: input.session.chatId,
      latestEventType: latestEvent.type,
      sessionId: input.session.sessionId,
    });
    return { status: "busy" };
  }

  const initialSession = await getEveChatSessionState(input.session.chatId);
  const clientSession = createEveClient().session(initialSession);
  const response = await clientSession.send({
    clientContext: {
      source: "slack",
      slack: {
        channelId: input.message.channelId,
        teamId: input.message.teamId ?? null,
        threadTs: input.message.threadTs,
        userId: input.message.author?.userId ?? null,
      },
    },
    headers: {
      "x-open-agents-chat-id": input.session.chatId,
      "x-open-agents-session-id": input.session.sessionId,
      "x-open-agents-user-id": input.session.userId,
    },
    message: slackMessageText(input.message),
  });
  const firstStreamIndex =
    initialSession.sessionId === response.sessionId ? initialSession.streamIndex : 0;
  const events: HandleMessageStreamEvent[] = [];
  const pendingSession: SessionState = {
    ...initialSession,
    ...(response.continuationToken ? { continuationToken: response.continuationToken } : {}),
    sessionId: response.sessionId,
    streamIndex: firstStreamIndex,
  };

  await persistEveChatSessionProgress({
    chatId: input.session.chatId,
    events: [],
    firstStreamIndex,
    session: pendingSession,
  });
  console.info("[slack-session] persisted Eve session cursor", {
    chatId: input.session.chatId,
    eveSessionId: response.sessionId,
    sessionId: input.session.sessionId,
    streamIndex: firstStreamIndex,
  });

  for await (const event of response) {
    const streamIndex = firstStreamIndex + events.length;
    events.push(event);
    await persistEveChatSessionProgress({
      chatId: input.session.chatId,
      events: [event],
      firstStreamIndex: streamIndex,
    });
    console.info("[slack-session] persisted Eve event", {
      chatId: input.session.chatId,
      eventType: event.type,
      sessionId: input.session.sessionId,
      streamIndex,
    });
  }

  await persistEveChatSessionProgress({
    chatId: input.session.chatId,
    events: [],
    firstStreamIndex,
    session: clientSession.state,
  });

  const status = deriveEveTurnStatus(events);
  console.info("[slack-session] completed Eve turn", {
    chatId: input.session.chatId,
    eventCount: events.length,
    eveSessionId: response.sessionId,
    sessionId: input.session.sessionId,
    status,
  });

  return {
    eveSessionId: response.sessionId,
    message: extractCompletedMessage(events),
    status,
  };
}

async function initializeSandbox(input: {
  sessionId: string;
  sandboxSources: Array<{ repo: string; branch?: string; directory?: string }>;
}) {
  const sql = getSql();
  const sandboxState: SandboxState = {
    type: "vercel",
    sandboxName: `session_${input.sessionId}`,
    sources: input.sandboxSources,
  };

  const sandbox = await connectSandbox(sandboxState, {
    baseSnapshotId: process.env.VERCEL_SANDBOX_BASE_SNAPSHOT_ID,
    createIfMissing: true,
    githubToken: process.env.OPEN_AGENTS_GITHUB_TOKEN,
    gitUser: {
      name: "Open Agents",
      email: "open-agents@users.noreply.github.com",
    },
    persistent: true,
    ports: DEFAULT_SANDBOX_PORTS,
    resume: true,
    hooks: {
      afterStart: installConfiguredSessionClis,
    },
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    vcpus: DEFAULT_SANDBOX_VCPUS,
  });

  const nextState = sandbox.getState ? (sandbox.getState() as SandboxState) : sandboxState;
  const now = new Date();
  const expiresAt =
    "expiresAt" in nextState && typeof nextState.expiresAt === "number"
      ? new Date(nextState.expiresAt)
      : null;

  await sql`
    update sessions
    set
      sandbox_state = ${sql.json(nextState)},
      lifecycle_state = 'active',
      lifecycle_error = null,
      last_activity_at = ${now},
      hibernate_after = ${new Date(now.getTime() + SANDBOX_INACTIVITY_TIMEOUT_MS)},
      sandbox_expires_at = ${expiresAt},
      lifecycle_version = lifecycle_version + 1,
      updated_at = now()
    where id = ${input.sessionId}
  `;
}

async function markSandboxInitializationFailed(input: { sessionId: string; error: unknown }) {
  const sql = getSql();
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await sql`
    update sessions
    set
      lifecycle_state = 'failed',
      lifecycle_error = ${message},
      updated_at = now()
    where id = ${input.sessionId}
  `;
}

function createEveClient() {
  return new Client({
    auth: process.env.VERCEL ? { vercelOidc: { token: () => getVercelOidcToken() } } : undefined,
    host: getPublicBaseUrl(),
    preserveCompletedSessions: true,
    redirect: "manual",
  });
}

async function getEveChatSessionState(chatId: string): Promise<SessionState> {
  const sql = getSql();
  const [row] = await sql<EveChatSessionStateRow[]>`
    select state
    from eve_chat_session_states
    where chat_id = ${chatId}
    limit 1
  `;

  return row?.state ?? { streamIndex: 0 };
}

async function getLatestEveChatEvent(
  chatId: string,
): Promise<HandleMessageStreamEvent | undefined> {
  const sql = getSql();
  const [row] = await sql<LatestEveChatEventRow[]>`
    select event
    from eve_chat_events
    where chat_id = ${chatId}
    order by stream_index desc
    limit 1
  `;

  return row?.event;
}

async function persistEveChatSessionProgress(input: {
  chatId: string;
  events: readonly HandleMessageStreamEvent[];
  firstStreamIndex: number;
  session?: SessionState;
}) {
  const sql = getSql();
  const now = new Date();

  await sql.begin(async (tx) => {
    if (input.events.length > 0) {
      await tx`
        insert into eve_chat_events ${tx(
          input.events.map((event, offset) => ({
            chat_id: input.chatId,
            stream_index: input.firstStreamIndex + offset,
            event_type: event.type,
            event: tx.json(event),
            created_at: now,
          })),
        )}
        on conflict do nothing
      `;

      await tx`
        update chats
        set
          updated_at = ${now},
          last_assistant_message_at = case
            when ${input.events.some((event) => event.type === "message.completed")} then ${now}
            else last_assistant_message_at
          end
        where id = ${input.chatId}
      `;
    }

    if (input.session) {
      await tx`
        insert into eve_chat_session_states (
          chat_id,
          state,
          updated_at
        )
        values (
          ${input.chatId},
          ${tx.json(input.session)},
          ${now}
        )
        on conflict (chat_id)
        do update set
          state = excluded.state,
          updated_at = excluded.updated_at
      `;
    }
  });
}

function slackMessageText(message: SlackMessage): string {
  const text = message.markdown.trim() || message.text.trim();
  const attachments = message.attachments.map((attachment) =>
    [
      `Slack attachment: ${attachment.name ?? attachment.id}`,
      attachment.mimeType ? `MIME type: ${attachment.mimeType}` : undefined,
      attachment.url ? `URL: ${attachment.url}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return [text, ...attachments].filter((part) => part.length > 0).join("\n\n");
}

function deriveEveTurnStatus(
  events: readonly HandleMessageStreamEvent[],
): OpenAgentsSlackTurnResult["status"] {
  const boundary = findCurrentTurnBoundaryEvent(events);
  if (boundary?.type === "session.waiting") {
    return "waiting";
  }

  if (boundary?.type === "session.failed") {
    return "failed";
  }

  return "completed";
}

function extractCompletedMessage(events: readonly HandleMessageStreamEvent[]): string | undefined {
  let message: string | undefined;

  for (const event of events) {
    if (
      event.type === "message.completed" &&
      event.data.finishReason !== "tool-calls" &&
      event.data.message
    ) {
      message = event.data.message;
    }
  }

  return message;
}

function findCurrentTurnBoundaryEvent(events: readonly HandleMessageStreamEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && isCurrentTurnBoundaryEvent(event)) {
      return event;
    }
  }
}
