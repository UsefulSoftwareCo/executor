import { Cause, Deferred, Effect, Exit, Option, Schema } from "effect";
import type * as Tracer from "effect/Tracer";
import type { Connection, ConnectionContext } from "agents";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { RequestOrgSlug, RequestWebOrigin } from "@executor-js/api/server";
import {
  formatPausedExecution,
  type ExecutionEngine,
  type ExecutionResult,
  type PausedExecutionDeadline,
  type ResumeResponse,
} from "@executor-js/execution";
import {
  PAUSED_APPROVAL_TIMEOUT_MS,
  formatMcpExecutionOutcome,
  type PausedExecutionHooks,
  type ResumeFallbackOutcome,
} from "@executor-js/host-mcp/tool-server";
import { defaultMcpResource, type McpResource } from "@executor-js/host-mcp";

import type { IncomingPropagationHeaders, McpElicitationMode } from "./do-headers";
import { classifyDurableObjectError, type DurableObjectFailure } from "./durable-object-errors";
import type {
  McpExecutionOwnerDirectory,
  McpExecutionOwnerRecord,
  McpExecutionOwnerRoute,
} from "./execution-owner-directory";
import {
  MAX_PAUSED_SESSION_IDLE_MS,
  SESSION_TIMEOUT_MS,
  decideSessionAlarm,
  pausedLeaseExtensionLog,
  runningLeaseExtensionLog,
} from "./session-alarm-policy";
import {
  acquireResidentRuntime,
  currentResidentRuntimeCount,
  pickEvictionCandidate,
  registerResidentSession,
  releaseResidentRuntime,
  releaseResidentSession,
  residencyAttributes,
  RESIDENT_RUNTIME_SOFT_CAP,
  touchResidentSession,
} from "./session-runtime-residency";

export type IncomingTraceHeaders = IncomingPropagationHeaders;

export interface McpSessionInit {
  readonly organizationId: string;
  /** The organization's display name, as the worker resolved it while
   *  authorizing this very request. Carried so the session DO never has to
   *  re-read a row the request already loaded. Absent when the auth plane could
   *  not name the org, in which case the host resolves it itself. */
  readonly organizationName?: string;
  /** The organization's URL slug, from the same resolved record. */
  readonly organizationSlug?: string;
  readonly userId: string;
  readonly elicitationMode: McpElicitationMode;
  /** Whether this session serves artifacts, read off `?artifacts=` at connect
   *  time. Absent means the default (enabled). */
  readonly artifactsEnabled?: boolean;
  /** Whether this session serves the per-integration `search_<integration>`
   *  tools, read off `?search_tools=` at connect time. Absent means the
   *  default (disabled). */
  readonly searchToolsEnabled?: boolean;
  /** The MCP resource the session was minted against (`/mcp` default vs a
   *  `/mcp/toolkits/<slug>` toolkit), so the tool catalog is scoped to it. */
  readonly resource: McpResource;
  readonly webOrigin?: string;
}

export interface McpSessionProps extends Record<string, unknown> {
  readonly session: McpSessionInit;
  readonly propagation?: IncomingTraceHeaders;
}

export type McpApprovalOwner = {
  readonly accountId: string;
  readonly organizationId: string;
};

type McpSessionApprovalErrorResult =
  | { readonly status: "not_found" }
  | { readonly status: "forbidden" };

type PendingApprovalLease = {
  readonly disposeKeepAlive: () => void;
  timeout: ReturnType<typeof setTimeout> | null;
  expiring: boolean;
};

export type McpSessionApprovalResult =
  | {
      readonly status: "ok";
      readonly text: string;
      readonly structured: Record<string, unknown>;
    }
  | McpSessionApprovalErrorResult;

export type McpSessionResumeApprovalResult =
  | {
      readonly status: "ok";
      readonly executionStatus: "completed" | "paused";
      readonly text: string;
      readonly structured: Record<string, unknown>;
      readonly isError?: boolean;
    }
  | McpSessionApprovalErrorResult;

export type McpSessionModelResumeResult = ResumeFallbackOutcome;

export interface SessionDbHandle {
  readonly end: () => Promise<void> | void;
}

export interface SessionMeta {
  readonly organizationId: string;
  readonly organizationName: string;
  /** The org's URL slug, when the host's `resolveSessionMeta` carried one.
   * Pins browser-handoff URLs to the right org's console. */
  readonly organizationSlug?: string;
  readonly userId: string;
  readonly elicitationMode?: McpElicitationMode;
  /** Whether the session serves artifacts (carried from {@link McpSessionInit}).
   *  Absent — including for sessions persisted before the flag existed — means
   *  the default (enabled). */
  readonly artifactsEnabled?: boolean;
  /** Whether the session serves the per-integration search tools (carried from
   *  {@link McpSessionInit}). Absent — including for sessions persisted before
   *  the flag existed — means the default (disabled). */
  readonly searchToolsEnabled?: boolean;
  /** The MCP resource the session serves (carried from {@link McpSessionInit});
   *  `buildMcpServer` scopes the tool catalog to it. */
  readonly resource: McpResource;
  readonly webOrigin?: string;
  /**
   * Whether this session's client advertised MCP-Apps support at `initialize`.
   *
   * Capabilities are negotiated once, into the server instance's memory. When
   * the DO is evicted (deploy, idle) and a later request cold-restores it, the
   * rebuilt server never sees an `initialize` — so without persisting this, an
   * apps-capable client silently drops to artifact deep links mid-conversation.
   * Absent — including for sessions persisted before this field existed — means
   * unknown, which behaves as disabled until the next `initialize`.
   */
  readonly appsEnabled?: boolean;
}

export interface BuiltMcpServer {
  readonly mcpServer: McpServer;
  readonly engine: ExecutionEngine<Cause.YieldableError>;
}

export interface BrowserApprovalStore {
  readonly takeResponse: (executionId: string) => Effect.Effect<ResumeResponse | null>;
  readonly waitForResponse: (executionId: string) => Effect.Effect<ResumeResponse | null>;
}

const SESSION_META_KEY = "session-meta";
const LAST_ACTIVITY_KEY = "last-activity-ms";
const PARTYSERVER_NAME_KEY = "__ps_name";
/**
 * Stand-in session id for a log line written when the DO's name could not be
 * resolved. A named placeholder keeps the field present and the log shape
 * stable, and is countable when it happens.
 */
const UNRESOLVED_SESSION_ID = "unresolved";
/** The agents SDK's durable "condemned" marker (`_cf_scheduleDestroy`). */
const AGENTS_DESTROY_PENDING_KEY = "cf_agents_destroy_pending";
const MCP_HTTP_METHOD_HEADER = "cf-mcp-method";
const MCP_MESSAGE_HEADER = "cf-mcp-message";
const MODEL_RESUME_FORWARD_TIMEOUT_MS = 10_000;
const MCP_STREAM_REQS_KEY_PREFIX = "__mcp_stream_reqs__:";
const approvalResponseKey = (executionId: string) => `approval-response:${executionId}`;

type JsonRpcRequestId = string | number;
const JsonRpcRequestWithId = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.String,
});
const JsonRpcPostPayload = Schema.fromJsonString(Schema.Unknown);
const decodeJsonRpcPostPayload = Schema.decodeUnknownOption(JsonRpcPostPayload);
const decodeJsonRpcRequestWithId = Schema.decodeUnknownOption(JsonRpcRequestWithId);

const resumeApprovalResult = (
  executionId: string,
  response: ResumeResponse,
): Extract<McpSessionResumeApprovalResult, { readonly status: "ok" }> => {
  const textByAction = {
    accept: "I've approved it",
    decline: "I've denied it",
    cancel: "I've canceled it",
  } satisfies Record<ResumeResponse["action"], string>;
  const statusByAction = {
    accept: "approved",
    decline: "denied",
    cancel: "canceled",
  } satisfies Record<ResumeResponse["action"], string>;

  return {
    status: "ok",
    executionStatus: "completed",
    text: textByAction[response.action],
    structured: { status: statusByAction[response.action], executionId },
    isError: false,
  };
};

const isSessionProps = (props: unknown): props is McpSessionProps =>
  typeof props === "object" &&
  props !== null &&
  "session" in props &&
  typeof (props as { readonly session?: unknown }).session === "object" &&
  (props as { readonly session?: unknown }).session !== null;

const readActivePostRequestIds = (request: Request): readonly JsonRpcRequestId[] => {
  if (request.headers.get(MCP_HTTP_METHOD_HEADER) !== "POST") return [];
  const encoded = request.headers.get(MCP_MESSAGE_HEADER);
  if (!encoded) return [];
  const decoded = Effect.runSyncExit(
    Effect.try({
      try: () => atob(encoded),
      catch: () => "invalid_base64" as const,
    }),
  );
  if (Exit.isFailure(decoded)) {
    console.warn(
      JSON.stringify({
        event: "mcp_active_post_response_wait_parse_failed",
        reason: "invalid_base64",
      }),
    );
    return [];
  }
  const parsed = decodeJsonRpcPostPayload(decoded.value);
  if (Option.isNone(parsed)) {
    console.warn(
      JSON.stringify({
        event: "mcp_active_post_response_wait_parse_failed",
        reason: "invalid_json",
      }),
    );
    return [];
  }
  const messages = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const requestIds: JsonRpcRequestId[] = [];
  for (const message of messages) {
    const decoded = decodeJsonRpcRequestWithId(message);
    if (Option.isSome(decoded)) requestIds.push(decoded.value.id);
  }
  return requestIds;
};

export abstract class McpAgentSessionDOBase<
  Env extends Cloudflare.Env = Cloudflare.Env,
  TDbHandle extends SessionDbHandle = SessionDbHandle,
> extends McpAgent<Env, unknown, McpSessionProps> {
  server!: McpServer;
  private engine: ExecutionEngine<Cause.YieldableError> | null = null;
  private dbHandle: TDbHandle | null = null;
  private sessionMeta: SessionMeta | null = null;
  private initialized = false;
  /** Whether this instance is currently counted in the isolate's residency
   *  gauge. Tracked separately from `engine` because `closeRuntime` runs on
   *  paths where nothing was ever built, and it must not decrement then. */
  private countedAsResident = false;
  private onStartPromise: Promise<void> | null = null;
  private lastActivityMs = 0;
  private resolvedSessionName: string | undefined = undefined;
  private approvalResponses = new Map<string, ResumeResponse>();
  private approvalWaiters = new Map<string, Deferred.Deferred<ResumeResponse>>();
  private pendingApprovalLeases = new Map<string, PendingApprovalLease>();

  protected abstract openSessionDb(): TDbHandle | Promise<TDbHandle>;

  /**
   * Build the session's {@link SessionMeta} for this init.
   *
   * `storedMeta` is what this DO already persisted for the SAME organization on
   * an earlier init, or `null`. It is offered first so a host never has to
   * re-resolve an org identity it is already holding — on cloud that resolution
   * is a fresh Postgres connection, and a cold restore used to die on it. Every
   * field the CONNECT carries (resource, elicitation mode, capability flags)
   * still comes from `token`; only the org identity may be reused.
   */
  protected abstract resolveSessionMeta(
    token: McpSessionInit,
    storedMeta: SessionMeta | null,
  ): Effect.Effect<SessionMeta>;

  protected abstract buildMcpServer(
    sessionMeta: SessionMeta,
    dbHandle: TDbHandle,
  ): Effect.Effect<BuiltMcpServer>;

  protected withTelemetry<A, E>(
    effect: Effect.Effect<A, E>,
    _incoming?: IncomingTraceHeaders,
  ): Effect.Effect<A, E> {
    return effect;
  }

  protected captureCause(_cause: Cause.Cause<unknown>): void {}

  protected captureCauseEffect(cause: Cause.Cause<unknown>): Effect.Effect<string | undefined> {
    return Effect.sync(() => {
      this.captureCause(cause);
      return undefined;
    });
  }

  protected prepareErrorCaptureScope(): Effect.Effect<void> {
    return Effect.void;
  }

  /**
   * Declare that the Durable Object has finished deciding what to do about this
   * cause — either it reported it through `captureCauseEffect`, or it
   * recognized it as expected platform behaviour and deliberately did not.
   *
   * Either way the cause is *owned here*. The host's outer error
   * instrumentation wraps the DO's entry points and would otherwise report the
   * same rejection a second time as it escapes, producing two issues per
   * failure; this is the hook that lets the host drop its own echo. Anything the
   * DO never claims (an alarm crash, a transport fault) is untouched and keeps
   * being reported by that instrumentation, which is the whole point of
   * claiming explicitly instead of disabling it.
   */
  protected claimCauseHandled(_cause: Cause.Cause<unknown>): Effect.Effect<void> {
    return Effect.void;
  }

  protected flushTelemetry(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * The session id as it appears in logs and span attributes.
   *
   * Purely observational, and therefore total: a log line or a span attribute
   * must never be able to abort the work it is describing. The alarm path is
   * the one that used to prove this the hard way — it logged its decision
   * before doing it, and on an invocation where the name could not be resolved
   * the LOG threw and took the whole alarm with it.
   */
  protected sessionIdForTelemetry(): string {
    return this.sessionIdOrUndefined() ?? UNRESOLVED_SESSION_ID;
  }

  /**
   * The session id, or `undefined` when this DO's name cannot be resolved from
   * any source. Derived from {@link sessionNameOrUndefined} so it agrees with
   * the guard that decided the DO was addressable in the first place.
   */
  protected sessionIdOrUndefined(): string | undefined {
    const name = this.sessionNameOrUndefined();
    if (name === undefined) return undefined;
    const [, sessionId] = name.split(":");
    return sessionId ? sessionId : undefined;
  }

  /**
   * The session id for callers that cannot proceed without one — routing an
   * execution back to its owner, addressing an approval URL. Those callers want
   * the throw, because a wrong id is worse than a failure.
   */
  protected get sessionId(): string {
    const resolved = this.sessionIdOrUndefined();
    if (resolved !== undefined) return resolved;
    return this.getSessionId();
  }

  /**
   * The single place that answers "what is this Durable Object's name".
   *
   * PartyServer has three sources and does not consult them all in the same
   * place: `this.name` reads `ctx.id.name` and an in-memory field that is only
   * hydrated during initialization, while the durable `__ps_name` record is
   * read *only* by that initialization. An entry point that skips
   * initialization — the alarm override below, which handles most of its
   * decisions itself and only delegates to `super.alarm()` on one branch — can
   * therefore find the durable record present, conclude the session is
   * addressable, and still have `this.name` throw on the very next read.
   *
   * Everything in this class goes through this accessor instead, so the guard
   * and the reads that follow it can never disagree.
   */
  private sessionNameOrUndefined(): string | undefined {
    return this.ctx.id.name ?? this.resolvedSessionName ?? this.partyServerNameOrUndefined();
  }

  /**
   * Ask every source, including durable storage, and remember the answer.
   *
   * The remembered value is what makes the synchronous accessor above agree
   * with this one for the rest of the invocation: a name recovered from the
   * `__ps_name` record stays available to callers that cannot await.
   */
  private async resolveSessionName(): Promise<string | undefined> {
    const inMemory = this.sessionNameOrUndefined();
    if (inMemory !== undefined) {
      this.resolvedSessionName = inMemory;
      return inMemory;
    }
    const stored = await this.ctx.storage.get<string>(PARTYSERVER_NAME_KEY);
    if (!stored) return undefined;
    this.resolvedSessionName = stored;
    return stored;
  }

  /**
   * Read PartyServer's own name resolution without inheriting its throw.
   *
   * PartyServer exposes no non-throwing probe for "do you have a name yet", so
   * "it throws" IS the signal for "not resolvable from memory" — the same shape
   * as {@link connectionsOrNone}. In a unit harness the getter also
   * throws on its uninitialized private field, which reads identically here and
   * is equally correct.
   */
  private partyServerNameOrUndefined(): string | undefined {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: see doc comment; partyserver's `name` getter throws instead of reporting absence.
    try {
      return (this as { readonly name?: string }).name;
    } catch {
      return undefined;
    }
  }

  protected currentParentSpan(): Tracer.AnySpan | undefined {
    return undefined;
  }

  protected sessionTimeoutMs(): number {
    return SESSION_TIMEOUT_MS;
  }

  protected maxPausedSessionIdleMs(): number {
    return MAX_PAUSED_SESSION_IDLE_MS;
  }

  protected executionOwnerDirectory(): McpExecutionOwnerDirectory | null {
    return null;
  }

  protected executionOwnerRoute(): McpExecutionOwnerRoute {
    return { sessionId: this.sessionId };
  }

  protected sameExecutionOwnerRoute(a: McpExecutionOwnerRoute, b: McpExecutionOwnerRoute): boolean {
    return a.sessionId === b.sessionId;
  }

  protected forwardModelResumeToOwner(
    _owner: McpExecutionOwnerRoute,
    _identity: McpApprovalOwner,
    _executionId: string,
    _response: ResumeResponse,
  ): Effect.Effect<McpSessionModelResumeResult, unknown> {
    return Effect.succeed({
      status: "execution_expired",
      ttlMs: PAUSED_APPROVAL_TIMEOUT_MS,
    });
  }

  protected readonly browserApprovalStore: BrowserApprovalStore = {
    takeResponse: (executionId) => this.takeApprovalResponse(executionId),
    waitForResponse: (executionId) => this.waitForApprovalResponse(executionId),
  };

  protected readonly modelResumeFallback = (
    executionId: string,
    response: ResumeResponse,
  ): Effect.Effect<ResumeFallbackOutcome | null> =>
    this.resumeFromExecutionOwnerDirectory(executionId, response);

  protected readonly pausedExecutionHooks: PausedExecutionHooks = {
    onExecutionPaused: (executionId, deadline) =>
      Effect.sync(() => {
        this.queuePendingApprovalLeaseStart(executionId, deadline);
      }),
    onResumeStarted: (executionId) => this.beginPendingApprovalResume(executionId),
    onResumeSettled: (executionId) => this.finishPendingApprovalResume(executionId),
  };

  override async onConnect(conn: Connection, context: ConnectionContext): Promise<void> {
    const requestIds = readActivePostRequestIds(context.request);
    if (requestIds.length === 0) {
      await super.onConnect(conn, context);
      return;
    }

    await this.keepAliveWhile(async () => {
      await this.setStreamRequestIds(conn.id, [...requestIds]);
      await super.onConnect(conn, context);
    });
  }

  private openSessionDbHandle(): Effect.Effect<TDbHandle> {
    return Effect.promise(() => Promise.resolve(this.openSessionDb()));
  }

  private loadSessionMeta(): Effect.Effect<SessionMeta | null> {
    return Effect.promise(async () => {
      if (this.sessionMeta) return this.sessionMeta;
      const stored = await this.ctx.storage.get<SessionMeta>(SESSION_META_KEY);
      // Backfill `resource` for sessions persisted before scoped toolkits added
      // the field. Their stored meta has no `resource`, and every such session
      // was minted against the default `/mcp` endpoint, so default it here
      // rather than let owner validation read `.kind` off undefined.
      this.sessionMeta = stored
        ? { ...stored, resource: stored.resource ?? defaultMcpResource }
        : null;
      return this.sessionMeta;
    }).pipe(Effect.withSpan("mcp.session.load_meta"));
  }

  private async saveSessionMeta(sessionMeta: SessionMeta): Promise<void> {
    this.sessionMeta = sessionMeta;
    await this.ctx.storage.put(SESSION_META_KEY, sessionMeta);
  }

  /**
   * Persist the MCP-Apps support negotiated at `initialize`, so a later cold
   * restore can rebuild the server with it. Subclasses hand this to
   * `createExecutorMcpServer` as `onAppsEnabledChange`.
   *
   * A no-op before meta exists: `initialize` always follows `init`, so there is
   * nothing to merge into and nothing worth failing the session over.
   */
  protected persistAppsEnabled(appsEnabled: boolean): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const stored = yield* self.loadSessionMeta();
      if (!stored || stored.appsEnabled === appsEnabled) return;
      yield* Effect.promise(() => self.saveSessionMeta({ ...stored, appsEnabled }));
    }).pipe(
      Effect.withSpan("mcp.session.persist_apps_enabled", {
        attributes: { "mcp.artifact.apps_enabled": appsEnabled },
      }),
      Effect.ignoreCause({ log: false }),
    );
  }

  private async markActivity(now = Date.now()): Promise<void> {
    this.lastActivityMs = now;
    // Keeps the isolate-wide eviction registry's LRU order current. A no-op
    // when this session has no registry entry yet (nothing resident) or none
    // any more (already disposed) — `touchResidentSession` is a lookup-then-set
    // that quietly does nothing on a miss.
    touchResidentSession(this.sessionIdForTelemetry(), now);
    await Promise.all([
      this.ctx.storage.put(LAST_ACTIVITY_KEY, now),
      this.ctx.storage.setAlarm(now + this.sessionTimeoutMs()),
    ]);
  }

  /**
   * Keep this session's idle deadline armed across the SDK's own alarm
   * bookkeeping.
   *
   * The agents SDK recomputes the Durable Object alarm from its schedule table
   * and keep-alive refcount, and when it finds neither it does not leave the
   * alarm alone — it DELETES it. It releases the last keep-alive ref at the end
   * of every ordinary request, from a `waitUntil`, so the idle alarm that
   * `markActivity` had just armed was being erased moments after the response
   * went out. A session that had just served a tool call was therefore left
   * with no alarm at all: the idle policy never ran again, and its runtime
   * stayed resident until the platform evicted the whole object.
   *
   * The idle deadline belongs to this class, not to the SDK's scheduler, so it
   * is re-asserted after the SDK has arranged whatever it needs. Only while a
   * runtime is actually resident — once there is nothing left to reclaim the
   * SDK's answer is right and re-arming would spin the alarm forever.
   */
  protected async ensureIdleAlarmArmed(): Promise<void> {
    if (!this.hasResidentRuntime()) return;
    const lastActivityMs = await this.loadLastActivity();
    if (lastActivityMs <= 0) return;
    const idleDeadlineMs = lastActivityMs + this.sessionTimeoutMs();
    const armed = await this.ctx.storage.getAlarm();
    if (armed !== null && armed <= idleDeadlineMs) return;
    await this.ctx.storage.setAlarm(Math.max(idleDeadlineMs, Date.now() + 1));
  }

  private async loadLastActivity(): Promise<number> {
    if (this.lastActivityMs > 0) return this.lastActivityMs;
    const stored = await this.ctx.storage.get<number>(LAST_ACTIVITY_KEY);
    this.lastActivityMs = stored ?? 0;
    return this.lastActivityMs;
  }

  private activeStreamCount(): number {
    return this.connectionsOrNone().length;
  }

  private async runningExecutionCount(): Promise<number> {
    // Only requests still awaiting a result count as running work. Undelivered
    // response markers (the transport's __mcp_undelivered_stream__: keys)
    // deliberately do NOT extend the lease: the response is persisted in storage,
    // which survives disposeIdleRuntime, so a later reconnect GET re-inits the
    // DO and replays it. Counting them would make every delivered-but-unacked
    // POST response pin the runtime alive indefinitely.
    const rows = await this.ctx.storage.list<readonly JsonRpcRequestId[]>({
      prefix: MCP_STREAM_REQS_KEY_PREFIX,
      limit: 1_000,
    });
    let count = 0;
    for (const requestIds of rows.values()) {
      if (Array.isArray(requestIds)) count += requestIds.length;
    }
    return count;
  }

  private closeActiveStreams(): void {
    for (const connection of this.connectionsOrNone()) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: best-effort WebSocket close during runtime disposal.
      try {
        connection.close(1000, "Session closed");
      } catch {}
    }
  }

  /**
   * partyserver's `getConnections` dereferences a `#connectionManager`
   * private field that is only initialized once the DO has accepted a
   * websocket (never in unit harnesses), and partyserver exposes no
   * non-throwing probe for that state, so "it throws" IS the signal for
   * "no connections yet". Treating that as an empty set is safe for both
   * callers: `closeActiveStreams` then has nothing to close, and
   * `activeStreamCount` feeds the idle-lease decision where zero at worst
   * disposes an idle-looking runtime whose undelivered responses are
   * persisted in durable storage and replayed by the next reconnect GET.
   * Before this guard the alarm crashed and retried instead, which kept
   * the session pinned without ever making progress.
   */
  private connectionsOrNone(): ReadonlyArray<Connection> {
    const getConnections = (this as { getConnections?: () => Iterable<Connection> }).getConnections;
    if (!getConnections) return [];
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: see doc comment; partyserver offers no non-throwing way to ask whether the connection manager exists.
    try {
      return Array.from(getConnections.call(this));
    } catch {
      return [];
    }
  }

  private async cleanupUnaddressableSessionAlarm(): Promise<void> {
    // No name from any source means no session to act on: there is nothing to
    // route, nothing to identify, and no id to put in this line. Say so, tear
    // the runtime down, drop the alarm, and return normally — a session that
    // cannot be addressed must not leave an alarm retrying forever.
    console.warn(
      JSON.stringify({
        event: "mcp_session_unaddressable_alarm_cleanup",
        sessionId: this.sessionIdForTelemetry(),
      }),
    );
    await Effect.runPromise(this.closeRuntime());
    await Effect.runPromise(
      Effect.all([
        Effect.ignore(Effect.tryPromise(() => this.ctx.storage.deleteAlarm())),
        Effect.ignore(Effect.tryPromise(() => this.ctx.storage.delete(LAST_ACTIVITY_KEY))),
      ]),
    );
  }

  /** Whether anything is currently holding isolate memory for this session. */
  private hasResidentRuntime(): boolean {
    return this.initialized || this.engine !== null || this.dbHandle !== null;
  }

  /**
   * Drop this session's execution runtime, returning its memory to the
   * isolate. Nothing durable is discarded, so the next request restores the
   * session and the client sees only restore latency.
   *
   * `reason` disambiguates WHY on the shared span and log line without
   * splitting them: `"idle"` is the alarm-driven path (this session itself
   * went quiet), `"cap"` is another session's `init` evicting this one because
   * the isolate was over its resident-runtime ceiling. The mechanism —
   * `closeRuntime` plus dropping the durable alarm/activity bookkeeping — is
   * identical either way; only the trigger differs, and callers are expected
   * to have already established (via their own eligibility check) that
   * disposing this session right now is safe.
   */
  private async disposeIdleRuntime(input: {
    readonly idleMs: number;
    readonly pausedExecutionCount: number;
    readonly activeStreamCount: number;
    readonly reason?: "idle" | "cap";
  }): Promise<void> {
    const reason = input.reason ?? "idle";
    console.info(
      JSON.stringify({
        event: "mcp_session_idle_runtime_dispose",
        sessionId: this.sessionIdForTelemetry(),
        idleMs: input.idleMs,
        pausedExecutionCount: input.pausedExecutionCount,
        activeStreamCount: input.activeStreamCount,
        reason,
      }),
    );
    const self = this;
    const program = Effect.gen(function* () {
      yield* self.closeRuntime();
      yield* Effect.all([
        Effect.ignore(Effect.tryPromise(() => self.ctx.storage.deleteAlarm())),
        Effect.ignore(Effect.tryPromise(() => self.ctx.storage.delete(LAST_ACTIVITY_KEY))),
      ]);
      // Read the gauge AFTER the release, so the attribute reports what the
      // isolate is actually holding now rather than what it held a moment ago.
      yield* Effect.annotateCurrentSpan(residencyAttributes());
    }).pipe(
      // Span name kept stable for dashboard continuity across both triggers;
      // `mcp.session.dispose_reason` is what disambiguates them.
      Effect.withSpan("mcp.session.idle_runtime_dispose", {
        attributes: {
          "mcp.session.id": self.sessionId,
          "mcp.session.idle_ms": input.idleMs,
          "mcp.session.paused_execution_count": input.pausedExecutionCount,
          "mcp.session.active_stream_count": input.activeStreamCount,
          "mcp.session.dispose_reason": reason,
        },
      }),
    );
    // The alarm has no incoming trace context of its own, so this starts a new
    // trace. It still has to be flushed explicitly — the alarm is not on any
    // request's response path, and without the flush the span dies with the
    // isolate and the mechanism stays unobservable in production.
    await Effect.runPromise(this.withSpanFlush(this.withTelemetry(program)));
  }

  /**
   * Isolate is over its resident-runtime soft cap and this session was the
   * LRU-eligible pick (see `pickEvictionCandidate`). Re-checks every
   * disqualifying signal `decideSessionAlarm` treats as active work — LIVE,
   * not the snapshot `canEvict` used to be picked — because a session can
   * start a request in the gap between being picked and being disposed here.
   * `canEvict`'s snapshot is a cheap, synchronous, necessarily-optimistic
   * filter for CHOOSING among candidates; this is the authoritative gate that
   * actually decides whether disposing this session right now is safe, and it
   * includes the one signal `canEvict` cannot see synchronously — undelivered
   * stream responses still in storage. A session that is no longer eligible is
   * left alone: eviction becomes a no-op instead of a wrongful teardown.
   */
  private async evictResidentRuntimeForCap(): Promise<void> {
    const [pausedExecutionCount, runningExecutionCount] = await Promise.all([
      this.pausedExecutionCount(),
      this.runningExecutionCount(),
    ]);
    const activeStreamCount = this.activeStreamCount();
    if (pausedExecutionCount > 0 || runningExecutionCount > 0 || activeStreamCount > 0) return;
    const idleMs = this.lastActivityMs > 0 ? Date.now() - this.lastActivityMs : 0;
    await this.disposeIdleRuntime({
      idleMs,
      pausedExecutionCount,
      activeStreamCount,
      reason: "cap",
    });
  }

  /**
   * Cheap, synchronous eligibility filter consulted by `pickEvictionCandidate`
   * to choose AMONG resident sessions. Deliberately conservative rather than
   * exhaustive: it mirrors the same "no active work" signals
   * `decideSessionAlarm` treats as disqualifying, restricted to what can be
   * answered without an async storage read (undelivered stream responses,
   * `runningExecutionCount`, requires one). `evictResidentRuntimeForCap`
   * re-checks the full set — including that signal — right before actually
   * disposing, so a false "evictable" here can only ever produce a safe
   * no-op, never a wrongful eviction.
   */
  private canEvictResidentRuntime(): boolean {
    if (this.activeStreamCount() > 0) return false;
    if (!this.engine) return true;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: this is a best-effort eviction-selection filter; a broken engine read must fail toward "not evictable", never toward crashing whichever OTHER session's init is picking a candidate.
    try {
      return Effect.runSync(this.engine.pausedExecutionCount()) === 0;
    } catch {
      return false;
    }
  }

  /**
   * The soft cap this instance enforces. A protected method rather than a bare
   * reference to `RESIDENT_RUNTIME_SOFT_CAP`, matching `sessionTimeoutMs` and
   * `maxPausedSessionIdleMs` elsewhere in this class, so tests can install a
   * small cap and exercise real eviction without registering 32 sessions.
   */
  protected residentRuntimeSoftCap(): number {
    return RESIDENT_RUNTIME_SOFT_CAP;
  }

  /**
   * Before this session's own runtime is built, make room if the isolate is
   * already at its resident-runtime cap. Evicts AT MOST ONE other session —
   * never loops — and never fails or delays this init over it: if nothing is
   * currently evictable (every resident is streaming or paused), this session
   * still builds and the overflow is only recorded on the init span, because a
   * memory-pressure mechanism must never itself become the reason a session
   * fails to start.
   */
  private evictForCapIfNeeded(): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      if (currentResidentRuntimeCount() < self.residentRuntimeSoftCap()) return;
      const candidate = pickEvictionCandidate();
      if (!candidate) {
        yield* Effect.annotateCurrentSpan({ "mcp.isolate.cap_overflow": true });
        return;
      }
      yield* Effect.tryPromise({
        try: () => candidate.dispose("cap"),
        catch: (cause: unknown) => ({ _tag: "CapEvictionDisposeFailure" as const, cause }),
      }).pipe(
        Effect.catch((failure) =>
          Effect.sync(() => {
            // The candidate's OWN teardown failed. It is no longer safe to
            // trust this entry as a future eviction target — a repeatedly
            // failing disposal must not squat the LRU slot forever — but its
            // resident-runtime count is untouched: whatever it holds is, as
            // far as this session's init knows, still actually resident. The
            // failure itself is unknown-shaped (whatever `dispose` threw), so
            // it is logged as a plain defect rather than normalized into a
            // message string.
            releaseResidentSession(candidate.sessionId);
            console.warn(
              JSON.stringify({
                event: "mcp_session_cap_eviction_failed",
                sessionId: candidate.sessionId,
              }),
            );
            console.error("[mcp-session] cap eviction dispose failed:", failure.cause);
          }),
        ),
      );
    });
  }

  private resolveAndStoreSessionMeta(token: McpSessionInit) {
    const self = this;
    return Effect.gen(function* () {
      // Read what this DO already knows BEFORE asking the host to resolve
      // anything. `init` runs again on every cold restore, and the stored meta
      // is this session's own durable record of the organization it was minted
      // for — re-deriving that identity from the host's backing store is the
      // single most failure-prone step of a restore (on cloud, a brand-new
      // Postgres connection) and it is redundant for a session that already
      // exists. It is offered only for the SAME organization; a token naming a
      // different org resolves from scratch.
      const stored = yield* self.loadSessionMeta();
      const reusable = stored && stored.organizationId === token.organizationId ? stored : null;
      // The stored meta also carries the capabilities negotiated at
      // `initialize`, which the bearer token knows nothing about. Carry them
      // forward, or restoring the session would erase the very bit that
      // survives the restore.
      const resolved = yield* self.resolveSessionMeta(token, reusable);
      const sessionMeta: SessionMeta = {
        ...resolved,
        ...(token.webOrigin ? { webOrigin: token.webOrigin } : {}),
        ...(stored?.appsEnabled === undefined ? {} : { appsEnabled: stored.appsEnabled }),
      };
      yield* Effect.promise(() => self.saveSessionMeta(sessionMeta)).pipe(
        Effect.withSpan("mcp.session.save_meta"),
      );
      return sessionMeta;
    }).pipe(Effect.withSpan("mcp.session.resolve_and_store_meta"));
  }

  /**
   * A Cloudflare platform reset happened. Record what KIND it was, on the span
   * and in a structured log, so the volume stays countable per cause (deploy
   * reset vs storage timeout vs backend blip) instead of collapsing into one
   * opaque bucket the moment it stops being an error report.
   */
  private recordDurableObjectReset(input: {
    readonly operation: string;
    readonly failure: DurableObjectFailure;
    readonly cause: Cause.Cause<unknown>;
  }): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      console.warn(
        JSON.stringify({
          event: "mcp_session_durable_object_reset",
          operation: input.operation,
          sessionId: self.sessionIdForTelemetry(),
          resetKind: input.failure.kind,
          disposition: input.failure.disposition,
          cause: Cause.pretty(input.cause),
        }),
      );
      yield* Effect.annotateCurrentSpan({
        "mcp.do.reset_kind": input.failure.kind,
        "mcp.do.reset_disposition": input.failure.disposition,
        "mcp.do.reset_operation": input.operation,
      });
    });
  }

  /**
   * Run a storage write whose only job is bookkeeping, and let the Cloudflare
   * platform take it away without taking the session with it.
   *
   * A platform reset (a deploy, a storage timeout, a backend blip) cancels
   * whatever write is in flight. For a write nothing depends on, the right
   * answer is to note it and carry on — the alternative, which is what used to
   * happen, is that a fully built and perfectly healthy session is torn down and
   * the user's request fails because a timestamp did not land.
   *
   * Scoped deliberately: only failures the classifier RECOGNIZES as platform
   * resets are absorbed. Anything else is still a defect and still fails.
   */
  private bestEffortBookkeeping(operation: string, run: () => Promise<void>): Effect.Effect<void> {
    const self = this;
    return Effect.promise(run).pipe(
      Effect.catchCause((cause) => {
        const failure = classifyDurableObjectError(cause);
        if (!failure) return Effect.failCause(cause);
        return self.recordDurableObjectReset({ operation, failure, cause });
      }),
    );
  }

  private recordCauseOnSpan(cause: Cause.Cause<unknown>): Effect.Effect<void> {
    const errors = Cause.prettyErrors(cause);
    if (errors.length === 0) return Effect.void;
    const first = errors[0];
    return Effect.annotateCurrentSpan({
      "exception.type": first?.name ?? "Error",
      "exception.message": first?.message ?? "unknown",
      "exception.stacktrace": Cause.pretty(cause),
    });
  }

  private logExecutionOwnerDirectoryFailure(input: {
    readonly operation: "put" | "get" | "delete";
    readonly executionId: string;
    readonly cause: Cause.Cause<unknown>;
  }): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const first = Cause.prettyErrors(input.cause)[0];
      console.error(
        JSON.stringify({
          event: "mcp_execution_owner_directory_error",
          operation: input.operation,
          executionId: input.executionId,
          sessionId: self.sessionIdForTelemetry(),
          exceptionType: first?.name ?? "Error",
          exceptionMessage: first?.message ?? "unknown",
          cause: Cause.pretty(input.cause),
        }),
      );
      yield* Effect.annotateCurrentSpan({
        "mcp.execution_owner.directory.operation": input.operation,
      });
      yield* self.recordCauseOnSpan(input.cause);
    });
  }

  private logModelResumeForwardFailure(input: {
    readonly executionId: string;
    readonly owner: McpExecutionOwnerRoute;
    readonly cause: Cause.Cause<unknown>;
  }): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const first = Cause.prettyErrors(input.cause)[0];
      console.error(
        JSON.stringify({
          event: "mcp_model_resume_forward_error",
          executionId: input.executionId,
          sessionId: self.sessionIdForTelemetry(),
          ownerSessionId: input.owner.sessionId,
          exceptionType: first?.name ?? "Error",
          exceptionMessage: first?.message ?? "unknown",
          cause: Cause.pretty(input.cause),
        }),
      );
      yield* Effect.annotateCurrentSpan({
        "mcp.execution_owner.forward.owner_session_id": input.owner.sessionId,
      });
      yield* self.recordCauseOnSpan(input.cause);
    });
  }

  private logModelResumeForwardTimeout(input: {
    readonly executionId: string;
    readonly owner: McpExecutionOwnerRoute;
    readonly timeoutMs: number;
  }): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      console.error(
        JSON.stringify({
          event: "mcp_model_resume_forward_error",
          reason: "timeout",
          executionId: input.executionId,
          sessionId: self.sessionIdForTelemetry(),
          ownerSessionId: input.owner.sessionId,
          timeoutMs: input.timeoutMs,
        }),
      );
      yield* Effect.annotateCurrentSpan({
        "mcp.execution_owner.forward.owner_session_id": input.owner.sessionId,
        "mcp.execution_owner.forward.error": "timeout",
      });
    });
  }

  private withSpanFlush<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
    const self = this;
    return effect.pipe(Effect.ensuring(Effect.promise(() => self.flushTelemetry())));
  }

  private buildRuntime(sessionMeta: SessionMeta, dbHandle: TDbHandle) {
    const built = sessionMeta.organizationSlug
      ? this.buildMcpServer(sessionMeta, dbHandle).pipe(
          Effect.provideService(RequestOrgSlug, { slug: sessionMeta.organizationSlug }),
        )
      : this.buildMcpServer(sessionMeta, dbHandle);
    return sessionMeta.webOrigin
      ? built.pipe(Effect.provideService(RequestWebOrigin, { origin: sessionMeta.webOrigin }))
      : built;
  }

  private closeRuntime(options: { readonly closeStreams?: boolean } = {}): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.releaseAllPendingApprovalLeases();
      if (options.closeStreams ?? true) {
        yield* Effect.sync(() => self.closeActiveStreams());
      }
      if (self.server) {
        const server = self.server;
        delete (self as { server?: McpServer }).server;
        yield* Effect.promise(() => server.close()).pipe(Effect.ignore);
      }
      Reflect.set(self, "_transport", undefined);
      self.engine = null;
      if (self.dbHandle) {
        const dbHandle = self.dbHandle;
        self.dbHandle = null;
        yield* Effect.promise(() => Promise.resolve(dbHandle.end())).pipe(Effect.ignore);
      }
      self.initialized = false;
      if (self.countedAsResident) {
        self.countedAsResident = false;
        releaseResidentRuntime();
        // Pairs with `registerResidentSession` in `init`. Idempotent, and
        // gated on the same flag that guards the counter release, so a
        // `closeRuntime` that runs on a path where nothing was ever built
        // never removes an entry it did not add.
        releaseResidentSession(self.sessionIdForTelemetry());
      }
    });
  }

  private ensureRuntimeForApproval(): Effect.Effect<boolean> {
    const self = this;
    return Effect.gen(function* () {
      if (self.initialized && self.engine) return true;

      const sessionMeta = yield* self.loadSessionMeta();
      if (!sessionMeta) return false;

      yield* Effect.promise(() => self.onStart()).pipe(
        Effect.withSpan("McpSessionDO.restore_runtime_for_approval"),
      );
      return self.initialized && !!self.engine;
    }).pipe(Effect.withSpan("McpSessionDO.ensure_runtime_for_approval"));
  }

  private startRuntimeFromOnStart(props?: McpSessionProps): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      // PartyServer can rehydrate WebSockets before onStart runs in a
      // cold-restored isolate. With no in-memory runtime to replace, those
      // sockets are the live MCP response streams that triggered the restore.
      const hasInMemoryRuntime =
        self.initialized ||
        self.engine !== null ||
        self.dbHandle !== null ||
        self.server !== undefined;
      yield* self.closeRuntime({ closeStreams: hasInMemoryRuntime });
      const started = yield* Effect.exit(Effect.promise(() => self.runMcpAgentOnStart(props)));
      if (Exit.isFailure(started)) {
        yield* self.closeRuntime();
        return yield* Effect.failCause(started.cause);
      }
    });
  }

  protected runMcpAgentOnStart(props?: McpSessionProps): Promise<void> {
    return super.onStart(props);
  }

  override async onStart(props?: McpSessionProps): Promise<void> {
    if (this.onStartPromise) return this.onStartPromise;

    const starting = Effect.runPromise(this.startRuntimeFromOnStart(props));
    this.onStartPromise = starting;
    starting.then(
      () => {
        if (this.onStartPromise === starting) this.onStartPromise = null;
      },
      () => {
        if (this.onStartPromise === starting) this.onStartPromise = null;
      },
    );
    return starting;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const props = isSessionProps(this.props) ? this.props : null;
    if (!props) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: McpAgent.init is a Promise-only framework hook and props are required before any Effect runtime exists.
      throw new Error("MCP session props are required");
    }
    const self = this;
    const program = Effect.gen(function* () {
      yield* self.prepareErrorCaptureScope();
      const sessionMeta = yield* self.resolveAndStoreSessionMeta(props.session);
      // Before building anything that will itself occupy isolate memory
      // (a live db handle, the engine, the built tool catalog), make room if
      // this isolate is already at its resident-runtime cap. Deliberately
      // BEFORE `openSessionDbHandle`, not just before `buildRuntime`: the db
      // handle is one of the three things a resident runtime holds.
      yield* self.evictForCapIfNeeded();
      const dbHandle = yield* self.openSessionDbHandle();
      const { mcpServer, engine } = yield* self.buildRuntime(sessionMeta, dbHandle);
      self.dbHandle = dbHandle;
      self.server = mcpServer;
      self.engine = engine;
      self.initialized = true;
      if (!self.countedAsResident) {
        self.countedAsResident = true;
        acquireResidentRuntime();
        // Paired with `releaseResidentSession` in `closeRuntime`. Registered
        // as soon as this session counts as resident, so a cap check running
        // in another session's `init` moments later already sees it as a
        // candidate. `markActivity` below immediately corrects the initial
        // timestamp via `touchResidentSession`, so `Date.now()` here only
        // needs to be a safe placeholder, not the true last-activity time.
        registerResidentSession({
          sessionId: self.sessionIdForTelemetry(),
          lastActivityMs: Date.now(),
          canEvict: () => self.canEvictResidentRuntime(),
          dispose: () => self.evictResidentRuntimeForCap(),
        });
      }
      // The gauge on the way up. Paired with the same attributes on
      // `mcp.session.idle_runtime_dispose`, this is what shows whether idle
      // sessions are actually giving their runtimes back in production.
      yield* Effect.annotateCurrentSpan(residencyAttributes());
      // Last statement, and pure bookkeeping: the runtime above is already
      // installed and serving. Losing the timestamp/alarm write to a platform
      // reset must not undo any of it — the in-memory clock is already set and
      // the next request re-arms the alarm.
      yield* self
        .bestEffortBookkeeping("init.mark_activity", () => self.markActivity())
        .pipe(Effect.withSpan("McpSessionDO.markActivity"));
    }).pipe(
      // ONE capture owner for an init defect. `init` can only reject its
      // Promise, and the host's DO-level error instrumentation captures that
      // rejection too — so the DO claims the cause below and the host drops its
      // own echo, rather than both filing the same failure as two issues with
      // the same trace id and span id.
      Effect.tapCause((cause) =>
        Effect.gen(function* () {
          // A Cloudflare platform reset of an in-flight init is not a defect —
          // every deploy causes one, by design. Record the kind so the volume
          // stays measurable, let the caller render it as a retry, and do not
          // page for it. Everything else is reported exactly as before.
          const failure = classifyDurableObjectError(cause);
          if (failure) {
            yield* self.recordDurableObjectReset({ operation: "init", failure, cause });
          } else {
            console.error("[mcp-session] init failed:", Cause.pretty(cause));
            yield* self.captureCauseEffect(cause);
          }
          yield* self.recordCauseOnSpan(cause);
          // Claimed AFTER any capture above, so the DO's own event is not
          // mistaken for the host instrumentation's duplicate of it.
          yield* self.claimCauseHandled(cause);
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => self.cleanup());
          return yield* Effect.failCause(cause);
        }),
      ),
      Effect.withSpan("McpSessionDO.init", {
        attributes: {
          "mcp.auth.organization_id": props?.session.organizationId ?? "",
        },
      }),
    );
    const traced = this.withTelemetry(program, props?.propagation);
    return Effect.runPromise(
      traced.pipe(
        // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: Durable Object init method can only reject its Promise
        Effect.orDie,
        (effect) => self.withSpanFlush(effect),
      ),
    );
  }

  async validateMcpSessionOwner(
    identity: McpApprovalOwner,
  ): Promise<"ok" | "not_found" | "forbidden" | "terminated"> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* self.prepareErrorCaptureScope();
        // A DELETE-terminated session is condemned via `_cf_scheduleDestroy`,
        // which writes a durable marker and defers the actual `destroy()` to
        // an alarm (~1s later). A request that races into that window still
        // sees the session's storage intact, so without this gate the session
        // would restore and answer — but the protocol contract is that a
        // terminated id is dead the moment the DELETE returns. (The old code
        // won this race by accident: its onConnect drain-wait stalled the
        // request until the destroy alarm aborted the isolate.)
        const destroyPending = yield* Effect.promise(() =>
          self.ctx.storage.get<boolean>(AGENTS_DESTROY_PENDING_KEY),
        );
        if (destroyPending === true) return "terminated" as const;
        const sessionMeta = yield* self.loadSessionMeta();
        if (!sessionMeta) return "not_found" as const;
        if (self.initialized) {
          yield* self
            .bestEffortBookkeeping("validate_owner.mark_activity", () => self.markActivity())
            .pipe(Effect.withSpan("McpSessionDO.markActivity"));
        } else {
          yield* Effect.promise(() => self.onStart()).pipe(
            Effect.withSpan("McpSessionDO.restore_transport_runtime"),
          );
        }
        return identity.accountId === sessionMeta.userId &&
          identity.organizationId === sessionMeta.organizationId
          ? ("ok" as const)
          : ("forbidden" as const);
      }).pipe(
        Effect.withSpan("McpSessionDO.validateMcpSessionOwner"),
        // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: DO RPC exposes Promise results
        Effect.orDie,
      ),
    );
  }

  async getPausedExecutionForApproval(
    executionId: string,
    identity: McpApprovalOwner,
    incoming?: IncomingTraceHeaders,
  ): Promise<McpSessionApprovalResult> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* self.prepareErrorCaptureScope();
        const owner = yield* self.validateApprovalIdentity(identity);
        if (owner !== "ok") return { status: owner } as const;

        const restored = yield* self.ensureRuntimeForApproval();
        if (!restored || !self.engine) return { status: "not_found" } as const;

        const paused = yield* self.engine.getPausedExecution(executionId);
        if (!paused) return { status: "not_found" } as const;

        const deadline = yield* self.deadlineForExecution(executionId);
        const formatted = formatPausedExecution(paused, { deadline });
        return {
          status: "ok" as const,
          text: formatted.text,
          structured: formatted.structured,
        };
      }).pipe(
        Effect.withSpan("McpSessionDO.getPausedExecutionForApproval", {
          attributes: { "mcp.execution.id": executionId },
        }),
        (eff) => this.withTelemetry(eff, incoming),
        // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: DO RPC exposes Promise results
        Effect.orDie,
        (eff) => self.withSpanFlush(eff),
      ),
    );
  }

  async resumeExecutionForModel(
    executionId: string,
    identity: McpApprovalOwner,
    response: ResumeResponse,
    incoming?: IncomingTraceHeaders,
  ): Promise<McpSessionModelResumeResult> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* self.prepareErrorCaptureScope();
        const owner = yield* self.validateApprovalIdentity(identity);
        if (owner === "forbidden") return { status: "execution_forbidden" } as const;
        if (owner === "not_found") {
          return { status: "execution_expired" as const, ttlMs: PAUSED_APPROVAL_TIMEOUT_MS };
        }

        const restored = yield* self.ensureRuntimeForApproval();
        if (!restored || !self.engine) {
          yield* self.deleteExecutionOwnerEntry(executionId);
          return { status: "execution_expired" as const, ttlMs: PAUSED_APPROVAL_TIMEOUT_MS };
        }

        const outcome = yield* self.resumeEngineWithLifecycle(executionId, response);
        if (!outcome) {
          const alreadySettled = self.engine.isExecutionSettled
            ? yield* self.engine.isExecutionSettled(executionId)
            : false;
          yield* self.deleteExecutionOwnerEntry(executionId);
          return alreadySettled
            ? ({ status: "execution_already_settled" } as const)
            : ({ status: "execution_expired", ttlMs: PAUSED_APPROVAL_TIMEOUT_MS } as const);
        }

        if (outcome.status === "paused") {
          const deadline = self.approvalDeadline();
          yield* self.startPendingApprovalLease(outcome.execution.id, deadline);
          return {
            status: "result" as const,
            result: formatMcpExecutionOutcome(outcome, { pausedDeadline: deadline }),
          };
        }

        return {
          status: "result" as const,
          result: formatMcpExecutionOutcome(outcome),
        };
      }).pipe(
        Effect.withSpan("McpSessionDO.resumeExecutionForModel", {
          attributes: { "mcp.execution.id": executionId },
        }),
        (eff) => this.withTelemetry(eff, incoming),
        // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: DO RPC exposes Promise results
        Effect.orDie,
        (eff) => self.withSpanFlush(eff),
      ),
    );
  }

  async resumeExecutionForApproval(
    executionId: string,
    identity: McpApprovalOwner,
    response: ResumeResponse,
    incoming?: IncomingTraceHeaders,
  ): Promise<McpSessionResumeApprovalResult> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* self.prepareErrorCaptureScope();
        const owner = yield* self.validateApprovalIdentity(identity);
        if (owner !== "ok") return { status: owner } as const;

        const restored = yield* self.ensureRuntimeForApproval();
        if (!restored || !self.engine) return { status: "not_found" } as const;

        const paused = yield* self.engine.getPausedExecution(executionId);
        if (!paused) return { status: "not_found" } as const;

        yield* self.recordApprovalResponse(executionId, response);
        return resumeApprovalResult(executionId, response);
      }).pipe(
        Effect.withSpan("McpSessionDO.resumeExecutionForApproval", {
          attributes: { "mcp.execution.id": executionId },
        }),
        (eff) => this.withTelemetry(eff, incoming),
        // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: DO RPC exposes Promise results
        Effect.orDie,
        (eff) => self.withSpanFlush(eff),
      ),
    );
  }

  override async destroy(): Promise<void> {
    await this.cleanup();
    await super.destroy();
  }

  private async pausedExecutionCount(): Promise<number> {
    if (!this.engine) return 0;
    return Effect.runPromise(this.engine.pausedExecutionCount());
  }

  override async alarm(): Promise<void> {
    // Resolve the name FIRST, from every source, and hold onto it. Everything
    // below — the lease logs, the dispose log, `super.alarm()` — reads the
    // session id off that same answer, so an alarm this guard lets through can
    // no longer die on the next read of an id it just decided exists.
    if ((await this.resolveSessionName()) === undefined) {
      await this.cleanupUnaddressableSessionAlarm();
      return;
    }
    const lastActivityMs = await this.loadLastActivity();
    const idleMs = lastActivityMs > 0 ? Date.now() - lastActivityMs : 0;
    const pausedExecutionCount = await this.pausedExecutionCount();
    const runningExecutionCount = await this.runningExecutionCount();
    const activeStreamCount = this.activeStreamCount();
    const decision = decideSessionAlarm({
      idleMs,
      pausedExecutionCount,
      runningExecutionCount,
      activeStreamCount,
      sessionTimeoutMs: this.sessionTimeoutMs(),
      maxPausedSessionIdleMs: this.maxPausedSessionIdleMs(),
    });

    if (decision.kind === "idle_within_timeout") {
      await super.alarm();
      return;
    }

    if (decision.kind === "extend_paused_lease") {
      console.info(
        JSON.stringify(
          pausedLeaseExtensionLog({
            sessionId: this.sessionIdForTelemetry(),
            pausedExecutionCount,
            idleMs,
            leaseMs: decision.leaseMs,
          }),
        ),
      );
      await this.ctx.storage.setAlarm(Date.now() + decision.leaseMs);
      return;
    }

    if (decision.kind === "extend_running_lease") {
      console.info(
        JSON.stringify(
          runningLeaseExtensionLog({
            sessionId: this.sessionIdForTelemetry(),
            runningExecutionCount,
            activeStreamCount,
            idleMs,
            leaseMs: decision.leaseMs,
          }),
        ),
      );
      // Open streamable-HTTP bridges and persisted request ids represent work
      // that can still deliver or replay a response. Buggy dead pipes are
      // closed by the SSE writer's terminal failure path, so they stop
      // extending the lease once the bridge observes the failure.
      await this.ctx.storage.setAlarm(Date.now() + decision.leaseMs);
      return;
    }

    await this.disposeIdleRuntime({
      idleMs,
      pausedExecutionCount,
      activeStreamCount,
      reason: "idle",
    });
  }

  private validateApprovalIdentity(
    identity: McpApprovalOwner,
  ): Effect.Effect<"ok" | "not_found" | "forbidden"> {
    const self = this;
    return Effect.gen(function* () {
      const sessionMeta = yield* self.loadSessionMeta();
      if (!sessionMeta) return "not_found" as const;
      return identity.accountId === sessionMeta.userId &&
        identity.organizationId === sessionMeta.organizationId
        ? ("ok" as const)
        : ("forbidden" as const);
    }).pipe(Effect.withSpan("mcp.session.validate_approval_identity"));
  }

  private approvalDeadline(now = Date.now()): PausedExecutionDeadline {
    return {
      ttlMs: PAUSED_APPROVAL_TIMEOUT_MS,
      expiresAt: new Date(now + PAUSED_APPROVAL_TIMEOUT_MS).toISOString(),
    };
  }

  private deadlineForExecution(
    executionId: string,
  ): Effect.Effect<PausedExecutionDeadline | undefined> {
    const directory = this.executionOwnerDirectory();
    const noDeadline = Effect.sync((): PausedExecutionDeadline | undefined => undefined);
    if (!directory) return noDeadline;
    return directory.get(executionId).pipe(
      Effect.map((record) =>
        record ? { expiresAt: record.expiresAt, ttlMs: record.ttlMs } : undefined,
      ),
      Effect.tapCause((cause) =>
        this.logExecutionOwnerDirectoryFailure({ operation: "get", executionId, cause }),
      ),
      Effect.catchCause(() => noDeadline),
    );
  }

  private writeExecutionOwnerEntry(
    executionId: string,
    deadline: PausedExecutionDeadline | undefined,
  ): Effect.Effect<void> {
    const directory = this.executionOwnerDirectory();
    if (!directory || !deadline) return Effect.void;
    const self = this;
    return Effect.gen(function* () {
      const sessionMeta = yield* self.loadSessionMeta();
      if (!sessionMeta) return;
      const record: McpExecutionOwnerRecord = {
        executionId,
        owner: self.executionOwnerRoute(),
        accountId: sessionMeta.userId,
        organizationId: sessionMeta.organizationId,
        expiresAt: deadline.expiresAt,
        ttlMs: deadline.ttlMs,
      };
      yield* directory
        .put(record)
        .pipe(
          Effect.tapCause((cause) =>
            self.logExecutionOwnerDirectoryFailure({ operation: "put", executionId, cause }),
          ),
        );
    }).pipe(Effect.ignore);
  }

  private deleteExecutionOwnerEntry(executionId: string): Effect.Effect<void> {
    const directory = this.executionOwnerDirectory();
    return (
      directory?.delete(executionId).pipe(
        Effect.tapCause((cause) =>
          this.logExecutionOwnerDirectoryFailure({ operation: "delete", executionId, cause }),
        ),
        Effect.ignore,
      ) ?? Effect.void
    );
  }

  private resumeEngineWithLifecycle(
    executionId: string,
    response: ResumeResponse,
  ): Effect.Effect<ExecutionResult | null, Cause.YieldableError> {
    const self = this;
    return Effect.gen(function* () {
      if (!self.engine) return null;
      yield* self.beginPendingApprovalResume(executionId);
      return yield* self.engine.resume(executionId, response);
    }).pipe(Effect.ensuring(self.finishPendingApprovalResume(executionId)));
  }

  private resumeFromExecutionOwnerDirectory(
    executionId: string,
    response: ResumeResponse,
  ): Effect.Effect<ResumeFallbackOutcome | null> {
    const directory = this.executionOwnerDirectory();
    if (!directory) return Effect.succeed(null);
    const self = this;
    return Effect.gen(function* () {
      const record = yield* directory.get(executionId).pipe(
        Effect.tapCause((cause) =>
          self.logExecutionOwnerDirectoryFailure({ operation: "get", executionId, cause }),
        ),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (!record) return null;

      const sessionMeta = yield* self.loadSessionMeta();
      if (!sessionMeta) return { status: "execution_forbidden" } as const;
      const identity: McpApprovalOwner = {
        accountId: sessionMeta.userId,
        organizationId: sessionMeta.organizationId,
      };
      if (
        identity.accountId !== record.accountId ||
        identity.organizationId !== record.organizationId
      ) {
        return { status: "execution_forbidden" } as const;
      }

      if (self.sameExecutionOwnerRoute(record.owner, self.executionOwnerRoute())) {
        yield* self.deleteExecutionOwnerEntry(executionId);
        return { status: "execution_expired", ttlMs: record.ttlMs } as const;
      }

      const forwarded = yield* self
        .forwardModelResumeToOwner(record.owner, identity, executionId, response)
        .pipe(
          Effect.timeoutOrElse({
            duration: `${MODEL_RESUME_FORWARD_TIMEOUT_MS} millis`,
            orElse: () =>
              Effect.gen(function* () {
                yield* self.logModelResumeForwardTimeout({
                  executionId,
                  owner: record.owner,
                  timeoutMs: MODEL_RESUME_FORWARD_TIMEOUT_MS,
                });
                return { status: "execution_expired" as const, ttlMs: record.ttlMs };
              }),
          }),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* self.logModelResumeForwardFailure({
                executionId,
                owner: record.owner,
                cause,
              });
              return { status: "execution_expired" as const, ttlMs: record.ttlMs };
            }),
          ),
        );
      if (
        forwarded.status === "execution_expired" ||
        forwarded.status === "execution_not_found" ||
        forwarded.status === "execution_already_settled"
      ) {
        yield* self.deleteExecutionOwnerEntry(executionId);
      }
      return forwarded.status === "execution_not_found"
        ? ({ status: "execution_expired", ttlMs: record.ttlMs } as const)
        : forwarded;
    });
  }

  private startPendingApprovalLease(
    executionId: string,
    deadline: PausedExecutionDeadline | undefined,
  ): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.prepareErrorCaptureScope();
      if (self.pendingApprovalLeases.has(executionId)) return;

      // keepAlive BEFORE markActivity: acquiring the first keepAlive ref runs
      // the SDK's _scheduleNextAlarm, which re-arms the DO alarm to its 30s
      // heartbeat and would overwrite the idle alarm markActivity sets. With
      // this ordering markActivity's setAlarm(now + sessionTimeoutMs) lands
      // last, so the idle/paused-expiry clock keeps ticking while the lease
      // holds the runtime alive. (Round 1 removed onConnect's drain-wait,
      // which used to hold a ref across the pause and mask this by keeping
      // the ref transition away from 0->1.)
      const disposeKeepAlive = yield* Effect.promise(() => self.keepAlive());
      yield* self
        .bestEffortBookkeeping("approval_lease.mark_activity", () => self.markActivity())
        .pipe(Effect.withSpan("McpSessionDO.markActivity"));
      const timeout = setTimeout(() => {
        self.queuePendingApprovalLeaseExpiration(executionId);
      }, PAUSED_APPROVAL_TIMEOUT_MS);
      self.pendingApprovalLeases.set(executionId, { disposeKeepAlive, timeout, expiring: false });
      yield* self.writeExecutionOwnerEntry(executionId, deadline);
    }).pipe(
      Effect.withSpan("McpSessionDO.pending_approval_lease.start", {
        attributes: { "mcp.execution.id": executionId },
      }),
      Effect.tapCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            console.error(
              "[mcp-session] pending approval lease start failed:",
              Cause.pretty(cause),
            );
          });
          yield* self.captureCauseEffect(cause);
        }),
      ),
      Effect.ignore,
    );
  }

  private queuePendingApprovalLeaseStart(
    executionId: string,
    deadline: PausedExecutionDeadline | undefined,
  ): void {
    this.ctx.waitUntil(Effect.runPromise(this.startPendingApprovalLease(executionId, deadline)));
  }

  private queuePendingApprovalLeaseExpiration(executionId: string): void {
    const self = this;
    this.ctx.waitUntil(
      Effect.runPromise(
        this.expirePendingApproval(executionId).pipe(
          Effect.tapCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                console.error(
                  "[mcp-session] pending approval lease expiration failed:",
                  Cause.pretty(cause),
                );
              });
              yield* self.captureCauseEffect(cause);
            }),
          ),
          Effect.ignore,
        ),
      ),
    );
  }

  private beginPendingApprovalResume(executionId: string): Effect.Effect<void> {
    return Effect.sync(() => {
      const lease = this.pendingApprovalLeases.get(executionId);
      if (!lease || lease.expiring) return;
      if (lease.timeout) clearTimeout(lease.timeout);
      lease.timeout = null;
    }).pipe(
      Effect.withSpan("McpSessionDO.pending_approval_lease.begin_resume", {
        attributes: { "mcp.execution.id": executionId },
      }),
    );
  }

  private finishPendingApprovalResume(executionId: string): Effect.Effect<void> {
    return this.releasePendingApprovalLease(executionId).pipe(
      Effect.withSpan("McpSessionDO.pending_approval_lease.finish", {
        attributes: { "mcp.execution.id": executionId },
      }),
    );
  }

  private releasePendingApprovalLease(executionId: string): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const lease = self.pendingApprovalLeases.get(executionId);
      if (!lease) return;
      if (lease.timeout) clearTimeout(lease.timeout);
      self.pendingApprovalLeases.delete(executionId);
      lease.disposeKeepAlive();
      yield* self.deleteExecutionOwnerEntry(executionId);
    });
  }

  private releaseAllPendingApprovalLeases(): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const executionIds = Array.from(self.pendingApprovalLeases.keys());
      yield* Effect.sync(() => {
        for (const executionId of executionIds) {
          const lease = self.pendingApprovalLeases.get(executionId);
          if (!lease) continue;
          if (lease.timeout) clearTimeout(lease.timeout);
          lease.disposeKeepAlive();
        }
        self.pendingApprovalLeases.clear();
      });
      for (const executionId of executionIds) {
        yield* self.deleteExecutionOwnerEntry(executionId);
      }
    });
  }

  private recordApprovalResponse(
    executionId: string,
    response: ResumeResponse,
  ): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      self.approvalResponses.set(executionId, response);
      yield* Effect.promise(() => self.ctx.storage.put(approvalResponseKey(executionId), response));
      const waiter = self.approvalWaiters.get(executionId);
      if (waiter) yield* Deferred.succeed(waiter, response);
    });
  }

  private expirePendingApproval(executionId: string): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.prepareErrorCaptureScope();
      const lease = self.pendingApprovalLeases.get(executionId);
      if (!lease || lease.expiring) return;
      lease.expiring = true;
      if (lease.timeout) clearTimeout(lease.timeout);
      lease.timeout = null;
      if (self.approvalResponses.has(executionId)) return;

      const response = {
        action: "decline",
        content: { reason: "approval_timeout" },
      } satisfies ResumeResponse;
      yield* Effect.sync(() => {
        console.info(JSON.stringify({ event: "mcp_pending_approval_lease_expire", executionId }));
      });
      yield* self.recordApprovalResponse(executionId, response);
      if (self.engine && !self.approvalWaiters.has(executionId)) {
        yield* self.engine.resume(executionId, response).pipe(Effect.ignore);
      }
    }).pipe(
      Effect.ensuring(self.releasePendingApprovalLease(executionId)),
      Effect.withSpan("McpSessionDO.pending_approval_lease.expire", {
        attributes: { "mcp.execution.id": executionId },
      }),
    );
  }

  private takeApprovalResponse(executionId: string): Effect.Effect<ResumeResponse | null> {
    const self = this;
    return Effect.promise(async () => {
      const memoryResponse = self.approvalResponses.get(executionId);
      if (memoryResponse) {
        self.approvalResponses.delete(executionId);
        await self.ctx.storage.delete(approvalResponseKey(executionId));
        return memoryResponse;
      }
      const stored = await self.ctx.storage.get<ResumeResponse>(approvalResponseKey(executionId));
      if (!stored) return null;
      await self.ctx.storage.delete(approvalResponseKey(executionId));
      return stored;
    });
  }

  private waitForApprovalResponse(executionId: string): Effect.Effect<ResumeResponse | null> {
    const self = this;
    return Effect.gen(function* () {
      const existing = yield* self.takeApprovalResponse(executionId);
      if (existing) return existing;

      const waiter =
        self.approvalWaiters.get(executionId) ?? (yield* Deferred.make<ResumeResponse>());
      self.approvalWaiters.set(executionId, waiter);
      yield* Deferred.await(waiter).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (self.approvalWaiters.get(executionId) === waiter) {
              self.approvalWaiters.delete(executionId);
            }
          }),
        ),
      );
      return yield* self.takeApprovalResponse(executionId);
    });
  }

  private async cleanup(): Promise<void> {
    await Effect.runPromise(this.closeRuntime());
  }
}

/**
 * Install the idle-deadline repair described on
 * {@link McpAgentSessionDOBase.ensureIdleAlarmArmed}.
 *
 * At runtime this is an ordinary method override — the agents SDK calls
 * `this._scheduleNextAlarm()` and gets this one. It cannot be written in the
 * class body because the SDK declares that member `private`, and TypeScript
 * refuses to let a subclass redeclare a private base member at all. So it is
 * installed on the prototype, which is the same thing to the runtime and the
 * only form the compiler accepts.
 */
type BoundAsyncMethod = (this: object) => Promise<void>;

{
  // Read off the INHERITED prototype, so this captures the SDK's own
  // implementation rather than the wrapper being installed just below.
  const inherited: object = Object.getPrototypeOf(McpAgentSessionDOBase.prototype);
  const scheduleNextAlarm = Reflect.get(inherited, "_scheduleNextAlarm") as
    | BoundAsyncMethod
    | undefined;
  if (scheduleNextAlarm) {
    Reflect.set(
      McpAgentSessionDOBase.prototype,
      "_scheduleNextAlarm",
      async function (this: object): Promise<void> {
        await scheduleNextAlarm.call(this);
        const ensureIdleAlarmArmed = Reflect.get(this, "ensureIdleAlarmArmed") as BoundAsyncMethod;
        await ensureIdleAlarmArmed.call(this);
      },
    );
  }
}
