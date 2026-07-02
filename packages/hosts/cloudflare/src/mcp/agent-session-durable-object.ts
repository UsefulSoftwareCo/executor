import { Cause, Deferred, Effect, Exit, Option, Schema } from "effect";
import type * as Tracer from "effect/Tracer";
import type { Connection, ConnectionContext } from "agents";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { RequestOrgSlug, RequestWebOrigin } from "@executor-js/api/server";
import {
  formatPausedExecution,
  type ExecutionEngine,
  type ResumeResponse,
} from "@executor-js/execution";
import {
  PAUSED_APPROVAL_TIMEOUT_MS,
  type PausedExecutionHooks,
} from "@executor-js/host-mcp/tool-server";
import { defaultMcpResource, type McpResource } from "@executor-js/host-mcp";

import type { IncomingPropagationHeaders, McpElicitationMode } from "./do-headers";
import {
  SESSION_TIMEOUT_MS,
  decideSessionAlarm,
  pausedLeaseExtensionLog,
} from "./session-alarm-policy";

export type IncomingTraceHeaders = IncomingPropagationHeaders;

export interface McpSessionInit {
  readonly organizationId: string;
  readonly userId: string;
  readonly elicitationMode: McpElicitationMode;
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
  readonly elicitationMode?: "browser" | "model" | "native";
  /** The MCP resource the session serves (carried from {@link McpSessionInit});
   *  `buildMcpServer` scopes the tool catalog to it. */
  readonly resource: McpResource;
  readonly webOrigin?: string;
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
const MCP_HTTP_METHOD_HEADER = "cf-mcp-method";
const MCP_MESSAGE_HEADER = "cf-mcp-message";
const ACTIVE_POST_RESPONSE_WAIT_POLL_MS = 25;
const ACTIVE_POST_RESPONSE_WAIT_MAX_MS = PAUSED_APPROVAL_TIMEOUT_MS + 30_000;
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  private lastActivityMs = 0;
  private approvalResponses = new Map<string, ResumeResponse>();
  private approvalWaiters = new Map<string, Deferred.Deferred<ResumeResponse>>();
  private pendingApprovalLeases = new Map<string, PendingApprovalLease>();

  protected abstract openSessionDb(): TDbHandle | Promise<TDbHandle>;

  protected abstract resolveSessionMeta(token: McpSessionInit): Effect.Effect<SessionMeta>;

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

  protected flushTelemetry(): Promise<void> {
    return Promise.resolve();
  }

  protected get sessionId(): string {
    return this.getSessionId();
  }

  protected currentParentSpan(): Tracer.AnySpan | undefined {
    return undefined;
  }

  protected readonly browserApprovalStore: BrowserApprovalStore = {
    takeResponse: (executionId) => this.takeApprovalResponse(executionId),
    waitForResponse: (executionId) => this.waitForApprovalResponse(executionId),
  };

  protected readonly pausedExecutionHooks: PausedExecutionHooks = {
    onExecutionPaused: (executionId) =>
      Effect.sync(() => {
        this.queuePendingApprovalLeaseStart(executionId);
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
      await super.onConnect(conn, context);
      await this.waitForActivePostResponseDrain(conn.id);
    });
  }

  private openSessionDbHandle(): Effect.Effect<TDbHandle> {
    return Effect.promise(() => Promise.resolve(this.openSessionDb()));
  }

  private async waitForActivePostResponseDrain(streamId: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const requestIds = await this.getStreamRequestIds(streamId);
      if (!requestIds || requestIds.length === 0) return;
      if (Date.now() - startedAt >= ACTIVE_POST_RESPONSE_WAIT_MAX_MS) {
        console.warn(
          JSON.stringify({
            event: "mcp_active_post_response_wait_timeout",
            sessionId: this.sessionId,
            streamId,
            requestIds,
            elapsedMs: Date.now() - startedAt,
          }),
        );
        return;
      }
      await sleep(ACTIVE_POST_RESPONSE_WAIT_POLL_MS);
    }
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

  private async markActivity(now = Date.now()): Promise<void> {
    this.lastActivityMs = now;
    await Promise.all([
      this.ctx.storage.put(LAST_ACTIVITY_KEY, now),
      this.ctx.storage.setAlarm(now + SESSION_TIMEOUT_MS),
    ]);
  }

  private async loadLastActivity(): Promise<number> {
    if (this.lastActivityMs > 0) return this.lastActivityMs;
    const stored = await this.ctx.storage.get<number>(LAST_ACTIVITY_KEY);
    this.lastActivityMs = stored ?? 0;
    return this.lastActivityMs;
  }

  private async hasPartyServerName(): Promise<boolean> {
    if (this.ctx.id.name) return true;
    const stored = await this.ctx.storage.get<string>(PARTYSERVER_NAME_KEY);
    return !!stored;
  }

  private async cleanupUnaddressableSessionAlarm(): Promise<void> {
    await Effect.runPromise(this.closeRuntime());
    await Effect.runPromise(
      Effect.all([
        Effect.ignore(Effect.tryPromise(() => this.ctx.storage.deleteAlarm())),
        Effect.ignore(Effect.tryPromise(() => this.ctx.storage.delete(LAST_ACTIVITY_KEY))),
      ]),
    );
  }

  private resolveAndStoreSessionMeta(token: McpSessionInit) {
    const self = this;
    return Effect.gen(function* () {
      const resolved = yield* self.resolveSessionMeta(token);
      const sessionMeta: SessionMeta = {
        ...resolved,
        ...(token.webOrigin ? { webOrigin: token.webOrigin } : {}),
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

  private closeRuntime(): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.releaseAllPendingApprovalLeases();
      if (self.server) {
        const server = self.server;
        yield* Effect.promise(() => server.close()).pipe(Effect.ignore);
      }
      self.engine = null;
      if (self.dbHandle) {
        const dbHandle = self.dbHandle;
        self.dbHandle = null;
        yield* Effect.promise(() => Promise.resolve(dbHandle.end())).pipe(Effect.ignore);
      }
      self.initialized = false;
    });
  }

  private ensureRuntimeForApproval(): Effect.Effect<boolean> {
    const self = this;
    return Effect.gen(function* () {
      if (self.initialized && self.engine) return true;

      const sessionMeta = yield* self.loadSessionMeta();
      if (!sessionMeta) return false;

      yield* self.closeRuntime();
      const dbHandle = yield* self.openSessionDbHandle();
      const { mcpServer, engine } = yield* self.buildRuntime(sessionMeta, dbHandle);
      self.dbHandle = dbHandle;
      self.server = mcpServer;
      self.engine = engine;
      self.initialized = true;
      yield* Effect.promise(() => self.markActivity()).pipe(
        Effect.withSpan("McpSessionDO.markActivity"),
      );
      return true;
    }).pipe(Effect.withSpan("McpSessionDO.ensure_runtime_for_approval"));
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
      const sessionMeta = yield* self.resolveAndStoreSessionMeta(props.session);
      const dbHandle = yield* self.openSessionDbHandle();
      const { mcpServer, engine } = yield* self.buildRuntime(sessionMeta, dbHandle);
      self.dbHandle = dbHandle;
      self.server = mcpServer;
      self.engine = engine;
      self.initialized = true;
      yield* Effect.promise(() => self.markActivity()).pipe(
        Effect.withSpan("McpSessionDO.markActivity"),
      );
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.gen(function* () {
          console.error("[mcp-session] init failed:", Cause.pretty(cause));
          self.captureCause(cause);
          yield* self.recordCauseOnSpan(cause);
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
  ): Promise<"ok" | "not_found" | "forbidden"> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        const sessionMeta = yield* self.loadSessionMeta();
        if (!sessionMeta) return "not_found" as const;
        yield* Effect.promise(() => self.markActivity()).pipe(
          Effect.withSpan("McpSessionDO.markActivity"),
        );
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
        const owner = yield* self.validateApprovalIdentity(identity);
        if (owner !== "ok") return { status: owner } as const;

        const restored = yield* self.ensureRuntimeForApproval();
        if (!restored || !self.engine) return { status: "not_found" } as const;

        const paused = yield* self.engine.getPausedExecution(executionId);
        if (!paused) return { status: "not_found" } as const;

        const formatted = formatPausedExecution(paused);
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

  async resumeExecutionForApproval(
    executionId: string,
    identity: McpApprovalOwner,
    response: ResumeResponse,
    incoming?: IncomingTraceHeaders,
  ): Promise<McpSessionResumeApprovalResult> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
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
    if (!(await this.hasPartyServerName())) {
      await this.cleanupUnaddressableSessionAlarm();
      return;
    }
    const lastActivityMs = await this.loadLastActivity();
    const idleMs = lastActivityMs > 0 ? Date.now() - lastActivityMs : 0;
    const pausedExecutionCount = await this.pausedExecutionCount();
    const decision = decideSessionAlarm({ idleMs, pausedExecutionCount });

    if (decision.kind === "idle_within_timeout") {
      await super.alarm();
      return;
    }

    if (decision.kind === "extend_paused_lease") {
      console.info(
        JSON.stringify(
          pausedLeaseExtensionLog({
            sessionId: this.sessionId,
            pausedExecutionCount,
            idleMs,
            leaseMs: decision.leaseMs,
          }),
        ),
      );
      await this.ctx.storage.setAlarm(Date.now() + decision.leaseMs);
      return;
    }

    await this.destroy();
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

  private startPendingApprovalLease(executionId: string): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      if (self.pendingApprovalLeases.has(executionId)) return;

      yield* Effect.promise(() => self.markActivity()).pipe(
        Effect.withSpan("McpSessionDO.markActivity"),
      );
      const disposeKeepAlive = yield* Effect.promise(() => self.keepAlive());
      const timeout = setTimeout(() => {
        self.queuePendingApprovalLeaseExpiration(executionId);
      }, PAUSED_APPROVAL_TIMEOUT_MS);
      self.pendingApprovalLeases.set(executionId, { disposeKeepAlive, timeout, expiring: false });
    }).pipe(
      Effect.withSpan("McpSessionDO.pending_approval_lease.start", {
        attributes: { "mcp.execution.id": executionId },
      }),
      Effect.tapCause((cause) =>
        Effect.sync(() => {
          console.error("[mcp-session] pending approval lease start failed:", Cause.pretty(cause));
          self.captureCause(cause);
        }),
      ),
      Effect.ignore,
    );
  }

  private queuePendingApprovalLeaseStart(executionId: string): void {
    this.ctx.waitUntil(Effect.runPromise(this.startPendingApprovalLease(executionId)));
  }

  private queuePendingApprovalLeaseExpiration(executionId: string): void {
    this.ctx.waitUntil(
      Effect.runPromise(
        this.expirePendingApproval(executionId).pipe(
          Effect.tapCause((cause) =>
            Effect.sync(() => {
              console.error(
                "[mcp-session] pending approval lease expiration failed:",
                Cause.pretty(cause),
              );
              this.captureCause(cause);
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
    return Effect.sync(() => {
      const lease = this.pendingApprovalLeases.get(executionId);
      if (!lease) return;
      if (lease.timeout) clearTimeout(lease.timeout);
      this.pendingApprovalLeases.delete(executionId);
      lease.disposeKeepAlive();
    });
  }

  private releaseAllPendingApprovalLeases(): Effect.Effect<void> {
    return Effect.sync(() => {
      for (const executionId of this.pendingApprovalLeases.keys()) {
        const lease = this.pendingApprovalLeases.get(executionId);
        if (!lease) continue;
        if (lease.timeout) clearTimeout(lease.timeout);
        lease.disposeKeepAlive();
      }
      this.pendingApprovalLeases.clear();
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
