import { Effect } from "effect";

import { createExecutorMcpServer } from "@executor-js/host-mcp/tool-server";
import { buildResumeApprovalUrl } from "@executor-js/host-mcp/browser-approval";
import type { ExecutorDbHandle } from "@executor-js/api/server";
import {
  McpAgentSessionDOBase,
  type BuiltMcpServer,
  type McpSessionInit,
  type SessionMeta,
} from "@executor-js/cloudflare/mcp/agent-durable-object";

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

export class McpSessionDO extends McpAgentSessionDOBase<CloudflareEnv, CfSessionDbHandle> {
  private readonly cfEnv: CloudflareEnv;
  private readonly cfConfig: CloudflareConfig;

  constructor(
    ctx: ConstructorParameters<typeof McpAgentSessionDOBase<CloudflareEnv, CfSessionDbHandle>>[0],
    env: CloudflareEnv,
  ) {
    super(ctx, env);
    this.cfEnv = env;
    this.cfConfig = loadConfig(env);
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
    } satisfies SessionMeta);
  }

  protected override buildMcpServer(
    sessionMeta: SessionMeta,
    dbHandle: CfSessionDbHandle,
  ): Effect.Effect<BuiltMcpServer> {
    const config = this.cfConfig;
    const self = this;
    return Effect.gen(function* () {
      // QuickJS-WASM must be loaded before the executor layer builds it (the
      // default variant can't fetch its .wasm on Workers). Idempotent per isolate.
      yield* Effect.promise(() => preloadQuickJs());
      const { engine } = yield* makeExecutionStack(
        sessionMeta.userId,
        sessionMeta.organizationId,
        sessionMeta.organizationName,
        { mcpResource: sessionMeta.resource },
      ).pipe(Effect.provide(makeCloudflareExecutionStackLayer(config, dbHandle)));
      // Browser elicitation mode (the base owns the approval store + the HTTP
      // approval RPCs): a gated execution pauses and returns an approvalUrl into
      // the console resume page. The URL origin is the create request's origin
      // (captured by the base), falling back to the configured site URL.
      const elicitationMode = sessionMeta.elicitationMode ?? "model";
      const mcpServer = yield* createExecutorMcpServer({
        engine,
        browserApprovalStore: self.browserApprovalStore,
        pausedExecutionHooks: self.pausedExecutionHooks,
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
      return { mcpServer, engine } satisfies BuiltMcpServer;
    }).pipe(
      Effect.withSpan("McpSessionDO.buildMcpServer"),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: a runtime-build failure surfaces as the base's tapCause/cleanup defect
      Effect.orDie,
    );
  }
}
