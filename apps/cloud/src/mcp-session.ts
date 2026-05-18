// ---------------------------------------------------------------------------
// MCP Session Durable Object — holds MCP server + engine per session
// ---------------------------------------------------------------------------

import { DurableObject, env } from "cloudflare:workers";
import { createTraceState } from "@opentelemetry/api";
import { Cause, Data, Deferred, Effect, Layer } from "effect";
import * as OtelTracer from "@effect/opentelemetry/Tracer";
import type * as Tracer from "effect/Tracer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TransportState } from "agents/mcp";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import { createExecutorMcpServer } from "@executor-js/host-mcp";
import {
  buildExecuteDescription,
  formatPausedExecution,
  type ExecutionEngine,
  type ResumeResponse,
} from "@executor-js/execution";
import type { DrizzleDb, DbServiceShape } from "./services/db";

// Import directly from core-shared-services, NOT from ./api/layers.ts.
// The full layers module pulls in `auth/handlers.ts` → `@tanstack/react-start/server`,
// which uses a `#tanstack-start-entry` subpath specifier that breaks module
// load under vitest-pool-workers. The DO only needs the core two services
// (WorkOSAuth + AutumnService), so we import them from the tight module.
import { CoreSharedServices } from "./api/core-shared-services";
import { UserStoreService } from "./auth/context";
import { resolveOrganization } from "./auth/resolve-organization";
import { DbService, combinedSchema, resolveConnectionString } from "./services/db";
import { makeExecutionStack } from "./services/execution-stack";
import { makeMcpWorkerTransport, type McpWorkerTransport } from "./services/mcp-worker-transport";
import { DoTelemetryLive } from "./services/telemetry";
import { captureCause } from "./observability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpSessionInit = {
  organizationId: string;
  userId: string;
  elicitationMode?: "browser" | "model" | "native";
  allowModelResume?: boolean;
};

export type IncomingTraceHeaders = {
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
};

export type McpSessionApprovalIdentity = {
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

const HEARTBEAT_MS = 30 * 1000;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const LONG_LIVED_DB_IDLE_TIMEOUT_SECONDS = 5;
const LONG_LIVED_DB_MAX_LIFETIME_SECONDS = 120;
const TRANSPORT_STATE_KEY = "transport";
const SESSION_META_KEY = "session-meta";
const LAST_ACTIVITY_KEY = "last-activity-ms";
const approvalResponseKey = (executionId: string) => `approval-response:${executionId}`;
const INTERNAL_ACCOUNT_ID_HEADER = "x-executor-mcp-account-id";
const INTERNAL_ORGANIZATION_ID_HEADER = "x-executor-mcp-organization-id";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class OrganizationNotFoundError extends Data.TaggedError("OrganizationNotFoundError")<{
  readonly organizationId: string;
}> {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const jsonRpcError = (status: number, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });

const sessionOwnerMismatch = () =>
  jsonRpcError(403, -32003, "MCP session does not belong to the current bearer");

// W3C propagation across the worker→DO boundary. mcp.ts injects the worker's
// `traceparent` and forwards incoming `tracestate` / `baggage` headers on
// forwarded requests (and as a second arg to `init()`). We parse the context
// here and use `OtelTracer.withSpanContext` to stitch the DO's root span
// under the worker span so the entire logical request lives in one trace.
const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

type IncomingSpanContext = {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceState?: ReturnType<typeof createTraceState>;
};

const parseTraceparent = (
  traceparent: string | null | undefined,
  tracestate: string | null | undefined,
): IncomingSpanContext | null => {
  const value = traceparent;
  if (!value) return null;
  const match = TRACEPARENT_PATTERN.exec(value);
  if (!match) return null;
  return {
    traceId: match[2]!,
    spanId: match[3]!,
    traceFlags: parseInt(match[4]!, 16),
    ...(tracestate ? { traceState: createTraceState(tracestate) } : {}),
  };
};

const withIncomingParent = <A, E, R>(
  incoming: IncomingTraceHeaders | null | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const parsed = parseTraceparent(incoming?.traceparent, incoming?.tracestate);
  return parsed ? OtelTracer.withSpanContext(effect, parsed) : effect;
};

type DbHandle = DbServiceShape & { readonly sql: Sql; end: () => Promise<void> };
type SessionMeta = {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly userId: string;
  readonly elicitationMode?: "browser" | "model" | "native";
  readonly allowModelResume?: boolean;
};

/**
 * Base DB handle factory for MCP session runtimes.
 *
 * The DO keeps one postgres.js client for the MCP session runtime. postgres.js
 * closes idle sockets quickly, while the runtime object stays alive so the MCP
 * server can preserve session-local protocol state across requests.
 */
const makeDbHandle = (options: {
  readonly idleTimeout: number;
  readonly maxLifetime: number;
}): DbHandle => {
  const connectionString = resolveConnectionString();
  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: options.idleTimeout,
    max_lifetime: options.maxLifetime,
    connect_timeout: 10,
    fetch_types: false,
    prepare: true,
    onnotice: () => undefined,
  });
  return {
    sql,
    db: drizzle(sql, { schema: combinedSchema }) as DrizzleDb,
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: postgres.js close is best-effort during DO/runtime cleanup
    end: () => sql.end({ timeout: 0 }).catch(() => undefined),
  };
};

const makeLongLivedDb = (): DbHandle =>
  makeDbHandle({
    idleTimeout: LONG_LIVED_DB_IDLE_TIMEOUT_SECONDS,
    maxLifetime: LONG_LIVED_DB_MAX_LIFETIME_SECONDS,
  });

const makeEphemeralDb = (): DbHandle => makeDbHandle({ idleTimeout: 0, maxLifetime: 60 });

const makeResolveOrganizationServices = (dbHandle: DbHandle) => {
  const DbLive = Layer.succeed(DbService)({ sql: dbHandle.sql, db: dbHandle.db });
  const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));
  return Layer.mergeAll(DbLive, UserStoreLive, CoreSharedServices);
};

// Session services DON'T re-provide `DoTelemetryLive` — that would install a
// second WebSdk tracer in the nested Effect scope, disconnecting every
// child span from the outer `McpSessionDO.init` / `McpSessionDO.handleRequest`
// trace. Tracer comes from the outermost `Effect.provide(DoTelemetryLive)`
// at the DO method boundary.
const makeSessionServices = (dbHandle: DbHandle) => makeResolveOrganizationServices(dbHandle);

const resolveSessionMeta = Effect.fn("McpSessionDO.resolveSessionMeta")(function* (
  organizationId: string,
  userId: string,
  elicitationMode: "browser" | "model" | "native",
) {
  const org = yield* resolveOrganization(organizationId);
  if (!org) {
    return yield* new OrganizationNotFoundError({ organizationId });
  }
  return {
    organizationId: org.id,
    organizationName: org.name,
    userId,
    elicitationMode,
  } satisfies SessionMeta;
});

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

export class McpSessionDO extends DurableObject {
  private readonly instanceCreatedAt = Date.now();
  private mcpServer: McpServer | null = null;
  private transport: McpWorkerTransport | null = null;
  private engine: ExecutionEngine<Cause.YieldableError> | null = null;
  private initialized = false;
  private lastActivityMs = 0;
  private dbHandle: DbHandle | null = null;
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
    options: { readonly dbHandle: DbHandle; readonly enableJsonResponse?: boolean },
  ) {
    const self = this;
    return Effect.gen(function* () {
      const { executor, engine } = yield* makeExecutionStack(
        sessionMeta.userId,
        sessionMeta.organizationId,
        sessionMeta.organizationName,
      );
      // Build the description here so the postgres query it runs
      // (`executor.sources.list`) lands as a child of
      // `McpSessionDO.createRuntime`. host-mcp would otherwise call
      // `Effect.runPromise(engine.getDescription)` at its async
      // MCP-SDK boundary and orphan the sub-span.
      const description = yield* buildExecuteDescription(executor);
      const sessionElicitationMode =
        sessionMeta.elicitationMode ?? (sessionMeta.allowModelResume ? "model" : "browser");
      const mcpServer = yield* createExecutorMcpServer({
        engine,
        description,
        parentSpan: () => self.currentRequestSpan ?? undefined,
        debug: env.EXECUTOR_MCP_DEBUG === "true",
        browserApprovalStore: {
          takeResponse: (executionId) => self.takeApprovalResponse(executionId),
          waitForResponse: (executionId) => self.waitForApprovalResponse(executionId),
        },
        elicitationMode:
          sessionElicitationMode === "browser"
            ? {
                mode: "browser" as const,
                approvalUrl: (executionId) => {
                  const origin = env.VITE_PUBLIC_SITE_URL ?? "https://executor.sh";
                  const url = new URL(`/resume/${encodeURIComponent(executionId)}`, origin);
                  url.searchParams.set("mcp_session_id", self.ctx.id.toString());
                  return url.toString();
                },
              }
            : { mode: sessionElicitationMode },
      }).pipe(Effect.withSpan("McpSessionDO.createExecutorMcpServer"));
      const transport = yield* makeMcpWorkerTransport({
        sessionIdGenerator: () => self.ctx.id.toString(),
        storage: self.makeStorage(),
        enableJsonResponse: options.enableJsonResponse,
      });
      self.transportJsonResponseMode = options.enableJsonResponse ?? false;
      yield* transport.connect(mcpServer);
      return { mcpServer, transport, engine };
    }).pipe(
      Effect.withSpan("McpSessionDO.createRuntime"),
      Effect.provide(makeSessionServices(options.dbHandle)),
    );
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
        yield* Effect.promise(() => dbHandle.end());
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
      readonly dbHandle: DbHandle;
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
      const dbHandle = makeLongLivedDb();
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
    identity: McpSessionApprovalIdentity,
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
      const dbHandle = makeLongLivedDb();
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
      const dbHandle = makeLongLivedDb();
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
      const matches =
        accountId === sessionMeta.userId && organizationId === sessionMeta.organizationId;

      yield* Effect.annotateCurrentSpan({
        "mcp.session.owner_match": matches,
      });

      return matches ? null : sessionOwnerMismatch();
    }).pipe(Effect.withSpan("mcp.session.validate_owner"));
  }

  private resolveAndStoreSessionMeta(token: McpSessionInit) {
    const self = this;
    return Effect.gen(function* () {
      const dbHandle = makeEphemeralDb();
      return yield* resolveSessionMeta(
        token.organizationId,
        token.userId,
        token.elicitationMode ?? (token.allowModelResume ? "model" : "browser"),
      ).pipe(
        Effect.provide(makeResolveOrganizationServices(dbHandle)),
        Effect.tap((sessionMeta) =>
          Effect.promise(() => self.saveSessionMeta(sessionMeta)).pipe(
            Effect.withSpan("mcp.session.save_meta"),
          ),
        ),
        Effect.ensuring(Effect.promise(() => dbHandle.end())),
      );
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
        (eff) => withIncomingParent(incoming, eff),
        Effect.provide(DoTelemetryLive),
        // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: Durable Object init method can only reject its Promise
        Effect.orDie,
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

      self.dbHandle = makeLongLivedDb();
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
        Effect.sync(() => {
          console.error("[mcp-session] init failed:", cause);
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
      Effect.withSpan("McpSessionDO.handleRequest", {
        attributes: {
          "mcp.request.method": request.method,
          "mcp.request.session_id_present": !!request.headers.get("mcp-session-id"),
        },
      }),
      (eff) => withIncomingParent(incoming, eff),
      Effect.provide(DoTelemetryLive),
    );
    return Effect.runPromise(program);
  }

  async getPausedExecutionForApproval(
    executionId: string,
    identity: McpSessionApprovalIdentity,
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
        (eff) => withIncomingParent(incoming, eff),
        Effect.provide(DoTelemetryLive),
        // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: DO RPC exposes Promise results
        Effect.orDie,
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
    identity: McpSessionApprovalIdentity,
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
        (eff) => withIncomingParent(incoming, eff),
        Effect.provide(DoTelemetryLive),
        // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: DO RPC exposes Promise results
        Effect.orDie,
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
        Effect.sync(() => {
          console.error("[mcp-session] handleRequest error:", Cause.pretty(cause));
          captureCause(cause);
          return jsonRpcError(500, -32603, "Internal error");
        }),
      ),
    );
  }

  async alarm(): Promise<void> {
    const program = Effect.promise(() => this.runAlarm()).pipe(
      Effect.withSpan("McpSessionDO.alarm"),
      Effect.provide(DoTelemetryLive),
    );
    return Effect.runPromise(program);
  }

  async clearSession(incoming?: IncomingTraceHeaders): Promise<void> {
    return Effect.runPromise(
      Effect.promise(() => this.cleanup()).pipe(
        Effect.withSpan("McpSessionDO.clearSession"),
        (eff) => withIncomingParent(incoming, eff),
        Effect.provide(DoTelemetryLive),
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
