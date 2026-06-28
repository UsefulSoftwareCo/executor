// ---------------------------------------------------------------------------
// Shared MCP Session Durable Object base — holds the MCP server + engine for ONE
// session in a single addressable isolate (the DO id IS the mcp-session-id), so
// every follow-up request routes back to the same isolate. Owns ALL the
// platform-generic lifecycle (cold-restore from ctx.storage, the inactivity
// alarm, owner validation, the JSON-response-mode transport upgrade, the
// per-request→per-session span bridge, the browser-approval store). A host
// supplies only the seams: openSessionDb / resolveSessionMeta / buildMcpServer,
// and optionally withTelemetry / captureCause. cloud and host-cloudflare each
// become a ~100-line subclass binding their injected dependencies.
// ---------------------------------------------------------------------------

import { DurableObject } from "cloudflare:workers";
import { Cause, Deferred, Effect } from "effect";
import type * as Tracer from "effect/Tracer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TransportState } from "agents/mcp";

import { jsonRpcErrorBody } from "@executor-js/host-mcp";
import { formatResumeAcknowledgement } from "@executor-js/host-mcp/browser-approval";
import { RequestOrgSlug, RequestWebOrigin } from "@executor-js/api/server";
import {
  formatPausedExecution,
  type ExecutionEngine,
  type ResumeResponse,
} from "@executor-js/execution";

import { makeMcpWorkerTransport, type McpWorkerTransport } from "./worker-transport";
import {
  INTERNAL_ACCOUNT_ID_HEADER,
  INTERNAL_ORGANIZATION_ID_HEADER,
  INTERNAL_RESOURCE_KEY_HEADER,
  type IncomingPropagationHeaders,
} from "./do-headers";
import { mcpResourceKey } from "@executor-js/host-mcp";
import type { McpSessionInit } from "./seams";
import type { McpResource } from "@executor-js/host-mcp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { McpSessionInit } from "./seams";

/** The W3C trace headers the worker forwards to the DO (same shape as the
 *  dispatcher's propagation headers). */
export type IncomingTraceHeaders = IncomingPropagationHeaders;

export type McpApprovalOwner = {
  readonly accountId: string;
  readonly organizationId: string;
};

type McpSessionApprovalErrorResult =
  | { readonly status: "not_found" }
  | { readonly status: "forbidden" };

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

const resumeApprovalResult = (
  executionId: string,
  response: ResumeResponse,
): Extract<McpSessionResumeApprovalResult, { readonly status: "ok" }> => ({
  status: "ok",
  executionStatus: "completed",
  ...formatResumeAcknowledgement(executionId, response),
  isError: false,
});

const HEARTBEAT_MS = 30 * 1000;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const TRANSPORT_STATE_KEY = "transport";
const SESSION_META_KEY = "session-meta";
const LAST_ACTIVITY_KEY = "last-activity-ms";
const approvalResponseKey = (executionId: string) => `approval-response:${executionId}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The DO's JSON-RPC error bodies are INNER responses (no CORS): the edge worker
// re-wraps them with CORS before they leave the origin, so the canonical
// renderer is called with `cors: false` to stay byte-identical to the prior
// hand-rolled copy (`content-type: application/json` only).
const jsonRpcError = (status: number, code: number, message: string) =>
  jsonRpcErrorBody(status, code, message, { cors: false });

const sessionOwnerMismatch = () =>
  jsonRpcError(403, -32003, "MCP session does not belong to the current bearer");

// ---------------------------------------------------------------------------
// Host seams
// ---------------------------------------------------------------------------

/**
 * A host's per-session DB handle. The base only disposes it during runtime
 * teardown; the host's `buildMcpServer` reads its concrete shape (postgres.js
 * for cloud, the D1 `ExecutorDbHandle` for host-cloudflare).
 */
export interface SessionDbHandle {
  readonly end: () => Promise<void> | void;
}

/**
 * Resolved session identity + elicitation mode — the output of a host's
 * `resolveSessionMeta`. Persisted to `ctx.storage` so a cold isolate can
 * re-validate ownership and rebuild the runtime without re-resolving.
 */
export interface SessionMeta {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly resource: McpResource;
  /** The org's URL slug, when the host's `resolveSessionMeta` carried one.
   *  Pins browser-handoff URLs to the right org's console. */
  readonly organizationSlug?: string;
  readonly userId: string;
  readonly elicitationMode?: "browser" | "model" | "native";
  /** Public origin captured at session create — used to derive the runtime's
   *  web base URL when the host configures no static one. */
  readonly webOrigin?: string;
}

/** What a host's `buildMcpServer` seam returns: the connected MCP server plus
 *  the engine the base drives for paused-execution approval flows. */
export interface BuiltMcpServer {
  readonly mcpServer: McpServer;
  readonly engine: ExecutionEngine<Cause.YieldableError>;
}

/** The shared browser-approval store the base wires to its persisted approval
 *  responses; a host hands it to its MCP server when elicitation is "browser". */
export interface BrowserApprovalStore {
  readonly takeResponse: (executionId: string) => Effect.Effect<ResumeResponse | null>;
  readonly waitForResponse: (executionId: string) => Effect.Effect<ResumeResponse | null>;
}

// ---------------------------------------------------------------------------
// Durable Object base
// ---------------------------------------------------------------------------

export abstract class McpSessionDOBase<
  TDbHandle extends SessionDbHandle = SessionDbHandle,
> extends DurableObject {
  private readonly instanceCreatedAt = Date.now();
  private mcpServer: McpServer | null = null;
  private transport: McpWorkerTransport | null = null;
  private engine: ExecutionEngine<Cause.YieldableError> | null = null;
  private initialized = false;
  private lastActivityMs = 0;
  private dbHandle: TDbHandle | null = null;
  private sessionMeta: SessionMeta | null = null;
  private transportJsonResponseMode: boolean | null = null;
  private approvalResponses = new Map<string, ResumeResponse>();
  private approvalWaiters = new Map<string, Deferred.Deferred<ResumeResponse>>();
  // Updated at the start of each `handleRequest` so the host-mcp server's
  // `parentSpan` getter — invoked by the MCP SDK's deferred tool callbacks
  // after `transport.handleRequest()` has already returned its streaming
  // Response — can hand back the request-scoped span. The server is
  // session-scoped (a fresh server-per-request would lose the elicitation
  // request → reply correlation that the SDK keeps in-memory on the
  // `Server` instance), so we have to bridge a per-request value through
  // a per-session reference.
  private currentRequestSpan: Tracer.AnySpan | null = null;

  // -------------------------------------------------------------------------
  // Host seams — the ONLY platform-specific surface. A host subclass binds its
  // DB driver, organization lookup, and MCP-server/engine construction; cloud
  // adds telemetry + Sentry by overriding the two optional hooks. Everything
  // else in this class is platform-generic.
  // -------------------------------------------------------------------------

  /** Open the per-session DB handle the runtime holds for this session's
   *  lifetime (postgres.js for cloud, the D1 handle for host-cloudflare). May be
   *  async — host-cloudflare runs an idempotent schema bring-up when it opens. */
  protected abstract openSessionDb(): TDbHandle | Promise<TDbHandle>;

  /** Resolve `openSessionDb` (sync or async) into the Effect chain. */
  private openSessionDbHandle(): Effect.Effect<TDbHandle> {
    return Effect.promise(() => Promise.resolve(this.openSessionDb()));
  }

  /** Resolve + validate the session owner into the meta persisted to storage.
   *  Owns its own short-lived DB/services (it runs once per session create). */
  protected abstract resolveSessionMeta(token: McpSessionInit): Effect.Effect<SessionMeta>;

  /** Build the connected MCP server + engine for a resolved session. The host
   *  provides its execution stack + DB layers here; the base owns the transport
   *  and the per-request span / browser-approval wiring exposed below. */
  protected abstract buildMcpServer(
    sessionMeta: SessionMeta,
    dbHandle: TDbHandle,
  ): Effect.Effect<BuiltMcpServer>;

  /** Optional telemetry seam: stitch the DO span under the worker's incoming
   *  trace and install the host's tracer. Default is identity (no telemetry). */
  protected withTelemetry<A, E>(
    effect: Effect.Effect<A, E>,
    _incoming?: IncomingTraceHeaders,
  ): Effect.Effect<A, E> {
    return effect;
  }

  /** Optional error seam: report a fatal request cause (cloud → Sentry). */
  protected captureCause(_cause: Cause.Cause<unknown>): void {}

  /** Optional flush seam: force-export buffered spans before the DO RPC
   *  settles. Default is a no-op; cloud overrides it with the tracer
   *  provider's `forceFlush`. Without this, a DO whose Effect dies tears the
   *  isolate down with the SimpleSpanProcessor's in-flight export `fetch`
   *  still pending — so the failing method's OWN spans (and the exception +
   *  stack the Effect tracer records on them) never reach the collector, and
   *  only the worker-side `mcp.do.*` span (which carries just the RPC-boundary
   *  message, no real stack) survives. Flushing in an `ensuring` finalizer —
   *  placed OUTSIDE the span so the span has already ended and the
   *  SimpleSpanProcessor has fired its export — lets the flush await that
   *  export before the RPC rejects. */
  protected flushTelemetry(): Promise<void> {
    return Promise.resolve();
  }

  /** Mirror an error cause onto the active span as top-level attributes. The
   *  Effect OTel tracer already records the cause as an `exception` span
   *  EVENT (`exception.stacktrace` = the full `Cause.pretty` rendering), but
   *  span events are awkward to query in Axiom and the worker-side spans never
   *  see them. Copying type/message/stack onto plain span attributes makes the
   *  failing frame a one-field APL lookup on the span row itself. */
  private recordCauseOnSpan(cause: Cause.Cause<unknown>): Effect.Effect<void> {
    const errors = Cause.prettyErrors(cause);
    // No `Error` reasons means a pure interruption (or empty cause) — nothing
    // worth annotating, and we don't want to flag interrupts as failures.
    if (errors.length === 0) return Effect.void;
    const first = errors[0];
    return Effect.annotateCurrentSpan({
      "exception.type": first?.name ?? "Error",
      "exception.message": first?.message ?? "unknown",
      "exception.stacktrace": Cause.pretty(cause),
    });
  }

  /** Flush DO-side spans once the wrapped method (incl. its span) has ended,
   *  whether it succeeded or died. Apply as the OUTERMOST pipe step. */
  private withSpanFlush<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
    const self = this;
    return effect.pipe(Effect.ensuring(Effect.promise(() => self.flushTelemetry())));
  }

  /** The session id — equal to this DO's id. */
  protected get sessionId(): string {
    return this.ctx.id.toString();
  }

  /** The request-scoped span for the host-mcp `parentSpan` getter (read by
   *  deferred MCP SDK callbacks after the request Effect has returned). */
  protected currentParentSpan(): Tracer.AnySpan | undefined {
    return this.currentRequestSpan ?? undefined;
  }

  /** The browser-approval store wired to this session's persisted responses. */
  protected readonly browserApprovalStore: BrowserApprovalStore = {
    takeResponse: (executionId) => this.takeApprovalResponse(executionId),
    waitForResponse: (executionId) => this.waitForApprovalResponse(executionId),
  };

  private makeStorage() {
    return {
      get: async (): Promise<TransportState | undefined> => {
        return await this.ctx.storage.get<TransportState>(TRANSPORT_STATE_KEY);
      },
      set: async (state: TransportState): Promise<void> => {
        await this.ctx.storage.put(TRANSPORT_STATE_KEY, state);
      },
    };
  }

  private loadSessionMeta(): Effect.Effect<SessionMeta | null> {
    return Effect.promise(async () => {
      if (this.sessionMeta) return this.sessionMeta;
      const stored = await this.ctx.storage.get<SessionMeta>(SESSION_META_KEY);
      this.sessionMeta = stored ?? null;
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
      this.ctx.storage.setAlarm(now + HEARTBEAT_MS),
    ]);
  }

  private async loadLastActivity(): Promise<number> {
    if (this.lastActivityMs > 0) return this.lastActivityMs;
    const stored = await this.ctx.storage.get<number>(LAST_ACTIVITY_KEY);
    this.lastActivityMs = stored ?? 0;
    return this.lastActivityMs;
  }

  private entryAttrs(methodEnteredAt: number): Record<string, unknown> {
    const now = Date.now();
    return {
      "mcp.do.instance_age_ms": now - this.instanceCreatedAt,
      "mcp.do.method_entry_delay_ms": now - methodEnteredAt,
      "mcp.session.session_id": this.ctx.id.toString(),
      "mcp.session.initialized": this.initialized,
      "mcp.session.has_transport": !!this.transport,
      "mcp.session.has_meta_memory": !!this.sessionMeta,
    };
  }

  private clearSessionState(): Effect.Effect<void> {
    return Effect.promise(async () => {
      this.sessionMeta = null;
      this.initialized = false;
      this.lastActivityMs = 0;
      this.transportJsonResponseMode = null;

      await Promise.all([
        // oxlint-disable-next-line executor/no-promise-catch -- boundary: Durable Object storage cleanup is best-effort after session invalidation
        this.ctx.storage.delete(TRANSPORT_STATE_KEY).catch(() => false),
        // oxlint-disable-next-line executor/no-promise-catch -- boundary: Durable Object storage cleanup is best-effort after session invalidation
        this.ctx.storage.delete(SESSION_META_KEY).catch(() => false),
        // oxlint-disable-next-line executor/no-promise-catch -- boundary: Durable Object storage cleanup is best-effort after session invalidation
        this.ctx.storage.delete(LAST_ACTIVITY_KEY).catch(() => false),
        // oxlint-disable-next-line executor/no-promise-catch -- boundary: Durable Object alarm cleanup is best-effort after session invalidation
        this.ctx.storage.deleteAlarm().catch(() => undefined),
      ]);
    }).pipe(Effect.withSpan("mcp.session.clear_state"));
  }

  private createConnectedRuntime(
    sessionMeta: SessionMeta,
    options: { readonly dbHandle: TDbHandle; readonly enableJsonResponse?: boolean },
  ) {
    const self = this;
    return Effect.gen(function* () {
      // The host builds its MCP server + engine (execution stack, DB layers,
      // elicitation policy); the base owns the worker transport so JSON-response
      // mode, the session-id generator, and storage stay identical everywhere.
      // The session's captured origin is provided here so the host's execution
      // stack derives a web base URL zero-config (a no-op when it configures one).
      const built = self.buildMcpServer(sessionMeta, options.dbHandle);
      const withOrigin = sessionMeta.webOrigin
        ? built.pipe(Effect.provideService(RequestWebOrigin, { origin: sessionMeta.webOrigin }))
        : built;
      // Pin browser-handoff URLs to the session's org slug when captured at
      // create; absent slug leaves the URL bare for client canonicalization.
      const { mcpServer, engine } = yield* sessionMeta.organizationSlug
        ? withOrigin.pipe(
            Effect.provideService(RequestOrgSlug, { slug: sessionMeta.organizationSlug }),
          )
        : withOrigin;
      const transport = yield* makeMcpWorkerTransport({
        sessionIdGenerator: () => self.sessionId,
        storage: self.makeStorage(),
        enableJsonResponse: options.enableJsonResponse,
      });
      self.transportJsonResponseMode = options.enableJsonResponse ?? false;
      yield* transport.connect(mcpServer);
      return { mcpServer, transport, engine };
    }).pipe(Effect.withSpan("McpSessionDO.createRuntime"));
  }

  private closeRuntime(): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      if (self.transport) {
        yield* self.transport.close();
        self.transport = null;
      }
      if (self.mcpServer) {
        const mcpServer = self.mcpServer;
        // oxlint-disable-next-line executor/no-promise-catch -- boundary: MCP SDK close failure is ignored during best-effort runtime teardown
        yield* Effect.promise(() => mcpServer.close().catch(() => undefined));
        self.mcpServer = null;
      }
      self.engine = null;
      if (self.dbHandle) {
        const dbHandle = self.dbHandle;
        yield* Effect.promise(() => Promise.resolve(dbHandle.end()));
        self.dbHandle = null;
      }
      self.initialized = false;
      self.transportJsonResponseMode = null;
    }).pipe(
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: DO cleanup has no typed failure surface
      Effect.orDie,
    );
  }

  private installRuntime(
    sessionMeta: SessionMeta,
    options: {
      readonly dbHandle: TDbHandle;
      readonly enableJsonResponse: boolean;
    },
  ) {
    const self = this;
    return Effect.gen(function* () {
      const runtime = yield* self.createConnectedRuntime(sessionMeta, options);
      self.dbHandle = options.dbHandle;
      self.mcpServer = runtime.mcpServer;
      self.transport = runtime.transport;
      self.engine = runtime.engine;
      self.initialized = true;
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
      yield* self.installRuntime(sessionMeta, {
        dbHandle,
        enableJsonResponse: true,
      });
      yield* Effect.promise(() => self.markActivity()).pipe(
        Effect.withSpan("McpSessionDO.markActivity"),
      );
      return true;
    }).pipe(
      Effect.withSpan("McpSessionDO.ensure_runtime_for_approval"),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: DO RPC has no typed Effect channel
      Effect.orDie,
    );
  }

  private validateApprovalIdentity(
    identity: McpApprovalOwner,
  ): Effect.Effect<"ok" | "not_found" | "forbidden"> {
    const self = this;
    return Effect.gen(function* () {
      const sessionMeta = yield* self.loadSessionMeta();
      if (!sessionMeta) return "not_found" as const;

      const matches =
        identity.accountId === sessionMeta.userId &&
        identity.organizationId === sessionMeta.organizationId;

      yield* Effect.annotateCurrentSpan({
        "mcp.session.owner_match": matches,
      });

      return matches ? ("ok" as const) : ("forbidden" as const);
    }).pipe(Effect.withSpan("mcp.session.validate_approval_identity"));
  }

  private restoreRuntimeFromStorage(request: Request): Effect.Effect<"restored" | "missing_meta"> {
    const self = this;
    return Effect.gen(function* () {
      if (self.initialized && self.transport) return "restored" as const;

      const sessionMeta = yield* self.loadSessionMeta();
      if (!sessionMeta) {
        yield* Effect.annotateCurrentSpan({
          "mcp.session.restore.outcome": "missing_meta",
        });
        return "missing_meta" as const;
      }

      yield* self.closeRuntime();
      const dbHandle = yield* self.openSessionDbHandle();
      yield* self.installRuntime(sessionMeta, {
        dbHandle,
        // GET always returns an SSE stream regardless of this option, but the
        // session-scoped transport is reused by later POSTs. Keep JSON mode on
        // across cold restores so a GET reconnect cannot poison future POSTs.
        enableJsonResponse: true,
      });
      yield* Effect.promise(() => self.markActivity()).pipe(
        Effect.withSpan("McpSessionDO.markActivity"),
      );
      yield* Effect.annotateCurrentSpan({
        "mcp.session.restore.outcome": "restored",
      });
      return "restored" as const;
    }).pipe(
      Effect.withSpan("McpSessionDO.restoreRuntime", {
        attributes: {
          "mcp.request.method": request.method,
          "mcp.request.session_id_present": !!request.headers.get("mcp-session-id"),
        },
      }),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: cold DO restore is re-entered from Promise-only Durable Object method
      Effect.orDie,
    );
  }

  private ensureJsonResponseTransportForPost(request: Request): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      if (request.method !== "POST" || self.transportJsonResponseMode === true) return;

      const sessionMeta = yield* self.loadSessionMeta();
      if (!sessionMeta) return;

      yield* self.closeRuntime();
      const dbHandle = yield* self.openSessionDbHandle();
      yield* self.installRuntime(sessionMeta, {
        dbHandle,
        enableJsonResponse: true,
      });
      yield* Effect.annotateCurrentSpan({
        "mcp.session.transport_upgraded_json_response": true,
      });
    }).pipe(
      Effect.withSpan("McpSessionDO.ensureJsonResponseTransportForPost"),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: transport rebuild is internal DO runtime state
      Effect.orDie,
    );
  }

  private validateSessionOwner(request: Request): Effect.Effect<Response | null> {
    const self = this;
    return Effect.gen(function* () {
      const sessionMeta = yield* self.loadSessionMeta();
      if (!sessionMeta) return null;

      const accountId = request.headers.get(INTERNAL_ACCOUNT_ID_HEADER);
      const organizationId = request.headers.get(INTERNAL_ORGANIZATION_ID_HEADER);
      const resourceKey = request.headers.get(INTERNAL_RESOURCE_KEY_HEADER);
      const matches =
        accountId === sessionMeta.userId &&
        organizationId === sessionMeta.organizationId &&
        resourceKey === mcpResourceKey(sessionMeta.resource);

      yield* Effect.annotateCurrentSpan({
        "mcp.session.owner_match": matches,
      });

      return matches ? null : sessionOwnerMismatch();
    }).pipe(Effect.withSpan("mcp.session.validate_owner"));
  }

  private resolveAndStoreSessionMeta(token: McpSessionInit) {
    const self = this;
    return Effect.gen(function* () {
      const resolved = yield* self.resolveSessionMeta(token);
      // Carry the create request's origin onto the persisted meta (the host's
      // resolveSessionMeta is identity-only and doesn't see it), so a cold
      // isolate rebuilds the runtime with the same web base URL.
      const sessionMeta: SessionMeta = {
        ...resolved,
        resource: token.resource,
        ...(token.webOrigin ? { webOrigin: token.webOrigin } : {}),
      };
      yield* Effect.promise(() => self.saveSessionMeta(sessionMeta)).pipe(
        Effect.withSpan("mcp.session.save_meta"),
      );
      return sessionMeta;
    }).pipe(Effect.withSpan("mcp.session.resolve_and_store_meta"));
  }

  async init(token: McpSessionInit, incoming?: IncomingTraceHeaders): Promise<void> {
    const methodEnteredAt = Date.now();
    if (this.initialized) return;
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan(self.entryAttrs(methodEnteredAt));
        yield* self.doInit(token);
      }).pipe(
        Effect.withSpan("McpSessionDO.init", {
          attributes: { "mcp.auth.organization_id": token.organizationId },
        }),
        (eff) => this.withTelemetry(eff, incoming),
        // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: Durable Object init method can only reject its Promise
        Effect.orDie,
        (eff) => self.withSpanFlush(eff),
      ),
    );
  }

  private doInit(token: McpSessionInit) {
    const self = this;
    // Single Effect chain so every sub-span (resolveSessionMeta,
    // createRuntime, createScopedExecutor, createExecutorMcpServer,
    // transport.connect, storage.setAlarm) lands as a child of
    // `McpSessionDO.init`. The prior implementation called
    // `Effect.runPromise` nested inside an async function, which orphaned
    // each sub-span into its own root trace and made init opaque —
    // dashboard saw one 2.77s span with nothing under it.
    return Effect.gen(function* () {
      const sessionMeta = yield* self.resolveAndStoreSessionMeta(token);

      self.dbHandle = yield* self.openSessionDbHandle();
      // POST responses go out as JSON so `transport.handleRequest()` awaits
      // every MCP tool callback before resolving — keeps engine spans inside
      // the outer `handleRequest` Effect's fiber so `currentRequestSpan` is
      // still set when the host-mcp `parentSpan` getter reads it. With SSE
      // POSTs the callback fires after `Effect.ensuring` clears the field
      // and engine spans orphan into new root traces. GET still streams
      // (the GET handler doesn't consult `enableJsonResponse`).
      const runtime = yield* self.createConnectedRuntime(sessionMeta, {
        dbHandle: self.dbHandle,
        enableJsonResponse: true,
      });
      self.mcpServer = runtime.mcpServer;
      self.transport = runtime.transport;
      self.engine = runtime.engine;

      self.initialized = true;
      yield* Effect.promise(() => self.markActivity()).pipe(
        Effect.withSpan("McpSessionDO.markActivity"),
      );
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.gen(function* () {
          console.error("[mcp-session] init failed:", Cause.pretty(cause));
          // Report to the host's error sink (cloud → Sentry). init() runs on
          // the prototype, which Sentry's auto-wrap doesn't cover, so capture
          // here explicitly rather than relying on prototype instrumentation.
          self.captureCause(cause);
          // Annotate `McpSessionDO.init` (the active span here — `doInit` opens
          // none of its own) so the surviving, flushed span names the frame.
          yield* self.recordCauseOnSpan(cause);
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => self.cleanup());
          return yield* Effect.failCause(cause);
        }),
      ),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: doInit is called only from Promise-only Durable Object init
      Effect.orDie,
    );
  }

  async handleRequest(request: Request): Promise<Response> {
    const methodEnteredAt = Date.now();
    // Wrap the dispatch in an Effect span so every DO request — not just
    // the rare new-session `init()` — shows up in Axiom. Basic attributes
    // only (method, session-id presence, response status); rich client
    // fingerprint stays on the edge `mcp.request` span, which shares a
    // trace_id with this one.
    const incoming = {
      traceparent: request.headers.get("traceparent") ?? undefined,
      tracestate: request.headers.get("tracestate") ?? undefined,
      baggage: request.headers.get("baggage") ?? undefined,
    } satisfies IncomingTraceHeaders;
    const self = this;
    const program = Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan(self.entryAttrs(methodEnteredAt));
      // Capture the request-entry span so the host-mcp `parentSpan` getter
      // — fired by deferred MCP SDK callbacks after this Effect has already
      // returned — anchors engine spans under the same trace. Cleared in a
      // finalizer so a future request that arrives without a fresh span
      // doesn't accidentally inherit a stale one.
      const span = yield* Effect.currentSpan;
      self.currentRequestSpan = span;

      return yield* self.dispatchRequest(request).pipe(
        Effect.tap((response) =>
          Effect.annotateCurrentSpan({
            "mcp.response.status_code": response.status,
            "mcp.response.content_type": response.headers.get("content-type") ?? "",
            "mcp.transport.enable_json_response": self.transportJsonResponseMode ?? false,
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            self.currentRequestSpan = null;
          }),
        ),
      );
    }).pipe(
      // Cold-restore failures (`restoreRuntimeFromStorage` is `orDie`'d and is
      // NOT under the handled `dispatchAuthorizedRequest` branch) die straight
      // through here — annotate the handleRequest span with their stack before
      // it ends so the flushed span names the frame.
      Effect.tapCause((cause) => self.recordCauseOnSpan(cause)),
      Effect.withSpan("McpSessionDO.handleRequest", {
        attributes: {
          "mcp.request.method": request.method,
          "mcp.request.session_id_present": !!request.headers.get("mcp-session-id"),
        },
      }),
      (eff) => this.withTelemetry(eff, incoming),
      (eff) => self.withSpanFlush(eff),
    );
    return Effect.runPromise(program);
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

        self.approvalResponses.set(executionId, response);
        yield* Effect.promise(() =>
          self.ctx.storage.put(approvalResponseKey(executionId), response),
        );
        const waiter = self.approvalWaiters.get(executionId);
        if (waiter) yield* Deferred.succeed(waiter, response);
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

  private dispatchRequest(request: Request): Effect.Effect<Response> {
    const self = this;
    return Effect.gen(function* () {
      const ownerError = yield* self.validateSessionOwner(request);
      if (ownerError) return ownerError;
      return yield* self.dispatchAuthorizedRequest(request);
    });
  }

  private dispatchAuthorizedRequest(request: Request): Effect.Effect<Response> {
    if (!this.initialized || !this.transport) {
      if (request.method === "DELETE") {
        return this.clearSessionState().pipe(
          Effect.as(new Response(null, { status: 204 })),
          Effect.withSpan("mcp.session.stale_delete"),
        );
      }
      const self = this;
      return Effect.gen(function* () {
        const restored = yield* self.restoreRuntimeFromStorage(request);
        if (restored === "restored") {
          return yield* self.dispatchAuthorizedRequest(request);
        }
        return jsonRpcError(404, -32001, "Session timed out due to inactivity — please reconnect");
      });
    }

    const self = this;
    return Effect.gen(function* () {
      yield* self.ensureJsonResponseTransportForPost(request);
      const transport = self.transport;
      if (!transport) {
        return jsonRpcError(404, -32001, "Session timed out due to inactivity — please reconnect");
      }

      yield* Effect.promise(() => self.markActivity()).pipe(
        Effect.withSpan("McpSessionDO.markActivity"),
      );
      const response = yield* transport.handleRequest(request).pipe(
        Effect.withSpan("McpSessionDO.transport.handleRequest", {
          attributes: {
            "mcp.request.method": request.method,
            "mcp.request.content_type": request.headers.get("content-type") ?? "",
            "mcp.request.content_length": request.headers.get("content-length") ?? "",
          },
        }),
      );
      yield* Effect.annotateCurrentSpan({
        "mcp.response.status_code": response.status,
        "mcp.response.content_type": response.headers.get("content-type") ?? "",
        "mcp.transport.enable_json_response": self.transportJsonResponseMode ?? false,
      });
      if (request.method === "DELETE") {
        yield* Effect.promise(() => self.cleanup()).pipe(Effect.withSpan("mcp.session.cleanup"));
      }
      return response;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          console.error("[mcp-session] handleRequest error:", Cause.pretty(cause));
          self.captureCause(cause);
          yield* self.recordCauseOnSpan(cause);
          return jsonRpcError(500, -32603, "Internal error");
        }),
      ),
    );
  }

  override async alarm(): Promise<void> {
    const program = Effect.promise(() => this.runAlarm()).pipe(
      Effect.withSpan("McpSessionDO.alarm"),
      (eff) => this.withTelemetry(eff),
      (eff) => this.withSpanFlush(eff),
    );
    return Effect.runPromise(program);
  }

  async clearSession(incoming?: IncomingTraceHeaders): Promise<void> {
    return Effect.runPromise(
      Effect.promise(() => this.cleanup()).pipe(
        Effect.withSpan("McpSessionDO.clearSession"),
        (eff) => this.withTelemetry(eff, incoming),
        (eff) => this.withSpanFlush(eff),
      ),
    );
  }

  private async runAlarm(): Promise<void> {
    const lastActivityMs = await this.loadLastActivity();
    const idleMs = Date.now() - lastActivityMs;
    if (idleMs >= SESSION_TIMEOUT_MS) {
      await Effect.runPromise(this.closeRuntime());
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  private async cleanup(): Promise<void> {
    await Effect.runPromise(this.closeRuntime());
    await Effect.runPromise(this.clearSessionState());
  }
}
