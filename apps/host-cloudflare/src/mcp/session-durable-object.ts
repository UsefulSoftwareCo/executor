import { Data, Effect } from "effect";

import {
  PAUSED_APPROVAL_TIMEOUT_MS,
  type PausedExecutionHooks,
  type ResumeFallbackOutcome,
} from "@executor-js/host-mcp/tool-server";
import { buildMcpServerV2, mcpRequestStatePrincipal } from "@executor-js/host-mcp/tool-server-v2";
import type { McpModernServerBuilder, Principal } from "@executor-js/host-mcp";
import { buildResumeApprovalUrl } from "@executor-js/host-mcp/browser-approval";
import { artifactUrlFor } from "@executor-js/host-mcp/create-artifact";
import { makeAssetsShellHtmlLoader } from "@executor-js/mcp-apps-shell/worker";
import { smokeRenderArtifact } from "@executor-js/mcp-apps-shell/smoke-render";
import type { ExecutorDbHandle } from "@executor-js/api/server";
import {
  McpAgentSessionDOBase,
  type BuiltMcpServer,
  type BuiltModernMcpRuntime,
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

import { loadConfig, type CloudflareConfig, type CloudflareEnv } from "../config";
import { createD1ExecutorDb } from "../db/d1";
import { makeCloudflareExecutionStackLayer, makeExecutionStack } from "../execution";
import { preloadQuickJs } from "../quickjs";

// ---------------------------------------------------------------------------
// Cloudflare (self-host) MCP Session Durable Object — the host-cloudflare
// binding of the shared `McpAgentSessionDOBase` (@executor-js/cloudflare). Identical
// base to cloud; the ONLY differences are the injected dependencies:
//   - openSessionDb     → a long-lived D1 `ExecutorDbHandle` (same FumaDB
//                         assembly the HTTP path uses), adapted to the base's
//                         `end` disposal contract.
//   - resolveSessionMeta → single-tenant: the org is fixed in config, so no
//                         lookup — just stamp the configured org name.
//   - buildMcpServer    → the QuickJS execution stack + the MCP tool server.
// host-cf has no OTel/Sentry, so it keeps the base's default no-op telemetry +
// error seams. Replacing the prior in-memory store with this DO is what fixes
// `tools/list` failing across Worker isolates (a session created on one isolate
// was invisible to the next; the DO id == session id routes them all back).
// ---------------------------------------------------------------------------

// The long-lived D1 handle, adapted to the base's `end` contract. D1 owns its
// own lifecycle (the binding is the connection), so `end` is `close` — a no-op.
type CfSessionDbHandle = ExecutorDbHandle & { readonly end: () => Promise<void> };

class McpModelResumeForwardError extends Data.TaggedError("McpModelResumeForwardError")<{
  readonly cause: unknown;
}> {}

class CloudflareModernMcpBuildError extends Data.TaggedError("CloudflareModernMcpBuildError")<{
  readonly cause: unknown;
}> {}

const makeCloudflareExecutionRuntime = (
  sessionMeta: SessionMeta,
  dbHandle: CfSessionDbHandle,
  config: CloudflareConfig,
) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => preloadQuickJs());
    const { engine, executor } = yield* makeExecutionStack(
      sessionMeta.userId,
      sessionMeta.organizationId,
      sessionMeta.organizationName,
      { mcpResource: sessionMeta.resource },
    ).pipe(Effect.provide(makeCloudflareExecutionStackLayer(config, dbHandle)));
    const description = yield* buildExecuteDescription(executor);
    return { engine, executor, description };
  });

type CloudflareExecutionRuntime = Effect.Success<ReturnType<typeof makeCloudflareExecutionRuntime>>;

type CloudflareModernLifecycle = {
  readonly pausedExecutionHooks?: PausedExecutionHooks;
  readonly resumeFallback?: (
    executionId: string,
    response: ResumeResponse,
  ) => Effect.Effect<ResumeFallbackOutcome | null, unknown>;
};

const makeCloudflareModernRuntime = (
  sessionMeta: SessionMeta,
  runtime: CloudflareExecutionRuntime,
  loadAppShellHtml: () => Promise<string>,
  config: CloudflareConfig,
  lifecycle: CloudflareModernLifecycle = {},
): BuiltModernMcpRuntime => {
  const artifactOrigin = sessionMeta.webOrigin ?? config.webBaseUrl;
  return {
    engine: runtime.engine,
    buildServer: (options) =>
      buildMcpServerV2({
        engine: runtime.engine,
        description: runtime.description,
        artifacts: runtime.executor.artifacts,
        connections: runtime.executor.connections,
        artifactsEnabled: sessionMeta.artifactsEnabled ?? true,
        loadAppShellHtml,
        smokeRenderArtifact,
        ...(artifactOrigin
          ? { artifactUrl: artifactUrlFor(artifactOrigin, sessionMeta.organizationSlug) }
          : {}),
        elicitationMode: { mode: "native" },
        ...(lifecycle.pausedExecutionHooks
          ? {
              pausedExecutionHooks: lifecycle.pausedExecutionHooks,
              pausedExecutionLeaseMs: PAUSED_APPROVAL_TIMEOUT_MS,
            }
          : {}),
        ...(lifecycle.resumeFallback ? { resumeFallback: lifecycle.resumeFallback } : {}),
        ...options,
      }),
  };
};

const closeModernServerWithDb = <Server extends { close: () => Promise<void> }>(
  server: Server,
  dbHandle: CfSessionDbHandle,
): Server => {
  const closeServer = server.close.bind(server);
  server.close = () =>
    Effect.runPromise(
      Effect.promise(closeServer).pipe(Effect.ensuring(Effect.promise(() => dbHandle.end()))),
    );
  return server;
};

/** Build the worker-side SDK v2 server over a fresh D1 execution runtime. */
export const makeCloudflareModernMcpServerBuilder = (
  env: CloudflareEnv,
  config: CloudflareConfig,
  session: McpSessionInit,
): McpModernServerBuilder["Service"] => ({
  build: (principal: Principal, options) =>
    Effect.promise(async () => {
      const handle = await createD1ExecutorDb(env.DB, env.BLOBS);
      return { ...handle, end: () => handle.close() } satisfies CfSessionDbHandle;
    }).pipe(
      Effect.flatMap((dbHandle) => {
        const { resource, ...requestOptions } = options;
        const sessionMeta: SessionMeta = {
          organizationId: principal.organizationId,
          organizationName: config.organizationName,
          organizationSlug: config.organizationSlug,
          userId: principal.accountId,
          resource,
          elicitationMode: session.elicitationMode,
          artifactsEnabled: session.artifactsEnabled,
          webOrigin: session.webOrigin,
        };
        return makeCloudflareExecutionRuntime(sessionMeta, dbHandle, config).pipe(
          Effect.flatMap((runtime) =>
            makeCloudflareModernRuntime(
              sessionMeta,
              runtime,
              makeAssetsShellHtmlLoader({ assets: env.ASSETS }),
              config,
            ).buildServer(requestOptions),
          ),
          Effect.map((server) => closeModernServerWithDb(server, dbHandle)),
          Effect.tapCause(() => Effect.promise(() => dbHandle.end())),
          Effect.mapError((cause) => new CloudflareModernMcpBuildError({ cause })),
        );
      }),
    ),
});

export class McpSessionDO extends McpAgentSessionDOBase<CloudflareEnv, CfSessionDbHandle> {
  private readonly cfEnv: CloudflareEnv;
  private readonly cfConfig: CloudflareConfig;
  /**
   * The `ui://executor/shell.html` document, over the ASSETS binding: a
   * deployed Worker has no filesystem, so the shell is the stable-named asset
   * the SPA build emitted into `./dist` (`mcpAppsShellAsset`). No dev-mode
   * escape hatch here, unlike cloud: this Worker is bundled by wrangler, not
   * Vite, and `wrangler dev` serves the same built `./dist` the binding reads.
   */
  private readonly loadAppShellHtml: () => Promise<string>;

  constructor(
    ctx: ConstructorParameters<typeof McpAgentSessionDOBase<CloudflareEnv, CfSessionDbHandle>>[0],
    env: CloudflareEnv,
  ) {
    super(ctx, env);
    this.cfEnv = env;
    this.cfConfig = loadConfig(env);
    this.loadAppShellHtml = makeAssetsShellHtmlLoader({ assets: env.ASSETS });
  }

  protected override executionOwnerDirectory(): McpExecutionOwnerDirectory | null {
    return mcpExecutionOwnerDirectoryFromNamespace(this.cfEnv.MCP_EXECUTION_OWNER);
  }

  protected override forwardModelResumeToOwner(
    owner: McpExecutionOwnerRoute,
    identity: McpApprovalOwner,
    executionId: string,
    response: ResumeResponse,
  ): Effect.Effect<McpSessionModelResumeResult, unknown> {
    const ownerSession = mcpSessionStubForOwner(this.cfEnv.MCP_SESSION, owner);
    if (!ownerSession) {
      return Effect.succeed({ status: "execution_expired", ttlMs: PAUSED_APPROVAL_TIMEOUT_MS });
    }
    return Effect.tryPromise({
      try: () => ownerSession.resumeExecutionForModel(executionId, identity, response),
      catch: (cause) => new McpModelResumeForwardError({ cause }),
    });
  }

  protected override async openSessionDb(): Promise<CfSessionDbHandle> {
    const handle = await createD1ExecutorDb(this.cfEnv.DB, this.cfEnv.BLOBS);
    return { ...handle, end: () => handle.close() };
  }

  protected override resolveSessionMeta(token: McpSessionInit): Effect.Effect<SessionMeta> {
    // Single-tenant: every Access principal belongs to the one configured org,
    // so there is nothing to resolve — stamp the configured org name.
    return Effect.succeed({
      organizationId: token.organizationId,
      organizationName: this.cfConfig.organizationName,
      organizationSlug: this.cfConfig.organizationSlug,
      userId: token.userId,
      resource: token.resource,
      elicitationMode: token.elicitationMode,
      artifactsEnabled: token.artifactsEnabled,
      webOrigin: token.webOrigin,
    } satisfies SessionMeta);
  }

  protected override buildMcpServer(
    sessionMeta: SessionMeta,
    dbHandle: CfSessionDbHandle,
  ): Effect.Effect<BuiltMcpServer> {
    const config = this.cfConfig;
    const self = this;
    return Effect.gen(function* () {
      const runtime = yield* makeCloudflareExecutionRuntime(sessionMeta, dbHandle, config);
      const { engine, executor, description } = runtime;
      const modernRuntime = makeCloudflareModernRuntime(
        sessionMeta,
        runtime,
        self.loadAppShellHtml,
        config,
        {
          pausedExecutionHooks: self.modernPausedExecutionHooks,
          resumeFallback: self.modernModelResumeFallback,
        },
      );
      // Browser elicitation mode (the base owns the approval store + the HTTP
      // approval RPCs): a gated execution pauses and returns an approvalUrl into
      // the console resume page. The URL origin is the create request's origin
      // (captured by the base), falling back to the configured site URL.
      const elicitationMode = sessionMeta.elicitationMode ?? "model";
      // Same origin story as the approval URL below: an artifact deep link is
      // only offered when this deployment knows its own public URL. Without one
      // the artifact is still saved, and the tool says so.
      const artifactOrigin = sessionMeta.webOrigin ?? config.webBaseUrl;
      const mcpServer = yield* buildMcpServerV2({
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
        appsEnabled: false,
        sessionful: true,
        requestStateSigningKey: self.modernRequestStateSigningKey(),
        requestStatePrincipal: mcpRequestStatePrincipal({
          accountId: sessionMeta.userId,
          organizationId: sessionMeta.organizationId,
        }),
        loadAppShellHtml: self.loadAppShellHtml,
        smokeRenderArtifact,
        ...(artifactOrigin
          ? { artifactUrl: artifactUrlFor(artifactOrigin, sessionMeta.organizationSlug) }
          : {}),
        browserApprovalStore: self.browserApprovalStore,
        pausedExecutionHooks: self.pausedExecutionHooks,
        pausedExecutionLeaseMs: PAUSED_APPROVAL_TIMEOUT_MS,
        resumeFallback: self.modelResumeFallback,
        elicitationMode:
          elicitationMode === "browser"
            ? {
                mode: "browser" as const,
                approvalUrl: (executionId) => {
                  // webOrigin is captured per-request at session create; for a
                  // legacy session cold-restored without it, fall back to the
                  // pinned site URL. If neither exists, the link would be
                  // unreachable — fail VISIBLY (a logged, obviously-invalid host)
                  // instead of silently pointing the human at http://localhost.
                  const origin = sessionMeta.webOrigin ?? config.webBaseUrl;
                  if (!origin) {
                    console.error(
                      "[executor-cloudflare] cannot build MCP approval URL: no session web origin and VITE_PUBLIC_SITE_URL is unset. Set VITE_PUBLIC_SITE_URL so approval links are reachable.",
                    );
                  }
                  return buildResumeApprovalUrl({
                    origin: origin ?? "https://unconfigured-origin.invalid",
                    executionId,
                    sessionId: self.sessionId,
                    organizationSlug: sessionMeta.organizationSlug,
                  });
                },
              }
            : { mode: elicitationMode },
      });
      return { mcpServer, engine, modernRuntime } satisfies BuiltMcpServer;
    }).pipe(
      Effect.withSpan("McpSessionDO.buildMcpServer"),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: a runtime-build failure surfaces as the base's tapCause/cleanup defect
      Effect.orDie,
    );
  }

  protected override buildModernMcpRuntime(
    sessionMeta: SessionMeta,
    dbHandle: CfSessionDbHandle,
  ): Effect.Effect<BuiltModernMcpRuntime> {
    const self = this;
    return makeCloudflareExecutionRuntime(sessionMeta, dbHandle, this.cfConfig).pipe(
      Effect.map((runtime) =>
        makeCloudflareModernRuntime(sessionMeta, runtime, self.loadAppShellHtml, self.cfConfig, {
          pausedExecutionHooks: self.modernPausedExecutionHooks,
          resumeFallback: self.modernModelResumeFallback,
        }),
      ),
      Effect.withSpan("McpSessionDO.buildModernMcpRuntime"),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: runtime-build failures surface through the base RPC cleanup path
      Effect.orDie,
    );
  }

  protected override modernRequestStateSigningKey(): string {
    return requireMcpRequestStateKey(this.cfEnv.MCP_REQUEST_STATE_KEY);
  }
}
