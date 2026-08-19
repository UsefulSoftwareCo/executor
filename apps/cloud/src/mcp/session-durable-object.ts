// ---------------------------------------------------------------------------
// Cloud MCP Session Durable Object — the cloud binding of the shared
// `McpAgentSessionDOBase` (@executor-js/cloudflare). Direct HTTP transport
// serving, cold restore, the inactivity alarm, owner validation, browser
// approval storage, and the per-request span bridge live in the base. Cloud
// supplies ONLY its injected dependencies:
//   - openSessionDb     → a long-lived postgres.js handle
//   - resolveSessionMeta → WorkOS/UserStore organization resolution
//   - buildMcpServer    → the cloud execution stack + MCP tool server
//   - withTelemetry     → the WebSdk tracer + W3C parent-span stitching
//   - captureCause      → Sentry error capture
// host-cloudflare binds the same base to D1 instead; the two stay byte-identical
// except for these seams.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Data, Effect, Layer } from "effect";
import type { Cause } from "effect";
import type * as Tracer from "effect/Tracer";
import * as OtelTracer from "@effect/opentelemetry/Tracer";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import {
  PAUSED_APPROVAL_TIMEOUT_MS,
  buildMcpServer,
  mcpRequestStatePrincipal,
  type PausedExecutionHooks,
  type ResumeFallbackOutcome,
} from "@executor-js/host-mcp/tool-server";
import type { McpModernServerBuilder, Principal } from "@executor-js/host-mcp";
import { buildResumeApprovalUrl } from "@executor-js/host-mcp/browser-approval";
import { artifactUrlFor } from "@executor-js/host-mcp/create-artifact";
import { makeAssetsShellHtmlLoader } from "@executor-js/mcp-apps-shell/worker";
import { smokeRenderArtifact } from "@executor-js/mcp-apps-shell/smoke-render";
import {
  McpAgentSessionDOBase,
  type BuiltMcpServer,
  type BuiltModernMcpRuntime,
  type IncomingTraceHeaders,
  type McpApprovalOwner,
  type McpSessionModelResumeResult,
  type McpSessionInit,
  type SessionMeta,
} from "@executor-js/cloudflare/mcp/agent-durable-object";
import { requireMcpRequestStateKey } from "@executor-js/cloudflare/mcp/modern-request-router";
import {
  mcpExecutionOwnerDirectoryFromNamespace,
  type McpExecutionOwnerDirectory,
  type McpExecutionOwnerRoute,
} from "@executor-js/cloudflare/mcp/execution-owner-directory";
import { mcpSessionStubForOwner } from "@executor-js/cloudflare/mcp/session-stub";
import { buildExecuteDescription, type ResumeResponse } from "@executor-js/execution";

// The DO meters executions just like the HTTP `/api/*` plane: it builds its
// engine with `CloudMeteredExecutionStackLayer`, so every MCP execution is
// tracked to Autumn (the MCP server is the primary execution surface, so leaving
// it unmetered silently dropped the bulk of real usage). The billing service
// (`AutumnService.Default`) is provided LOCALLY to the metered stack below, so
// the DO still imports the focused `CoreSharedServices` root (beside
// `WorkOSClient`), NOT `../api/layers`, and its bundle stays free of the whole
// HTTP API assembly. (This used to require a dedicated `core-shared-services.ts`
// leaf to keep `auth/handlers.ts` -> `@tanstack/react-start` out of the DO
// bundle; that coupling is gone now that `handlers.ts` queues cookies through
// `SessionAuthLive` instead.)
import { CoreSharedServices } from "../auth/workos";
import { UserStoreService } from "../auth/context";
import { resolveOrganization } from "../auth/organization";
import {
  DbService,
  combinedSchema,
  resolveConnectionString,
  type DrizzleDb,
  type DbServiceShape,
} from "../db/db";
import { makeExecutionStack } from "../engine/execution-stack";
import { preloadQuickJs } from "../quickjs";
import { CloudMeteredExecutionStackLayer } from "../engine/execution-stack-metered";
import { AutumnService } from "../extensions/billing/service";
import { DoTelemetryLive, flushTracerProvider } from "../observability/telemetry";
import {
  captureCause as reportCause,
  captureCauseEffect as reportCauseEffect,
  tagCurrentSentryScopeWithCurrentOtelSpan,
} from "../observability";
import { parseTraceparent } from "./traceparent";

// Re-export the shared types so existing cloud importers
// (`auth/handlers.ts`, etc.) keep their `../mcp/session-durable-object` path.
export type {
  McpApprovalOwner,
  McpSessionApprovalResult,
  McpSessionModelResumeResult,
  McpSessionResumeApprovalResult,
  McpSessionInit,
  IncomingTraceHeaders,
} from "@executor-js/cloudflare/mcp/agent-durable-object";

// ---------------------------------------------------------------------------
// Cloud DB handle — one postgres.js client per session runtime
// ---------------------------------------------------------------------------

const LONG_LIVED_DB_IDLE_TIMEOUT_SECONDS = 5;
const LONG_LIVED_DB_MAX_LIFETIME_SECONDS = 120;
const TELEMETRY_FLUSH_TIMEOUT_MS = 1_000;

const positiveMilliseconds = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
};

type CloudSessionDbHandle = DbServiceShape & {
  readonly sql: Sql;
  readonly end: () => Promise<void>;
};

class OrganizationNotFoundError extends Data.TaggedError("OrganizationNotFoundError")<{
  readonly organizationId: string;
}> {}

class McpModelResumeForwardError extends Data.TaggedError("McpModelResumeForwardError")<{
  readonly cause: unknown;
}> {}

class CloudModernMcpBuildError extends Data.TaggedError("CloudModernMcpBuildError")<{
  readonly cause: unknown;
}> {}

/**
 * The DO keeps one postgres.js client for the MCP session runtime. postgres.js
 * closes idle sockets quickly, while the runtime object stays alive so the MCP
 * server can preserve session-local protocol state across requests.
 */
const makeDbHandle = (options: {
  readonly idleTimeout: number;
  readonly maxLifetime: number;
}): CloudSessionDbHandle => {
  const sql = postgres(resolveConnectionString(), {
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

const makeEphemeralDb = (): CloudSessionDbHandle =>
  makeDbHandle({ idleTimeout: 0, maxLifetime: 60 });

// The org-resolution + session-runtime services. They DON'T re-provide
// `DoTelemetryLive` — that would install a second WebSdk tracer in the nested
// Effect scope, disconnecting every child span from the outer DO-method trace.
// Tracer comes from the outermost `withTelemetry` at the DO method boundary.
const makeSessionServices = (dbHandle: CloudSessionDbHandle) => {
  const DbLive = Layer.succeed(DbService)({ sql: dbHandle.sql, db: dbHandle.db });
  const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));
  return Layer.mergeAll(DbLive, UserStoreLive, CoreSharedServices);
};

// The `ui://executor/shell.html` resource, over the ASSETS binding: the
// deployed Worker has no filesystem, so the document is the stable-named
// asset the client build emitted (`mcpAppsShellAsset`), fetched at first
// artifact resource read. Module scope so the fetch-and-verify happens once
// per isolate, not once per session. The dev thunk carries the built shell
// inline under `vite dev`, where no assets exist yet for the binding to find.
const loadAppShellHtml = makeAssetsShellHtmlLoader({
  assets: env.ASSETS,
  devShellHtml: () =>
    import("virtual:executor-mcp-apps-shell-dev-html").then((mod) => mod.devShellHtml),
});

const resolveCloudSessionMeta = (token: McpSessionInit, dbHandle: CloudSessionDbHandle) =>
  Effect.gen(function* () {
    const org = yield* resolveOrganization(token.organizationId);
    if (!org) {
      return yield* new OrganizationNotFoundError({ organizationId: token.organizationId });
    }
    return {
      organizationId: org.id,
      organizationName: org.name,
      organizationSlug: org.slug,
      userId: token.userId,
      resource: token.resource,
      elicitationMode: token.elicitationMode,
      artifactsEnabled: token.artifactsEnabled,
      webOrigin: token.webOrigin,
    } satisfies SessionMeta;
  }).pipe(Effect.provide(makeSessionServices(dbHandle)));

const makeCloudExecutionRuntime = (sessionMeta: SessionMeta, dbHandle: CloudSessionDbHandle) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => preloadQuickJs());
    const { executor, engine } = yield* makeExecutionStack(
      sessionMeta.userId,
      sessionMeta.organizationId,
      sessionMeta.organizationName,
      { mcpResource: sessionMeta.resource },
    ).pipe(
      Effect.provide(CloudMeteredExecutionStackLayer.pipe(Layer.provide(AutumnService.Default))),
      Effect.withSpan("McpSessionDOSqlite.makeExecutionStack"),
    );
    const description = yield* buildExecuteDescription(executor).pipe(
      Effect.withSpan("mcp.execute.description.build"),
    );
    return { executor, engine, description };
  }).pipe(Effect.provide(makeSessionServices(dbHandle)));

type CloudExecutionRuntime = Effect.Success<ReturnType<typeof makeCloudExecutionRuntime>>;

type CloudModernLifecycle = {
  readonly pausedExecutionHooks?: PausedExecutionHooks;
  readonly resumeFallback?: (
    executionId: string,
    response: ResumeResponse,
  ) => Effect.Effect<ResumeFallbackOutcome | null, unknown>;
  readonly parentSpan?: () => Tracer.AnySpan | undefined;
};

const makeCloudModernRuntime = (
  sessionMeta: SessionMeta,
  runtime: CloudExecutionRuntime,
  lifecycle: CloudModernLifecycle = {},
): BuiltModernMcpRuntime => ({
  engine: runtime.engine,
  buildServer: (options) =>
    buildMcpServer({
      engine: runtime.engine,
      description: runtime.description,
      artifacts: runtime.executor.artifacts,
      connections: runtime.executor.connections,
      artifactsEnabled: sessionMeta.artifactsEnabled ?? true,
      loadAppShellHtml,
      smokeRenderArtifact,
      artifactUrl: artifactUrlFor(
        env.VITE_PUBLIC_SITE_URL ?? "https://executor.sh",
        sessionMeta.organizationSlug,
      ),
      debug: env.EXECUTOR_MCP_DEBUG === "true",
      elicitationMode: { mode: "native" },
      ...(lifecycle.parentSpan ? { parentSpan: lifecycle.parentSpan } : {}),
      ...(lifecycle.pausedExecutionHooks
        ? {
            pausedExecutionHooks: lifecycle.pausedExecutionHooks,
            pausedExecutionLeaseMs: PAUSED_APPROVAL_TIMEOUT_MS,
          }
        : {}),
      ...(lifecycle.resumeFallback ? { resumeFallback: lifecycle.resumeFallback } : {}),
      ...options,
    }),
});

const closeModernServerWithDb = <Server extends { close: () => Promise<void> }>(
  server: Server,
  dbHandle: CloudSessionDbHandle,
): Server => {
  const closeServer = server.close.bind(server);
  server.close = () =>
    Effect.runPromise(
      Effect.promise(closeServer).pipe(Effect.ensuring(Effect.promise(() => dbHandle.end()))),
    );
  return server;
};

/** Build one worker-side stateless MCP server over a fresh cloud runtime. */
export const makeCloudModernMcpServerBuilder = (
  session: McpSessionInit,
): McpModernServerBuilder["Service"] => ({
  build: (principal: Principal, options) => {
    const dbHandle = makeEphemeralDb();
    const { resource, ...requestOptions } = options;
    const token: McpSessionInit = {
      ...session,
      userId: principal.accountId,
      organizationId: principal.organizationId,
      resource,
    };
    return resolveCloudSessionMeta(token, dbHandle).pipe(
      Effect.flatMap((sessionMeta) =>
        makeCloudExecutionRuntime(sessionMeta, dbHandle).pipe(
          Effect.map((runtime) => ({ runtime, sessionMeta })),
        ),
      ),
      Effect.flatMap(({ runtime, sessionMeta }) =>
        makeCloudModernRuntime(sessionMeta, runtime).buildServer(requestOptions),
      ),
      Effect.map((server) => closeModernServerWithDb(server, dbHandle)),
      Effect.tapCause(() => Effect.promise(() => dbHandle.end())),
      Effect.mapError((cause) => new CloudModernMcpBuildError({ cause })),
    );
  },
});

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

export class McpSessionDOSqlite extends McpAgentSessionDOBase<Env, CloudSessionDbHandle> {
  protected override sessionTimeoutMs(): number {
    return positiveMilliseconds(env.MCP_SESSION_TIMEOUT_MS) ?? super.sessionTimeoutMs();
  }

  protected override maxPausedSessionIdleMs(): number {
    return (
      positiveMilliseconds(env.MCP_PAUSED_SESSION_IDLE_TIMEOUT_MS) ?? super.maxPausedSessionIdleMs()
    );
  }

  protected override executionOwnerDirectory(): McpExecutionOwnerDirectory | null {
    return mcpExecutionOwnerDirectoryFromNamespace(env.MCP_EXECUTION_OWNER);
  }

  protected override forwardModelResumeToOwner(
    owner: McpExecutionOwnerRoute,
    identity: McpApprovalOwner,
    executionId: string,
    response: ResumeResponse,
  ): Effect.Effect<McpSessionModelResumeResult, unknown> {
    const ownerSession = mcpSessionStubForOwner(env.MCP_SESSION, owner);
    if (!ownerSession) {
      return Effect.succeed({ status: "execution_expired", ttlMs: PAUSED_APPROVAL_TIMEOUT_MS });
    }
    return Effect.tryPromise({
      try: () => ownerSession.resumeExecutionForModel(executionId, identity, response),
      catch: (cause) => new McpModelResumeForwardError({ cause }),
    });
  }

  protected override openSessionDb(): CloudSessionDbHandle {
    return makeDbHandle({
      idleTimeout: LONG_LIVED_DB_IDLE_TIMEOUT_SECONDS,
      maxLifetime: LONG_LIVED_DB_MAX_LIFETIME_SECONDS,
    });
  }

  protected override resolveSessionMeta(token: McpSessionInit): Effect.Effect<SessionMeta> {
    const dbHandle = makeEphemeralDb();
    return resolveCloudSessionMeta(token, dbHandle).pipe(
      Effect.withSpan("McpSessionDOSqlite.resolveSessionMeta"),
      Effect.ensuring(Effect.promise(() => dbHandle.end())),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: a vanished org is a defect; the worker already verified the bearer
      Effect.orDie,
    );
  }

  protected override buildMcpServer(
    sessionMeta: SessionMeta,
    dbHandle: CloudSessionDbHandle,
  ): Effect.Effect<BuiltMcpServer> {
    const self = this;
    return Effect.gen(function* () {
      const runtime = yield* makeCloudExecutionRuntime(sessionMeta, dbHandle);
      const { executor, engine, description } = runtime;
      const modernRuntime = makeCloudModernRuntime(sessionMeta, runtime, {
        pausedExecutionHooks: self.modernPausedExecutionHooks,
        resumeFallback: self.modernModelResumeFallback,
        parentSpan: () => self.currentParentSpan(),
      });
      const sessionElicitationMode = sessionMeta.elicitationMode ?? "model";
      const mcpServer = yield* buildMcpServer({
        engine,
        description,
        artifacts: executor.artifacts,
        connections: executor.connections,
        // Artifacts are on by default, opt-out per connection. A session
        // persisted without a value restores to the default, same as a fresh
        // connection whose URL says nothing about `?artifacts=`.
        artifactsEnabled: sessionMeta.artifactsEnabled ?? true,
        // Cold restores rebuild this server with no `initialize` to replay, so
        // the negotiated apps support comes back from storage instead.
        restoredAppsEnabled: sessionMeta.appsEnabled ?? false,
        onAppsEnabledChange: (appsEnabled) => self.persistAppsEnabled(appsEnabled),
        // Same restore contract for the client identity that keys the
        // `mcp.client.*` span attribution on execution spans.
        ...(sessionMeta.clientInfo ? { restoredClientInfo: sessionMeta.clientInfo } : {}),
        onClientInfoChange: (clientInfo) => self.persistClientInfo(clientInfo),
        appsEnabled: false,
        sessionful: true,
        requestStateSigningKey: self.modernRequestStateSigningKey(),
        requestStatePrincipal: mcpRequestStatePrincipal({
          accountId: sessionMeta.userId,
          organizationId: sessionMeta.organizationId,
        }),
        loadAppShellHtml,
        smokeRenderArtifact,
        artifactUrl: artifactUrlFor(
          env.VITE_PUBLIC_SITE_URL ?? "https://executor.sh",
          sessionMeta.organizationSlug,
        ),
        parentSpan: () => self.currentParentSpan(),
        debug: env.EXECUTOR_MCP_DEBUG === "true",
        browserApprovalStore: self.browserApprovalStore,
        pausedExecutionHooks: self.pausedExecutionHooks,
        pausedExecutionLeaseMs: PAUSED_APPROVAL_TIMEOUT_MS,
        resumeFallback: self.modelResumeFallback,
        elicitationMode:
          sessionElicitationMode === "browser"
            ? {
                mode: "browser" as const,
                approvalUrl: (executionId) =>
                  buildResumeApprovalUrl({
                    origin: env.VITE_PUBLIC_SITE_URL ?? "https://executor.sh",
                    executionId,
                    sessionId: self.sessionId,
                    organizationSlug: sessionMeta.organizationSlug,
                  }),
              }
            : { mode: sessionElicitationMode },
      }).pipe(Effect.withSpan("McpSessionDOSqlite.buildMcpServer"));
      return { mcpServer, engine, modernRuntime } satisfies BuiltMcpServer;
    }).pipe(
      Effect.withSpan("McpSessionDOSqlite.buildMcpServer"),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: runtime-build failures surface as the base's tapCause/cleanup defect
      Effect.orDie,
    );
  }

  protected override buildModernMcpRuntime(
    sessionMeta: SessionMeta,
    dbHandle: CloudSessionDbHandle,
  ): Effect.Effect<BuiltModernMcpRuntime> {
    const self = this;
    return makeCloudExecutionRuntime(sessionMeta, dbHandle).pipe(
      Effect.map((runtime) =>
        makeCloudModernRuntime(sessionMeta, runtime, {
          pausedExecutionHooks: self.modernPausedExecutionHooks,
          resumeFallback: self.modernModelResumeFallback,
          parentSpan: () => self.currentParentSpan(),
        }),
      ),
      Effect.withSpan("McpSessionDOSqlite.buildModernMcpRuntime"),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: runtime-build failures surface through the base RPC cleanup path
      Effect.orDie,
    );
  }

  protected override modernRequestStateSigningKey(): string {
    return requireMcpRequestStateKey(env.MCP_REQUEST_STATE_KEY);
  }

  protected override withTelemetry<A, E>(
    effect: Effect.Effect<A, E>,
    incoming?: IncomingTraceHeaders,
  ): Effect.Effect<A, E> {
    const parsed = parseTraceparent(incoming?.traceparent, incoming?.tracestate);
    const traced = parsed ? OtelTracer.withSpanContext(effect, parsed) : effect;
    return traced.pipe(Effect.provide(DoTelemetryLive));
  }

  protected override captureCause(cause: Cause.Cause<unknown>): void {
    reportCause(cause);
  }

  protected override captureCauseEffect(
    cause: Cause.Cause<unknown>,
  ): Effect.Effect<string | undefined> {
    return reportCauseEffect(cause);
  }

  protected override prepareErrorCaptureScope(): Effect.Effect<void> {
    return Effect.asVoid(tagCurrentSentryScopeWithCurrentOtelSpan);
  }

  // Best-effort export the DO isolate's buffered spans after the RPC settles,
  // so a dying init/handleRequest can ship its own spans (and the exception +
  // stack recorded on them) — not just the worker-side `mcp.do.*` span. Keep it
  // off the response path and bounded: telemetry export must not hold a
  // successful MCP response open.
  protected override flushTelemetry(): Promise<void> {
    this.ctx.waitUntil(
      Effect.runPromise(
        Effect.tryPromise({
          try: () => flushTracerProvider(),
          catch: () => undefined,
        }).pipe(
          Effect.ignore,
          Effect.timeoutOrElse({
            duration: `${TELEMETRY_FLUSH_TIMEOUT_MS} millis`,
            orElse: () => Effect.void,
          }),
        ),
      ),
    );
    return Promise.resolve();
  }
}
