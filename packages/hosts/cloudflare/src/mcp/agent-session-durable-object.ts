import { DurableObject } from "cloudflare:workers";
import { Cause, Data, Deferred, Effect, Option, Schema } from "effect";
import type * as Tracer from "effect/Tracer";
import {
  createMcpHandler,
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  type JSONRPCMessage,
  type McpServer,
  type MessageExtraInfo,
  type McpHttpHandler,
  type McpRequestContext,
  type RequestId,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";

import { RequestOrgSlug, RequestWebOrigin } from "@executor-js/api/server";
import {
  formatPausedExecution,
  type ExecutionEngine,
  type ExecutionResult,
  type PausedExecutionDeadline,
  type ResumeResponse,
} from "@executor-js/execution";
import {
  appsEnabledForClientCapabilities,
  clientCapabilitiesFromRequestBody,
  clientInfoFromRequestBody,
  mcpRequestStateBindingFromBody,
  PAUSED_APPROVAL_TIMEOUT_MS,
  formatMcpExecutionOutcome,
  mcpRequestStatePrincipal,
  requestBodyFromRequest,
  type McpClientInfo,
  type PausedExecutionHooks,
  type ResumeFallbackOutcome,
} from "@executor-js/host-mcp/tool-server";
import {
  defaultMcpResource,
  jsonRpcErrorBody,
  mcpResourceKey,
  type McpResource,
} from "@executor-js/host-mcp";
import {
  readArtifactsEnabled,
  readElicitationMode,
  verifiedMcpRequestHeaders,
  type IncomingPropagationHeaders,
  type McpElicitationMode,
} from "./do-headers";
import {
  modernMcpExecutionOwnerRoute,
  type McpExecutionOwnerDirectory,
  type McpExecutionOwnerRecord,
  type McpExecutionOwnerRoute,
} from "./execution-owner-directory";
import {
  MAX_PAUSED_SESSION_IDLE_MS,
  SESSION_TIMEOUT_MS,
  decideSessionAlarm,
  pausedLeaseExtensionLog,
  runningLeaseExtensionLog,
} from "./session-alarm-policy";
import { DurableObjectMcpEventStore } from "./do-event-store";
import { rotateSseResponse } from "./sse-response-rotation";

export type IncomingTraceHeaders = IncomingPropagationHeaders;

export interface McpSessionInit {
  readonly organizationId: string;
  readonly userId: string;
  readonly elicitationMode: McpElicitationMode;
  /** Whether this session serves artifacts, read off `?artifacts=` at connect
   *  time. Absent means the default (enabled). */
  readonly artifactsEnabled?: boolean;
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
  /**
   * The client identity (`clientInfo`) self-reported at `initialize` or in a
   * modern request's `_meta`. Persisted for the same reason as
   * {@link appsEnabled}: a cold-restored server never sees an `initialize`,
   * and without this the execution spans' `mcp.client.*` attribution vanishes
   * mid-conversation. Telemetry/display only, never behavior.
   */
  readonly clientInfo?: McpClientInfo;
  /** Creation time of this session, retained across isolate eviction. */
  readonly createdAtMs?: number;
}

export interface BuiltMcpServer {
  readonly mcpServer: McpServer;
  readonly engine: ExecutionEngine<Cause.YieldableError>;
  /** Modern per-request server factory sharing this legacy runtime's engine. */
  readonly modernRuntime?: BuiltModernMcpRuntime;
}

/** Request-specific inputs added to a DO-local MCP server. */
export interface ModernMcpServerRequestOptions {
  readonly appsEnabled: boolean;
  readonly requestStateSigningKey: Uint8Array | string;
  readonly requestStatePrincipal: string;
  readonly requestStateBinding?: string;
  /** Client identity for span attribution: this request's `_meta`, else the session's persisted copy. */
  readonly restoredClientInfo?: McpClientInfo;
}

/** Long-lived DO execution runtime shared by per-request MCP servers. */
export interface BuiltModernMcpRuntime {
  readonly engine: ExecutionEngine<Cause.YieldableError>;
  readonly buildServer: (
    options: ModernMcpServerRequestOptions,
  ) => Effect.Effect<McpServer, Cause.YieldableError>;
}

export interface BrowserApprovalStore {
  readonly takeResponse: (executionId: string) => Effect.Effect<ResumeResponse | null>;
  readonly waitForResponse: (executionId: string) => Effect.Effect<ResumeResponse | null>;
}

type ModernRuntimeAccess =
  | { readonly status: "ok"; readonly runtime: BuiltModernMcpRuntime }
  | { readonly status: "forbidden" };

class ModernMcpRuntimeNotConfigured extends Data.TaggedError("ModernMcpRuntimeNotConfigured") {}

const LEGACY_AGENT_SESSION_META_KEY = "executor:mcp:v2:session-meta";
const LEGACY_AGENT_LAST_ACTIVITY_KEY = "executor:mcp:v2:last-activity-ms";
const MODERN_SESSION_META_KEY = "session-meta";
const MODERN_LAST_ACTIVITY_KEY = "last-activity-ms";
const MODERN_SESSION_KEY = "modern-session";
const DESTROY_PENDING_KEY = "executor:mcp:v2:destroy-pending";
const DESTROY_ALARM_DELAY_MS = 1_000;
const MODEL_RESUME_FORWARD_TIMEOUT_MS = 10_000;
const LEGACY_PRIMING_PROTOCOL_VERSION = "2025-11-25";
const approvalResponseKey = (executionId: string) => `approval-response:${executionId}`;

type JsonRpcRequestId = string | number;
const JsonRpcRequestWithId = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.String,
});
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

const jsonRpcMessages = (parsedBody: unknown): ReadonlyArray<unknown> =>
  Array.isArray(parsedBody) ? parsedBody : [parsedBody];

const isInitializeBody = (parsedBody: unknown): boolean =>
  jsonRpcMessages(parsedBody).some((message) => {
    const decoded = decodeJsonRpcRequestWithId(message);
    return Option.isSome(decoded) && decoded.value.method === "initialize";
  });

const legacyToolCallRequestIds = (parsedBody: unknown): readonly JsonRpcRequestId[] => {
  const requestIds: JsonRpcRequestId[] = [];
  for (const message of jsonRpcMessages(parsedBody)) {
    const decoded = decodeJsonRpcRequestWithId(message);
    if (Option.isSome(decoded) && decoded.value.method === "tools/call") {
      requestIds.push(decoded.value.id);
    }
  }
  return requestIds;
};

const LEGACY_PRIMING_MESSAGE = {
  jsonrpc: "2.0",
  method: "notifications/message",
  params: { level: "debug", data: "mcp-stream-priming" },
} satisfies JSONRPCMessage;

const legacyPrimingFrame = (eventId: string): Uint8Array =>
  new TextEncoder().encode(
    `event: mcp-priming\nid: ${eventId}\ndata: ${JSON.stringify(LEGACY_PRIMING_MESSAGE)}\n\n`,
  );

const replayFrame = (eventId: string, message: JSONRPCMessage): Uint8Array =>
  new TextEncoder().encode(`event: message\nid: ${eventId}\ndata: ${JSON.stringify(message)}\n\n`);

const combineFrames = (frames: readonly Uint8Array[]): ArrayBuffer => {
  const byteLength = frames.reduce((total, frame) => total + frame.byteLength, 0);
  const buffer = new ArrayBuffer(byteLength);
  const combined = new Uint8Array(buffer);
  let offset = 0;
  for (const frame of frames) {
    combined.set(frame, offset);
    offset += frame.byteLength;
  }
  return buffer;
};

const mcpResourceFromKey = (resourceKey: string): McpResource =>
  resourceKey.startsWith("toolkit:") && resourceKey.length > "toolkit:".length
    ? { kind: "toolkit", slug: resourceKey.slice("toolkit:".length) }
    : defaultMcpResource;

type RuntimeKind = "legacy" | "modern";

type QueuedTransportMessage = {
  readonly message: JSONRPCMessage;
  readonly extra?: MessageExtraInfo;
};

export abstract class McpAgentSessionDOBase<
  Env extends Cloudflare.Env = Cloudflare.Env,
  TDbHandle extends SessionDbHandle = SessionDbHandle,
> extends DurableObject<Env> {
  server?: McpServer;
  private transport: WebStandardStreamableHTTPServerTransport | null = null;
  private readonly eventStore: DurableObjectMcpEventStore;
  private engine: ExecutionEngine<Cause.YieldableError> | null = null;
  private dbHandle: TDbHandle | null = null;
  private sessionMeta: SessionMeta | null = null;
  private modernRuntime: BuiltModernMcpRuntime | null = null;
  private modernRuntimePromise: Promise<ModernRuntimeAccess> | null = null;
  private modernHandler: McpHttpHandler | null = null;
  private modernRunningRequestCount = 0;
  private modernRequestBodies = new WeakMap<Request, unknown>();
  private modernRequestPropagation = new WeakMap<Request, IncomingTraceHeaders | undefined>();
  private legacyRunningRequestCount = 0;
  private activeLegacyStreamCount = 0;
  private keepAliveCount = 0;
  private transportRequestTail = Promise.resolve();
  private runtimeKind: RuntimeKind | null = null;
  private initialized = false;
  private onStartPromise: Promise<void> | null = null;
  private lastActivityMs = 0;
  private approvalResponses = new Map<string, ResumeResponse>();
  private approvalWaiters = new Map<string, Deferred.Deferred<ResumeResponse>>();
  private pendingApprovalLeases = new Map<string, PendingApprovalLease>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.eventStore = new DurableObjectMcpEventStore(ctx.storage);
  }

  protected abstract openSessionDb(): TDbHandle | Promise<TDbHandle>;

  protected abstract resolveSessionMeta(token: McpSessionInit): Effect.Effect<SessionMeta>;

  protected abstract buildMcpServer(
    sessionMeta: SessionMeta,
    dbHandle: TDbHandle,
  ): Effect.Effect<BuiltMcpServer>;

  /** Build the engine and per-request MCP server factory for a modern-only DO. */
  protected buildModernMcpRuntime(
    _sessionMeta: SessionMeta,
    _dbHandle: TDbHandle,
  ): Effect.Effect<BuiltModernMcpRuntime, Cause.YieldableError> {
    return Effect.fail(new ModernMcpRuntimeNotConfigured());
  }

  /** Read and validate the deployment-provided modern request-state signing key. */
  protected modernRequestStateSigningKey(): string {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- composition boundary: subclasses serving modern MCP must provide a shared deployment key
    throw new Error("Modern MCP request-state signing is not configured");
  }

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

  protected flushTelemetry(): Promise<void> {
    return Promise.resolve();
  }

  protected get sessionId(): string {
    return this.ctx.id.toString();
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

  private modernExecutionOwnerRoute(): McpExecutionOwnerRoute {
    return this.runtimeKind === "legacy" || this.ctx.id.name
      ? this.executionOwnerRoute()
      : modernMcpExecutionOwnerRoute(this.ctx.id.toString());
  }

  private runtimeOwnerId(): string {
    return this.runtimeKind === "modern"
      ? this.modernExecutionOwnerRoute().sessionId
      : this.sessionId;
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

  protected readonly modernModelResumeFallback = (
    executionId: string,
    response: ResumeResponse,
  ): Effect.Effect<ResumeFallbackOutcome | null> =>
    this.resumeFromExecutionOwnerDirectory(executionId, response, this.modernExecutionOwnerRoute());

  protected readonly pausedExecutionHooks: PausedExecutionHooks = {
    onExecutionPaused: (executionId, deadline) =>
      Effect.sync(() => {
        this.queuePendingApprovalLeaseStart(executionId, deadline);
      }),
    onResumeStarted: (executionId) => this.beginPendingApprovalResume(executionId),
    onResumeSettled: (executionId) => this.finishPendingApprovalResume(executionId),
  };

  /**
   * Modern pause hooks await the directory write before the `input_required`
   * result leaves the DO, so its signed continuation is immediately routable.
   */
  protected readonly modernPausedExecutionHooks: PausedExecutionHooks = {
    onExecutionPaused: (executionId, deadline) =>
      this.startPendingApprovalLease(executionId, deadline, this.modernExecutionOwnerRoute()),
    onResumeStarted: (executionId) => this.beginPendingApprovalResume(executionId),
    onResumeSettled: (executionId) => this.finishPendingApprovalResume(executionId),
  };

  private openSessionDbHandle(): Effect.Effect<TDbHandle> {
    return Effect.promise(() => Promise.resolve(this.openSessionDb()));
  }

  private loadSessionMeta(): Effect.Effect<SessionMeta | null> {
    return Effect.promise(async () => {
      if (this.sessionMeta) return this.sessionMeta;

      const legacy = await this.ctx.storage.get<SessionMeta>(LEGACY_AGENT_SESSION_META_KEY);
      if (legacy) {
        this.runtimeKind = "legacy";
        this.sessionMeta = { ...legacy, resource: legacy.resource ?? defaultMcpResource };
        return this.sessionMeta;
      }

      const isModern =
        this.runtimeKind === "modern" ||
        (await this.ctx.storage.get<boolean>(MODERN_SESSION_KEY)) === true;
      if (!isModern) return null;
      this.runtimeKind = "modern";
      const stored = await this.ctx.storage.get<SessionMeta>(MODERN_SESSION_META_KEY);
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
    const key =
      this.runtimeKind === "modern" ? MODERN_SESSION_META_KEY : LEGACY_AGENT_SESSION_META_KEY;
    await this.ctx.storage.put(key, sessionMeta);
  }

  /**
   * Persist the MCP-Apps support negotiated at `initialize`, so a later cold
   * restore can rebuild the server with it. Subclasses hand this to
   * `buildMcpServer` as `onAppsEnabledChange`.
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

  /**
   * Persist the client identity self-reported at `initialize` (or in a modern
   * request's `_meta`), so a cold restore keeps span attribution. Subclasses
   * hand this to `buildMcpServer` as `onClientInfoChange`; the modern request
   * path calls it directly. Same no-op-before-meta contract as
   * {@link persistAppsEnabled}.
   */
  protected persistClientInfo(clientInfo: McpClientInfo): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const stored = yield* self.loadSessionMeta();
      if (
        !stored ||
        (stored.clientInfo?.name === clientInfo.name &&
          stored.clientInfo?.version === clientInfo.version &&
          stored.clientInfo?.title === clientInfo.title)
      ) {
        return;
      }
      yield* Effect.promise(() => self.saveSessionMeta({ ...stored, clientInfo }));
    }).pipe(
      Effect.withSpan("mcp.session.persist_client_info", {
        attributes: { "mcp.client.name": clientInfo.name },
      }),
      Effect.ignoreCause({ log: false }),
    );
  }

  private async markActivity(now = Date.now()): Promise<void> {
    this.lastActivityMs = now;
    const key =
      this.runtimeKind === "modern" ? MODERN_LAST_ACTIVITY_KEY : LEGACY_AGENT_LAST_ACTIVITY_KEY;
    await Promise.all([
      this.ctx.storage.put(key, now),
      this.ctx.storage.setAlarm(now + this.sessionTimeoutMs()),
    ]);
  }

  private async loadLastActivity(): Promise<number> {
    if (this.lastActivityMs > 0) return this.lastActivityMs;
    const key =
      this.runtimeKind === "modern" ? MODERN_LAST_ACTIVITY_KEY : LEGACY_AGENT_LAST_ACTIVITY_KEY;
    const stored = await this.ctx.storage.get<number>(key);
    this.lastActivityMs = stored ?? 0;
    return this.lastActivityMs;
  }

  /** Hold the in-memory approval runtime until the matching pause settles. */
  protected keepAlive(): Promise<() => void> {
    this.keepAliveCount += 1;
    let disposed = false;
    return Promise.resolve(() => {
      if (disposed) return;
      disposed = true;
      this.keepAliveCount = Math.max(0, this.keepAliveCount - 1);
    });
  }

  private activeStreamCount(): number {
    return this.activeLegacyStreamCount;
  }

  private runningExecutionCount(): number {
    return this.legacyRunningRequestCount + this.modernRunningRequestCount;
  }

  private async cleanupUnaddressableSessionAlarm(): Promise<void> {
    await Effect.runPromise(this.closeRuntime());
    await Effect.runPromise(
      Effect.all([
        Effect.ignore(Effect.tryPromise(() => this.ctx.storage.deleteAlarm())),
        Effect.ignore(
          Effect.tryPromise(() =>
            this.ctx.storage.delete([LEGACY_AGENT_LAST_ACTIVITY_KEY, MODERN_LAST_ACTIVITY_KEY]),
          ),
        ),
      ]),
    );
  }

  private async disposeIdleRuntime(input: {
    readonly idleMs: number;
    readonly lastActivityMs: number;
    readonly pausedExecutionCount: number;
  }): Promise<void> {
    console.info(
      JSON.stringify({
        event: "mcp_session_idle_runtime_dispose",
        sessionId: this.runtimeOwnerId(),
        idleMs: input.idleMs,
        pausedExecutionCount: input.pausedExecutionCount,
      }),
    );
    await Effect.runPromise(this.closeRuntime());
    const activityKey =
      this.runtimeKind === "modern" ? MODERN_LAST_ACTIVITY_KEY : LEGACY_AGENT_LAST_ACTIVITY_KEY;
    const cleared = await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<number>(activityKey);
      if (current !== input.lastActivityMs) return false;
      await transaction.delete([LEGACY_AGENT_LAST_ACTIVITY_KEY, MODERN_LAST_ACTIVITY_KEY]);
      await transaction.deleteAlarm();
      return true;
    });
    if (cleared) this.lastActivityMs = 0;
  }

  private resolveAndStoreSessionMeta(token: McpSessionInit) {
    const self = this;
    return Effect.gen(function* () {
      const resolved = yield* self.resolveSessionMeta(token);
      // `init` runs again on every cold restore, and `resolveSessionMeta`
      // rebuilds meta from the bearer token — which carries no negotiated
      // capabilities. Carry the stored value forward, or restoring the session
      // would erase the very bit that survives the restore.
      const stored = yield* self.loadSessionMeta();
      const sessionMeta: SessionMeta = {
        ...resolved,
        ...(token.webOrigin ? { webOrigin: token.webOrigin } : {}),
        appsEnabled: stored?.appsEnabled ?? false,
        ...(stored?.clientInfo ? { clientInfo: stored.clientInfo } : {}),
        createdAtMs: stored?.createdAtMs ?? Date.now(),
      };
      yield* Effect.promise(() => self.saveSessionMeta(sessionMeta)).pipe(
        Effect.withSpan("mcp.session.save_meta"),
      );
      return sessionMeta;
    }).pipe(Effect.withSpan("mcp.session.resolve_and_store_meta"));
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
          sessionId: self.runtimeOwnerId(),
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
          sessionId: self.runtimeOwnerId(),
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
          sessionId: self.runtimeOwnerId(),
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

  private buildModernRuntime(sessionMeta: SessionMeta, dbHandle: TDbHandle) {
    const built = sessionMeta.organizationSlug
      ? this.buildModernMcpRuntime(sessionMeta, dbHandle).pipe(
          Effect.provideService(RequestOrgSlug, { slug: sessionMeta.organizationSlug }),
        )
      : this.buildModernMcpRuntime(sessionMeta, dbHandle);
    return sessionMeta.webOrigin
      ? built.pipe(Effect.provideService(RequestWebOrigin, { origin: sessionMeta.webOrigin }))
      : built;
  }

  private modernPropsOwnSession(sessionMeta: SessionMeta, props: McpSessionProps): boolean {
    return (
      props.session.userId === sessionMeta.userId &&
      props.session.organizationId === sessionMeta.organizationId &&
      mcpResourceKey(props.session.resource) === mcpResourceKey(sessionMeta.resource)
    );
  }

  private startModernRuntime(props: McpSessionProps): Promise<ModernRuntimeAccess> {
    if (this.modernRuntimePromise) return this.modernRuntimePromise;

    const self = this;
    const program = Effect.gen(function* () {
      yield* self.prepareErrorCaptureScope();
      const stored = yield* self.loadSessionMeta();
      if (stored && !self.modernPropsOwnSession(stored, props)) {
        return { status: "forbidden" as const };
      }
      if (!stored) self.runtimeKind = "modern";
      const sessionMeta = stored ?? (yield* self.resolveAndStoreSessionMeta(props.session));
      if (self.runtimeKind === "legacy" && (!self.modernRuntime || !self.engine)) {
        yield* self.initializeLegacyRuntime(props, sessionMeta);
      }
      if (self.modernRuntime && self.engine) {
        yield* Effect.promise(() => self.markActivity());
        return { status: "ok" as const, runtime: self.modernRuntime };
      }

      const dbHandle = self.dbHandle ?? (yield* self.openSessionDbHandle());
      self.dbHandle = dbHandle;
      const runtime = yield* self.buildModernRuntime(sessionMeta, dbHandle);
      self.modernRuntime = runtime;
      self.engine = runtime.engine;
      yield* Effect.promise(() =>
        self.runtimeKind === "modern"
          ? Promise.all([self.ctx.storage.put(MODERN_SESSION_KEY, true), self.markActivity()]).then(
              () => undefined,
            )
          : self.markActivity(),
      );
      return { status: "ok" as const, runtime };
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.gen(function* () {
          console.error("[mcp-session] modern runtime init failed:", Cause.pretty(cause));
          yield* self.captureCauseEffect(cause);
          yield* self.recordCauseOnSpan(cause);
          yield* self.closeRuntime();
        }),
      ),
      Effect.withSpan("McpSessionDO.startModernRuntime", {
        attributes: { "mcp.auth.organization_id": props.session.organizationId },
      }),
      (effect) => self.withTelemetry(effect, props.propagation),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: Durable Object RPC methods can only reject their Promise
      Effect.orDie,
      (effect) => self.withSpanFlush(effect),
    );

    const starting = Effect.runPromise(program);
    this.modernRuntimePromise = starting;
    starting.then(
      () => {
        if (this.modernRuntimePromise === starting) this.modernRuntimePromise = null;
      },
      () => {
        if (this.modernRuntimePromise === starting) this.modernRuntimePromise = null;
      },
    );
    return starting;
  }

  private modernHandlerForRuntime(): McpHttpHandler {
    if (this.modernHandler) return this.modernHandler;
    const self = this;
    this.modernHandler = createMcpHandler(
      (context: McpRequestContext) => {
        const request = context.requestInfo;
        const runtime = self.modernRuntime;
        const sessionMeta = self.sessionMeta;
        if (!request || !runtime || !sessionMeta || !self.modernRequestBodies.has(request)) {
          // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: the third-party factory Promise has no typed failure channel; absent DO request context is an SDK defect
          return Effect.runPromise(Effect.die("Modern MCP Durable Object has no request runtime"));
        }
        const parsedBody = self.modernRequestBodies.get(request);
        const propagation = self.modernRequestPropagation.get(request);
        const capabilities = clientCapabilitiesFromRequestBody(parsedBody);
        const clientInfo = clientInfoFromRequestBody(parsedBody) ?? sessionMeta.clientInfo;
        return Effect.runPromise(
          Effect.gen(function* () {
            const requestStatePrincipal = mcpRequestStatePrincipal({
              accountId: sessionMeta.userId,
              organizationId: sessionMeta.organizationId,
            });
            const requestStateBinding = yield* Effect.promise(() =>
              mcpRequestStateBindingFromBody({
                body: parsedBody,
                principal: requestStatePrincipal,
                resource: sessionMeta.resource,
              }),
            );
            return yield* runtime.buildServer({
              appsEnabled: appsEnabledForClientCapabilities(capabilities),
              requestStateSigningKey: self.modernRequestStateSigningKey(),
              requestStatePrincipal,
              ...(requestStateBinding === null ? {} : { requestStateBinding }),
              ...(clientInfo === undefined ? {} : { restoredClientInfo: clientInfo }),
            });
          }).pipe(
            (effect) => self.withTelemetry(effect, propagation),
            // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: the third-party factory Promise can only reject
            Effect.orDie,
          ),
        );
      },
      { legacy: "reject" },
    );
    return this.modernHandler;
  }

  private closeRuntime(): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      // Detach the complete generation before awaiting cleanup. A request that
      // interleaves with a slow server/DB close must build a fresh generation,
      // never observe initialized=true with a closing/null transport, and the
      // old cleanup must never clear fields belonging to that fresh runtime.
      const transport = self.transport;
      const server = self.server;
      const modernHandler = self.modernHandler;
      const dbHandle = self.dbHandle;
      self.transport = null;
      delete (self as { server?: McpServer }).server;
      self.modernHandler = null;
      self.dbHandle = null;
      self.engine = null;
      self.modernRuntime = null;
      self.activeLegacyStreamCount = 0;
      self.legacyRunningRequestCount = 0;
      self.modernRequestBodies = new WeakMap<Request, unknown>();
      self.modernRequestPropagation = new WeakMap<Request, IncomingTraceHeaders | undefined>();
      self.initialized = false;

      yield* self.releaseAllPendingApprovalLeases();
      if (transport) {
        yield* Effect.promise(() => transport.close()).pipe(Effect.ignore);
      }
      if (server) {
        yield* Effect.promise(() => server.close()).pipe(Effect.ignore);
      }
      if (modernHandler) {
        yield* Effect.promise(() => modernHandler.close()).pipe(Effect.ignore);
      }
      if (dbHandle) {
        yield* Effect.promise(() => Promise.resolve(dbHandle.end())).pipe(Effect.ignore);
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

  private propsFromSessionMeta(
    sessionMeta: SessionMeta,
    propagation?: IncomingTraceHeaders,
  ): McpSessionProps {
    return {
      session: {
        organizationId: sessionMeta.organizationId,
        userId: sessionMeta.userId,
        elicitationMode: sessionMeta.elicitationMode ?? "model",
        artifactsEnabled: sessionMeta.artifactsEnabled,
        resource: sessionMeta.resource,
        webOrigin: sessionMeta.webOrigin,
      },
      propagation,
    };
  }

  private restoreTransportSession(transport: WebStandardStreamableHTTPServerTransport): void {
    transport.sessionId = this.sessionId;
    // SAFETY: the SDK exposes `sessionId` but not a public cold-restore setter.
    // The installed transport's only additional session-validation bit is the
    // runtime `_initialized` boolean. Restoring just those transport fields
    // intentionally leaves McpServer client capabilities absent, so the
    // sessionful assembly falls back to the persisted apps seed.
    Reflect.set(transport, "_initialized", true);
  }

  private makeLegacyTransport(restoring: boolean): WebStandardStreamableHTTPServerTransport {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => this.sessionId,
      enableJsonResponse: false,
      eventStore: this.eventStore,
      retryInterval: 1_000,
      onsessionclosed: () => this._cf_scheduleDestroy(),
    });
    transport.onerror = (error) => {
      console.error("[mcp-session] transport error:", error);
    };
    if (restoring) this.restoreTransportSession(transport);
    return transport;
  }

  private initializeLegacyRuntime(
    props: McpSessionProps,
    storedMeta: SessionMeta | null,
  ): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.prepareErrorCaptureScope();
      self.runtimeKind = "legacy";
      const sessionMeta = storedMeta ?? (yield* self.resolveAndStoreSessionMeta(props.session));
      const dbHandle = yield* self.openSessionDbHandle();
      const { mcpServer, engine, modernRuntime } = yield* self.buildRuntime(sessionMeta, dbHandle);
      const transport = self.makeLegacyTransport(storedMeta !== null);
      self.dbHandle = dbHandle;
      self.server = mcpServer;
      self.engine = engine;
      self.modernRuntime = modernRuntime ?? null;
      self.transport = transport;
      yield* Effect.promise(() => mcpServer.connect(transport));
      self.initialized = true;
      yield* Effect.promise(() => self.markActivity()).pipe(
        Effect.withSpan("McpSessionDO.markActivity"),
      );
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.gen(function* () {
          console.error("[mcp-session] legacy runtime init failed:", Cause.pretty(cause));
          yield* self.captureCauseEffect(cause);
          yield* self.recordCauseOnSpan(cause);
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* self.closeRuntime();
          return yield* Effect.failCause(cause);
        }),
      ),
      Effect.withSpan("McpSessionDO.initializeLegacyRuntime", {
        attributes: { "mcp.auth.organization_id": props.session.organizationId },
      }),
      (effect) => self.withTelemetry(effect, props.propagation),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: Durable Object entrypoints can only reject their Promise
      Effect.orDie,
      (effect) => self.withSpanFlush(effect),
    );
  }

  async onStart(props?: McpSessionProps): Promise<void> {
    if (this.initialized && this.engine) return;
    if (this.onStartPromise) return this.onStartPromise;

    const self = this;
    const starting = Effect.runPromise(
      Effect.gen(function* () {
        const stored = yield* self.loadSessionMeta();
        const resolvedProps = props ?? (stored ? self.propsFromSessionMeta(stored) : null);
        if (!resolvedProps) return;
        if (self.runtimeKind === "modern") {
          yield* Effect.promise(() => self.startModernRuntime(resolvedProps));
          return;
        }
        yield* self.initializeLegacyRuntime(resolvedProps, stored);
      }),
    );
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

  private requestStreamId(
    transport: WebStandardStreamableHTTPServerTransport,
    requestId: RequestId,
  ): string | null {
    // SAFETY: the SDK currently has no public hook exposing the per-POST stream
    // ID. The installed transport stores the exact request-id → stream-id map
    // used by replay. Reading it lets the legacy compatibility prime share the
    // same replay stream as the eventual result without changing SDK code.
    const mapping: unknown = Reflect.get(transport, "_requestToStreamMapping");
    if (!(mapping instanceof Map)) return null;
    const streamId: unknown = mapping.get(requestId);
    return typeof streamId === "string" ? streamId : null;
  }

  private async supersedeReplayStream(
    transport: WebStandardStreamableHTTPServerTransport,
    lastEventId: string,
  ): Promise<void> {
    const streamId = await this.eventStore.getStreamIdForEventId(lastEventId);
    if (!streamId) return;
    // SAFETY: the installed SDK exposes closeSSEStream(requestId), but not the
    // reverse request-id map needed to supersede a stale POST connection before
    // replay. This is the same pinned map used by requestStreamId above.
    const mapping: unknown = Reflect.get(transport, "_requestToStreamMapping");
    if (!(mapping instanceof Map)) return;
    for (const [requestId, mappedStreamId] of mapping) {
      if (
        mappedStreamId === streamId &&
        (typeof requestId === "string" || typeof requestId === "number")
      ) {
        transport.closeSSEStream(requestId);
        return;
      }
    }
  }

  private trackedLegacyResponse = (
    response: Response,
    options: { readonly initialFrame?: Uint8Array; readonly acknowledge?: readonly string[] } = {},
  ): Response =>
    rotateSseResponse(response, {
      ...(options.initialFrame ? { initialFrame: options.initialFrame } : {}),
      onOpen: () => {
        this.activeLegacyStreamCount += 1;
      },
      onClose: (reason) => {
        this.activeLegacyStreamCount = Math.max(0, this.activeLegacyStreamCount - 1);
        if (reason === "complete" && options.acknowledge && options.acknowledge.length > 0) {
          this.ctx.waitUntil(this.eventStore.acknowledgeUndeliveredStreams(options.acknowledge));
        }
      },
    });

  private async replayUndeliveredOnStandaloneGet(request: Request): Promise<Response | null> {
    if (request.method !== "GET" || request.headers.has("last-event-id")) return null;
    const frames: Uint8Array[] = [];
    const streamIds = await this.eventStore.replayUndeliveredStreams({
      send: (eventId, message) => {
        frames.push(replayFrame(eventId, message));
        return Promise.resolve();
      },
    });
    if (frames.length === 0) return null;
    return this.trackedLegacyResponse(
      new Response(combineFrames(frames), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "mcp-session-id": this.sessionId,
        },
      }),
      { acknowledge: streamIds },
    );
  }

  private async serializedTransportRequest<A>(run: () => Promise<A>): Promise<A> {
    const previous = this.transportRequestTail;
    let release = (): void => undefined;
    this.transportRequestTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- concurrency boundary: release the next DO transport request on both success and rejection
    try {
      return await run();
    } finally {
      release();
    }
  }

  private async handleLegacyTransportRequest(
    request: Request,
    parsedBody: unknown,
  ): Promise<Response> {
    return this.serializedTransportRequest(async () => {
      const transport = this.transport;
      if (!transport) {
        return jsonRpcErrorBody(404, -32001, "Session not found", { cors: false });
      }
      if (request.method === "GET") {
        const lastEventId = request.headers.get("last-event-id");
        if (lastEventId) {
          await this.supersedeReplayStream(transport, lastEventId);
        } else {
          // Latest-listener-wins. Client cancellation is not reliably relayed
          // through every workerd/Vite streaming hop, so explicitly retire a
          // stale standalone mapping before opening its replacement.
          transport.closeStandaloneSSEStream();
          const replay = await this.replayUndeliveredOnStandaloneGet(request);
          if (replay) return replay;
        }
      }
      const toolCallIds = legacyToolCallRequestIds(parsedBody);
      const protocolVersion =
        request.headers.get("mcp-protocol-version") ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION;
      const needsLegacyPrime =
        toolCallIds.length > 0 && protocolVersion < LEGACY_PRIMING_PROTOCOL_VERSION;
      if (!needsLegacyPrime) {
        const response = await transport.handleRequest(request);
        const streamId = toolCallIds[0] ? this.requestStreamId(transport, toolCallIds[0]) : null;
        if (streamId) await this.eventStore.markStreamUndelivered(streamId);
        return this.trackedLegacyResponse(response);
      }

      const originalOnMessage = transport.onmessage;
      const queued: QueuedTransportMessage[] = [];
      transport.onmessage = (message, extra) => {
        queued.push(extra === undefined ? { message } : { message, extra });
      };
      let response: Response;
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- SDK adapter boundary: restore the connected server handler even when request parsing fails
      try {
        response = await transport.handleRequest(request);
      } finally {
        transport.onmessage = originalOnMessage;
      }

      const streamId = this.requestStreamId(transport, toolCallIds[0]!);
      const eventId = streamId
        ? await this.eventStore.storeEvent(streamId, LEGACY_PRIMING_MESSAGE)
        : null;
      if (streamId) await this.eventStore.markStreamUndelivered(streamId);
      const rotated = this.trackedLegacyResponse(response, {
        ...(eventId ? { initialFrame: legacyPrimingFrame(eventId) } : {}),
      });
      // ReadableStream.start enqueues the priming frame synchronously while
      // building `rotated`; only then may the server see the tools/call.
      for (const item of queued) originalOnMessage?.(item.message, item.extra);
      return rotated;
    });
  }

  private propsFromLegacyRequest(
    request: Request,
    verified: NonNullable<ReturnType<typeof verifiedMcpRequestHeaders>>,
  ): McpSessionProps {
    return {
      session: {
        organizationId: verified.organizationId,
        userId: verified.accountId,
        elicitationMode: readElicitationMode(request),
        artifactsEnabled: readArtifactsEnabled(request),
        resource: mcpResourceFromKey(verified.resourceKey),
        webOrigin: new URL(request.url).origin,
      },
      propagation: {
        traceparent: request.headers.get("traceparent") ?? undefined,
        tracestate: request.headers.get("tracestate") ?? undefined,
        baggage: request.headers.get("baggage") ?? undefined,
      },
    };
  }

  /** Serve one authenticated legacy MCP exchange directly from this DO. */
  override async fetch(request: Request): Promise<Response> {
    const verified = verifiedMcpRequestHeaders(request);
    if (!verified) {
      return jsonRpcErrorBody(403, -32003, "Invalid MCP Durable Object identity", {
        cors: false,
      });
    }
    if ((await this.ctx.storage.get<boolean>(DESTROY_PENDING_KEY)) === true) {
      return jsonRpcErrorBody(404, -32001, "Session timed out, please reconnect", {
        cors: false,
      });
    }

    const parsedBody = await Effect.runPromise(requestBodyFromRequest(request));
    const stored = await Effect.runPromise(this.loadSessionMeta());
    if (!stored) {
      if (!isInitializeBody(parsedBody)) {
        return request.headers.has("mcp-session-id")
          ? jsonRpcErrorBody(404, -32001, "Session not found", { cors: false })
          : jsonRpcErrorBody(400, -32000, "Bad Request: Server not initialized", {
              cors: false,
            });
      }
      this.runtimeKind = "legacy";
      await this.onStart(this.propsFromLegacyRequest(request, verified));
    } else {
      if (
        this.runtimeKind !== "legacy" ||
        stored.userId !== verified.accountId ||
        stored.organizationId !== verified.organizationId ||
        mcpResourceKey(stored.resource) !== verified.resourceKey
      ) {
        return jsonRpcErrorBody(403, -32003, "MCP session does not belong to the current bearer", {
          cors: false,
        });
      }
      await this.onStart(
        this.propsFromSessionMeta(stored, {
          traceparent: request.headers.get("traceparent") ?? undefined,
          tracestate: request.headers.get("tracestate") ?? undefined,
          baggage: request.headers.get("baggage") ?? undefined,
        }),
      );
    }

    this.legacyRunningRequestCount += 1;
    await this.markActivity();
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: running-request accounting must settle on transport failure too
    try {
      return await this.handleLegacyTransportRequest(request, parsedBody);
    } finally {
      this.legacyRunningRequestCount = Math.max(0, this.legacyRunningRequestCount - 1);
    }
  }

  /**
   * Serve one authenticated modern request without entering the legacy
   * sessionful streamable-HTTP transport.
   */
  async serveModernMcp(
    request: Request,
    props: McpSessionProps,
    parsedBody: unknown,
  ): Promise<Response> {
    this.modernRequestStateSigningKey();
    const verified = verifiedMcpRequestHeaders(request);
    if (
      !verified ||
      verified.accountId !== props.session.userId ||
      verified.organizationId !== props.session.organizationId ||
      verified.resourceKey !== mcpResourceKey(props.session.resource)
    ) {
      return jsonRpcErrorBody(403, -32003, "Invalid MCP Durable Object identity", {
        cors: false,
      });
    }
    const access = await this.startModernRuntime(props);
    const sessionMeta = this.sessionMeta;
    if (
      access.status === "forbidden" ||
      !sessionMeta ||
      !this.modernPropsOwnSession(sessionMeta, props)
    ) {
      return jsonRpcErrorBody(403, -32003, "MCP session does not belong to the current bearer", {
        cors: false,
      });
    }

    // Modern clients self-report identity per request (`_meta` clientInfo) or
    // at `initialize`; persist it so meta-less requests and cold restores keep
    // their span attribution. Best-effort by construction (persistClientInfo
    // swallows failures) and a storage no-op unless the identity changed.
    const reportedClientInfo = clientInfoFromRequestBody(parsedBody);
    if (reportedClientInfo) {
      await Effect.runPromise(
        this.withTelemetry(this.persistClientInfo(reportedClientInfo), props.propagation),
      );
    }

    this.modernRequestBodies.set(request, parsedBody);
    this.modernRequestPropagation.set(request, props.propagation);
    this.modernRunningRequestCount += 1;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: the RPC must decrement its in-memory running lease on both handler resolution and rejection
    try {
      return await this.modernHandlerForRuntime().fetch(request, { parsedBody });
    } finally {
      this.modernRunningRequestCount = Math.max(0, this.modernRunningRequestCount - 1);
    }
  }

  async validateMcpSessionOwner(
    identity: McpApprovalOwner,
  ): Promise<"ok" | "not_found" | "forbidden" | "terminated"> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* self.prepareErrorCaptureScope();
        // A DELETE-terminated session is condemned via `_cf_scheduleDestroy`,
        // which writes a durable marker and defers the actual storage wipe to
        // an alarm (~1s later). A request that races into that window still
        // sees the session's storage intact, so without this gate the session
        // would restore and answer — but the protocol contract is that a
        // terminated id is dead the moment the DELETE returns.
        const destroyPending = yield* Effect.promise(() =>
          self.ctx.storage.get<boolean>(DESTROY_PENDING_KEY),
        );
        if (destroyPending === true) return "terminated" as const;
        const sessionMeta = yield* self.loadSessionMeta();
        if (!sessionMeta) return "not_found" as const;
        if (self.initialized) {
          yield* Effect.promise(() => self.markActivity()).pipe(
            Effect.withSpan("McpSessionDO.markActivity"),
          );
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

  /** Condemn this session and arm a fresh alarm invocation to wipe it. */
  async _cf_scheduleDestroy(): Promise<void> {
    await this.ctx.storage.put(DESTROY_PENDING_KEY, true);
    await this.ctx.storage.setAlarm(Date.now() + DESTROY_ALARM_DELAY_MS);
  }

  private async destroySession(): Promise<void> {
    await this.cleanup();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    setTimeout(() => this.ctx.abort("destroyed"), 0);
  }

  private async pausedExecutionCount(): Promise<number> {
    if (!this.engine) return 0;
    return Effect.runPromise(this.engine.pausedExecutionCount());
  }

  override async alarm(): Promise<void> {
    if ((await this.ctx.storage.get<boolean>(DESTROY_PENDING_KEY)) === true) {
      await this.destroySession();
      return;
    }
    const sessionMeta = await Effect.runPromise(this.loadSessionMeta());
    if (!sessionMeta) {
      await this.cleanupUnaddressableSessionAlarm();
      return;
    }
    const isModernSession = this.runtimeKind === "modern";
    const lastActivityMs = await this.loadLastActivity();
    const idleMs = lastActivityMs > 0 ? Date.now() - lastActivityMs : 0;
    const pausedExecutionCount = await this.pausedExecutionCount();
    const runningExecutionCount = this.runningExecutionCount();
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
      await this.ctx.storage.setAlarm(Date.now() + Math.max(1, this.sessionTimeoutMs() - idleMs));
      return;
    }

    const ownerId = isModernSession ? this.modernExecutionOwnerRoute().sessionId : this.sessionId;

    if (decision.kind === "extend_paused_lease") {
      console.info(
        JSON.stringify(
          pausedLeaseExtensionLog({
            sessionId: ownerId,
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
            sessionId: ownerId,
            runningExecutionCount,
            activeStreamCount,
            idleMs,
            leaseMs: decision.leaseMs,
          }),
        ),
      );
      // A direct streamed response represents work that can still deliver or
      // replay a result. Cancellation, completion, and max-age rotation all
      // decrement activeStreamCount, so dead streams stop extending the lease.
      await this.ctx.storage.setAlarm(Date.now() + decision.leaseMs);
      return;
    }

    await this.disposeIdleRuntime({ idleMs, lastActivityMs, pausedExecutionCount });
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
    owner: McpExecutionOwnerRoute = this.executionOwnerRoute(),
  ): Effect.Effect<void> {
    const directory = this.executionOwnerDirectory();
    if (!directory || !deadline) return Effect.void;
    const self = this;
    return Effect.gen(function* () {
      const sessionMeta = yield* self.loadSessionMeta();
      if (!sessionMeta) return;
      const record: McpExecutionOwnerRecord = {
        executionId,
        owner,
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
    currentOwner: McpExecutionOwnerRoute = this.executionOwnerRoute(),
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

      if (self.sameExecutionOwnerRoute(record.owner, currentOwner)) {
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
    owner: McpExecutionOwnerRoute = this.executionOwnerRoute(),
  ): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.prepareErrorCaptureScope();
      if (self.pendingApprovalLeases.has(executionId)) return;

      // The base owns alarm arming now: record the in-memory lease first, then
      // mark activity so the session alarm is durably scheduled for the idle /
      // paused-expiry policy while this approval is outstanding.
      const disposeKeepAlive = yield* Effect.promise(() => self.keepAlive());
      yield* Effect.promise(() => self.markActivity()).pipe(
        Effect.withSpan("McpSessionDO.markActivity"),
      );
      const timeout = setTimeout(() => {
        self.queuePendingApprovalLeaseExpiration(executionId);
      }, PAUSED_APPROVAL_TIMEOUT_MS);
      self.pendingApprovalLeases.set(executionId, { disposeKeepAlive, timeout, expiring: false });
      yield* self.writeExecutionOwnerEntry(executionId, deadline, owner);
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
