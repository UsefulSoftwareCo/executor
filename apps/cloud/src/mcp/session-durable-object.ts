// ---------------------------------------------------------------------------
// Cloud MCP Session Durable Object — the cloud binding of the shared
// `McpAgentSessionDOBase` (@executor-js/cloudflare). Hibernatable transport
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
import * as OtelTracer from "@effect/opentelemetry/Tracer";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import {
  PAUSED_APPROVAL_TIMEOUT_MS,
  createExecutorMcpServer,
} from "@executor-js/host-mcp/tool-server";
import { buildResumeApprovalUrl } from "@executor-js/host-mcp/browser-approval";
import { artifactUrlFor } from "@executor-js/host-mcp/create-artifact";
import { makeAssetsShellHtmlLoader } from "@executor-js/mcp-apps-shell/worker";
import { smokeRenderArtifact } from "@executor-js/mcp-apps-shell/smoke-render";
import {
  McpAgentSessionDOBase,
  type BuiltMcpServer,
  type IncomingTraceHeaders,
  type McpApprovalOwner,
  type McpSessionModelResumeResult,
  type McpSessionInit,
  type SessionMeta,
} from "@executor-js/cloudflare/mcp/agent-durable-object";
import {
  mcpExecutionOwnerDirectoryFromNamespace,
  type McpExecutionOwnerDirectory,
  type McpExecutionOwnerRoute,
} from "@executor-js/cloudflare/mcp/execution-owner-directory";
import { mcpSessionStub } from "@executor-js/cloudflare/mcp/session-stub";
import {
  buildExecuteDescription,
  parseIntegrationInventory,
  type ResumeResponse,
} from "@executor-js/execution";
import { acquireBuildSlot, type BuildSlotHandle } from "./session-build-semaphore";

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
import { resolveSessionMetaForToken } from "./session-meta";
import {
  DbService,
  combinedSchema,
  resolveConnectionString,
  type DrizzleDb,
  type DbServiceShape,
} from "../db/db";
import { AutumnService } from "../extensions/billing/service";
import { DoTelemetryLive, flushTracerProvider } from "../observability/telemetry";
import {
  captureCause as reportCause,
  captureCauseEffect as reportCauseEffect,
  claimCauseHandledByDurableObject,
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

class McpModelResumeForwardError extends Data.TaggedError("McpModelResumeForwardError")<{
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

// QuickJS-WASM must be loaded before the smoke render asks for a sandbox: the
// default variant cannot fetch its own `.wasm` on Workers. `../quickjs` is
// imported dynamically here, not at module scope, so a session that never
// calls create_artifact/edit_artifact never pays for it — see the comment on
// the dynamic import block in `buildMcpServer` for why that matters on a cold
// isolate. `preloadQuickJs()` itself is memoized per isolate (and resets on
// failure), so concurrent artifact calls, and repeat calls after the first,
// are all free past the first successful load.
const smokeRenderArtifactAfterQuickJsPreload: typeof smokeRenderArtifact = async (code) => {
  const { preloadQuickJs } = await import("../quickjs");
  await preloadQuickJs();
  return smokeRenderArtifact(code);
};

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

export class McpSessionDOSqlite extends McpAgentSessionDOBase<Env, CloudSessionDbHandle> {
  // Set once per `buildMcpServer` call, read back by `sessionFootprintAttributes`
  // so the counts land on the base's `McpSessionDO.init` span alongside
  // `mcp.isolate.*` residency — see the comment at the `parseIntegrationInventory`
  // call site below for why this is free to compute.
  private lastSessionFootprint: Record<string, number> = {};

  protected override sessionFootprintAttributes(): Record<string, number> {
    return this.lastSessionFootprint;
  }

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
    return Effect.tryPromise({
      try: () =>
        mcpSessionStub(env.MCP_SESSION, owner.sessionId).resumeExecutionForModel(
          executionId,
          identity,
          response,
        ),
      catch: (cause) => new McpModelResumeForwardError({ cause }),
    });
  }

  protected override openSessionDb(): CloudSessionDbHandle {
    return makeDbHandle({
      idleTimeout: LONG_LIVED_DB_IDLE_TIMEOUT_SECONDS,
      maxLifetime: LONG_LIVED_DB_MAX_LIFETIME_SECONDS,
    });
  }

  protected override resolveSessionMeta(
    token: McpSessionInit,
    storedMeta: SessionMeta | null,
  ): Effect.Effect<SessionMeta> {
    // The database handle is opened LAZILY: on the props and stored paths — the
    // overwhelming majority of inits — nothing here touches Postgres at all,
    // which is the whole point. postgres.js only dials on first query, so
    // building the handle costs nothing; `ensuring` still closes it.
    const dbHandle = makeEphemeralDb();
    return resolveSessionMetaForToken(token, storedMeta).pipe(
      Effect.withSpan("McpSessionDOSqlite.resolveSessionMeta"),
      Effect.provide(makeSessionServices(dbHandle)),
      Effect.ensuring(Effect.promise(() => dbHandle.end())),
      // The base's `resolveSessionMeta` seam has no error channel, and a
      // Durable Object's `init` can only reject its Promise — so a failure has
      // to leave as a defect. What changed is WHAT leaves: an unreachable
      // organization directory is now a bounded, classified
      // `McpSessionMetaUnavailableError` whose message the worker recognises
      // and renders as a retryable 503 (see `agent-handler.ts`), instead of an
      // unclassified Postgres cause that produced a 500 and a client hang.
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: the DO init seam is Promise-only; the failure is classified before it dies
      Effect.orDie,
    );
  }

  protected override buildMcpServer(
    sessionMeta: SessionMeta,
    dbHandle: CloudSessionDbHandle,
  ): Effect.Effect<BuiltMcpServer> {
    const self = this;
    // Set synchronously, inside the `Effect.promise` executor below, before
    // any `await` — so there is no window where interruption can land after
    // the handle exists but before this is assigned. `cancel` is idempotent
    // (see `session-build-semaphore.ts`), so it is safe to invoke from both
    // the abort listener below AND the `Effect.ensuring` finalizer without
    // risking a double release.
    let buildSlot: BuildSlotHandle | undefined;
    const build = Effect.gen(function* () {
      // A burst of cold sessions landing on one isolate at once used to pay
      // full concurrent build cost; this bounds it to `MAX_CONCURRENT_BUILDS`
      // at a time and queues the rest FIFO, degrading to old concurrent
      // behavior (see `timedOut` below) rather than stalling if the queue
      // itself gets stuck. See `session-build-semaphore.ts`.
      //
      // `Effect.promise` hands its executor an `AbortSignal` tied to this
      // fiber's own interruption — firing it (rather than merely walking
      // away) is what lets a waiter still sitting in the semaphore's queue
      // be dequeued immediately on a client disconnect, instead of getting
      // granted a slot later with no one left to release it.
      const slot = yield* Effect.promise((signal) => {
        const handle = acquireBuildSlot();
        buildSlot = handle;
        signal.addEventListener("abort", () => handle.cancel(), { once: true });
        return handle.promise;
      });
      if (slot.timedOut) {
        yield* Effect.annotateCurrentSpan({ "mcp.init.build_queue_timeout": true });
      } else if (slot.waitMs > 0) {
        yield* Effect.annotateCurrentSpan({ "mcp.init.build_queue_ms": slot.waitMs });
      }

      // Imported here rather than at module scope. Cloudflare requires a
      // Durable Object class to be exported from the Worker entry, so every
      // static import this module makes is evaluated by *every* cold isolate —
      // including the ones that only render a page or forward a passthrough
      // proxy and never open an MCP session. These two roots pull the whole
      // code-execution stack (sucrase, ajv): measured at 1.9 MB of the
      // Worker's startup closure, for code only a real session runs.
      // `apps/cloud/scripts/start-closure.mjs` reports that number and will
      // show it moving back if these become static again. QuickJS-WASM is a
      // separate dynamic import off the artifact smoke-render path only (see
      // `smokeRenderArtifactAfterQuickJsPreload` above) — it is never needed
      // during init, so it no longer lives in this Promise.all at all.
      const [{ makeExecutionStack }, { CloudMeteredExecutionStackLayer }] = yield* Effect.promise(
        () =>
          Promise.all([
            import("../engine/execution-stack"),
            import("../engine/execution-stack-metered"),
          ]) as Promise<
            [
              typeof import("../engine/execution-stack"),
              typeof import("../engine/execution-stack-metered"),
            ]
          >,
      );

      const { executor, engine } = yield* makeExecutionStack(
        sessionMeta.userId,
        sessionMeta.organizationId,
        sessionMeta.organizationName,
        { mcpResource: sessionMeta.resource },
      ).pipe(
        // The metered stack tracks each execution to Autumn. It requires
        // `AutumnService | DbService`; `AutumnService.Default` is provided here
        // (it only reads `env`, no further deps), and `DbService` flows from the
        // outer `makeSessionServices`. When `AUTUMN_SECRET_KEY` is unset the
        // billing service degrades to a no-op tracker, so this stays inert in
        // cloud dev/preview environments that run without a billing backend.
        Effect.provide(CloudMeteredExecutionStackLayer.pipe(Layer.provide(AutumnService.Default))),
        Effect.withSpan("McpSessionDOSqlite.makeExecutionStack"),
      );
      // Build the description here so `executor.connections.list()` stays under
      // the DO startup span and the MCP SDK receives a concrete string instead
      // of invoking `engine.getDescription` across its async boundary.
      const description = yield* buildExecuteDescription(executor).pipe(
        Effect.withSpan("mcp.execute.description.build"),
      );
      // Cheap size proxy for the session's footprint: `parseIntegrationInventory`
      // is a regex walk over the description string already built above, the
      // same trick `createExecutorMcpServer` uses to derive its per-integration
      // search tools without a second `connections.list()` — no new query, no
      // catalog serialization. This is a *count* of distinct connected
      // integrations, not raw connections (several connections can share one
      // integration) and is capped at the description's 50-item inventory
      // limit, same as what the model itself sees.
      self.lastSessionFootprint = {
        "mcp.session.integration_count": parseIntegrationInventory(description).length,
      };
      const sessionElicitationMode = sessionMeta.elicitationMode ?? "model";
      const mcpServer = yield* createExecutorMcpServer({
        engine,
        description,
        artifacts: executor.artifacts,
        connections: executor.connections,
        // Artifacts are on by default, opt-out per connection. A session
        // persisted without a value restores to the default, same as a fresh
        // connection whose URL says nothing about `?artifacts=`.
        artifactsEnabled: sessionMeta.artifactsEnabled ?? true,
        // Per-integration search tools are off by default, opt-in per
        // connection (`?search_tools=true`). Same restore rule as artifacts.
        searchToolsEnabled: sessionMeta.searchToolsEnabled ?? false,
        // Cold restores rebuild this server with no `initialize` to replay, so
        // the negotiated apps support comes back from storage instead.
        restoredAppsEnabled: sessionMeta.appsEnabled ?? false,
        onAppsEnabledChange: (appsEnabled) => self.persistAppsEnabled(appsEnabled),
        loadAppShellHtml,
        smokeRenderArtifact: smokeRenderArtifactAfterQuickJsPreload,
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
      }).pipe(Effect.withSpan("McpSessionDOSqlite.createExecutorMcpServer"));
      return { mcpServer, engine } satisfies BuiltMcpServer;
    });
    return build.pipe(
      Effect.withSpan("McpSessionDOSqlite.buildMcpServer"),
      // Always paired with the `acquireBuildSlot` above: releases on success,
      // failure, and interruption alike, so a build that throws — or a fiber
      // that is interrupted mid-build — never wedges the FIFO queue behind
      // it. `handle.cancel()` is idempotent and self-describing about
      // whether a slot was actually granted, so no separate "did we acquire"
      // flag is needed here; this and the abort listener above may both fire
      // for the same handle without double-releasing.
      Effect.ensuring(
        Effect.sync(() => {
          buildSlot?.cancel();
        }),
      ),
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

  protected override captureCauseEffect(
    cause: Cause.Cause<unknown>,
  ): Effect.Effect<string | undefined> {
    return reportCauseEffect(cause);
  }

  protected override prepareErrorCaptureScope(): Effect.Effect<void> {
    return Effect.asVoid(tagCurrentSentryScopeWithCurrentOtelSpan);
  }

  // The DO owns this cause; `instrumentDurableObjectWithSentry` (server.ts) must
  // not report it a second time when the rejection escapes the method.
  protected override claimCauseHandled(_cause: Cause.Cause<unknown>): Effect.Effect<void> {
    return claimCauseHandledByDurableObject;
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
