// ---------------------------------------------------------------------------
// Cloud MCP Session Durable Object — the cloud binding of the shared
// `McpSessionDOBase` (@executor-js/cloudflare). All session lifecycle (cold
// restore, the inactivity alarm, owner validation, transport upgrade, the
// browser-approval store, the per-request span bridge) lives in the base; cloud
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
import { createTraceState } from "@opentelemetry/api";
import { Data, Effect, Layer } from "effect";
import type { Cause } from "effect";
import * as OtelTracer from "@effect/opentelemetry/Tracer";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import { createExecutorMcpServer } from "@executor-js/host-mcp/tool-server";
import { buildExecuteDescription } from "@executor-js/execution";
import {
  McpSessionDOBase,
  type BuiltMcpServer,
  type IncomingTraceHeaders,
  type McpSessionInit,
  type SessionMeta,
} from "@executor-js/cloudflare/mcp/durable-object";

// The DO only needs the neutral boot-scoped service (WorkOSClient). It never
// bills, so it does NOT depend on any billing service — `CloudExecutionStackLayer`
// here is the no-op-decorator (Autumn-free) stack. It imports the focused
// `CoreSharedServices` root (beside `WorkOSClient`), NOT `../api/layers`, so the
// DO bundle stays small and free of the whole HTTP API assembly. (This used to
// require a dedicated `core-shared-services.ts` leaf to keep `auth/handlers.ts` →
// `@tanstack/react-start` out of the DO bundle; that coupling is gone now that
// `handlers.ts` queues cookies through `SessionAuthLive` instead.)
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
import { CloudExecutionStackLayer, makeExecutionStack } from "../engine/execution-stack";
import { DoTelemetryLive, flushTracerProvider } from "../observability/telemetry";
import { captureCause as reportCause } from "../observability";

// Re-export the shared types so existing cloud importers
// (`auth/handlers.ts`, etc.) keep their `../mcp/session-durable-object` path.
export type {
  McpApprovalOwner,
  McpSessionApprovalResult,
  McpSessionResumeApprovalResult,
  McpSessionInit,
  IncomingTraceHeaders,
} from "@executor-js/cloudflare/mcp/durable-object";

// ---------------------------------------------------------------------------
// Cloud DB handle — one postgres.js client per session runtime
// ---------------------------------------------------------------------------

const LONG_LIVED_DB_IDLE_TIMEOUT_SECONDS = 5;
const LONG_LIVED_DB_MAX_LIFETIME_SECONDS = 120;
const TELEMETRY_FLUSH_TIMEOUT_MS = 1_000;

type CloudSessionDbHandle = DbServiceShape & {
  readonly sql: Sql;
  readonly end: () => Promise<void>;
};

class OrganizationNotFoundError extends Data.TaggedError("OrganizationNotFoundError")<{
  readonly organizationId: string;
}> {}

// W3C propagation across the worker→DO boundary. The worker injects its
// `traceparent` and forwards incoming `tracestate` / `baggage`; we parse the
// context and use `OtelTracer.withSpanContext` to stitch the DO's root span
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
  if (!traceparent) return null;
  const match = TRACEPARENT_PATTERN.exec(traceparent);
  if (!match) return null;
  return {
    traceId: match[2]!,
    spanId: match[3]!,
    traceFlags: parseInt(match[4]!, 16),
    ...(tracestate ? { traceState: createTraceState(tracestate) } : {}),
  };
};

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

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

export class McpSessionDO extends McpSessionDOBase<CloudSessionDbHandle> {
  protected override openSessionDb(): CloudSessionDbHandle {
    return makeDbHandle({
      idleTimeout: LONG_LIVED_DB_IDLE_TIMEOUT_SECONDS,
      maxLifetime: LONG_LIVED_DB_MAX_LIFETIME_SECONDS,
    });
  }

  protected override resolveSessionMeta(token: McpSessionInit): Effect.Effect<SessionMeta> {
    const dbHandle = makeEphemeralDb();
    return Effect.gen(function* () {
      const org = yield* resolveOrganization(token.organizationId);
      if (!org) {
        return yield* new OrganizationNotFoundError({ organizationId: token.organizationId });
      }
      return {
        organizationId: org.id,
        organizationName: org.name,
        userId: token.userId,
        elicitationMode: token.elicitationMode,
      } satisfies SessionMeta;
    }).pipe(
      Effect.withSpan("McpSessionDO.resolveSessionMeta"),
      Effect.provide(makeSessionServices(dbHandle)),
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
      const { executor, engine } = yield* makeExecutionStack(
        sessionMeta.userId,
        sessionMeta.organizationId,
        sessionMeta.organizationName,
      ).pipe(
        Effect.provide(CloudExecutionStackLayer),
        Effect.withSpan("McpSessionDO.makeExecutionStack"),
      );
      // Build the description here so the postgres query it runs
      // (`executor.integrations.list`) lands as a child of `McpSessionDO.createRuntime`.
      // It also tags the span with this org's integration/connection inventory
      // (slugs, kinds, plugin ids, connection counts) — see `buildExecuteDescription`
      // — so a failing init names *what* it was resolving without re-listing.
      // host-mcp would otherwise call `Effect.runPromise(engine.getDescription)`
      // at its async MCP-SDK boundary and orphan the sub-span.
      const description = yield* buildExecuteDescription(executor);
      const sessionElicitationMode = sessionMeta.elicitationMode ?? "model";
      const mcpServer = yield* createExecutorMcpServer({
        engine,
        description,
        parentSpan: () => self.currentParentSpan(),
        debug: env.EXECUTOR_MCP_DEBUG === "true",
        browserApprovalStore: self.browserApprovalStore,
        elicitationMode:
          sessionElicitationMode === "browser"
            ? {
                mode: "browser" as const,
                approvalUrl: (executionId) => {
                  const origin = env.VITE_PUBLIC_SITE_URL ?? "https://executor.sh";
                  const url = new URL(`/resume/${encodeURIComponent(executionId)}`, origin);
                  url.searchParams.set("mcp_session_id", self.sessionId);
                  return url.toString();
                },
              }
            : { mode: sessionElicitationMode },
      }).pipe(Effect.withSpan("McpSessionDO.createExecutorMcpServer"));
      return { mcpServer, engine } satisfies BuiltMcpServer;
    }).pipe(
      Effect.withSpan("McpSessionDO.buildMcpServer"),
      Effect.provide(makeSessionServices(dbHandle)),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: runtime-build failures surface as the base's tapCause/cleanup defect
      Effect.orDie,
    );
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
