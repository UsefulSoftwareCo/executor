import { Effect, Layer } from "effect";

import {
  McpErrorReporter,
  type McpModernServerBuilder,
  type Principal,
} from "@executor-js/host-mcp";
import {
  McpEngineBuildError,
  type McpBuildServer,
} from "@executor-js/host-mcp/in-memory-session-store";
import { buildMcpServerV2 } from "@executor-js/host-mcp/tool-server-v2";
import {
  artifactUrlFor,
  type ArtifactSmokeRenderResult,
} from "@executor-js/host-mcp/create-artifact";

import { ErrorCapture } from "../observability";
import { CodeExecutorProvider, EngineDecorator, makeExecutionStack } from "./execution-stack";
import { DbProvider } from "./executor-fuma-db";
import { HostConfig, PluginsProvider, RequestOrgSlug } from "./scoped-executor";

// ---------------------------------------------------------------------------
// Shared in-process MCP host helpers.
//
// Neutral hosts build both sessionful legacy connections and stateless modern
// requests from the same SDK v2 assembly over a scoped execution stack. The
// Cloudflare Durable Object path remains a separate v1-backed composition root.
// ---------------------------------------------------------------------------

/** The five execution-stack seams a host fully provides (no residual). */
export type McpExecutionStackLayer = Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator
>;

/**
 * Build the per-session MCP server factory over a host's execution stack:
 * `makeExecutionStack` → engine → `buildMcpServerV2`. Hosts differ only
 * in the injected stack layer (libSQL vs D1, etc.).
 */
export const makeMcpBuildServer =
  (executionStack: McpExecutionStackLayer, hostOptions?: McpBuildHostOptions): McpBuildServer =>
  (principal: Principal, options) => {
    const { resource, ...serverOptions } = options;
    return Effect.gen(function* () {
      const { engine, executor } = yield* makeExecutionStack(
        principal.accountId,
        principal.organizationId,
        principal.organizationName,
        { mcpResource: resource },
      ).pipe(Effect.withSpan("mcp.execution_stack.build"));
      // Read inside the provided boundary: `webBaseUrl` is a host seam, and
      // hosts that can't know their public URL at boot leave it unset — in
      // which case artifacts still persist but carry no deep link.
      const hostConfig = yield* HostConfig;
      return { engine, executor, webBaseUrl: hostConfig.webBaseUrl };
    }).pipe(
      // Pin browser-handoff URLs to the principal's org slug when present;
      // absent slug leaves the service unprovided and the URL stays bare.
      principal.organizationSlug !== undefined
        ? Effect.provideService(RequestOrgSlug, { slug: principal.organizationSlug })
        : (effect) => effect,
      Effect.provide(executionStack),
      Effect.mapError((cause) => new McpEngineBuildError({ cause })),
      Effect.flatMap(({ engine, executor, webBaseUrl }) =>
        buildMcpServerV2({
          engine,
          artifacts: executor.artifacts,
          connections: executor.connections,
          ...(hostOptions?.loadAppShellHtml
            ? { loadAppShellHtml: hostOptions.loadAppShellHtml }
            : {}),
          ...(hostOptions?.smokeRenderArtifact
            ? { smokeRenderArtifact: hostOptions.smokeRenderArtifact }
            : {}),
          ...(hostOptions?.onArtifactUsage ? { onArtifactUsage: hostOptions.onArtifactUsage } : {}),
          // Same org pinning as `RequestOrgSlug` above: self-host serves its
          // console under `/<org-slug>` (`default` when unconfigured), so the
          // deep link carries the principal's slug rather than relying on the
          // browser's active org to canonicalize a bare path after landing.
          ...(webBaseUrl
            ? { artifactUrl: artifactUrlFor(webBaseUrl, principal.organizationSlug) }
            : {}),
          ...serverOptions,
        }).pipe(
          Effect.withSpan("mcp.server.create"),
          Effect.map((mcpServer) => ({ mcpServer, engine })),
        ),
      ),
    );
  };

/** Build function consumed by the neutral envelope's modern-server seam. */
export type McpBuildServerV2 = McpModernServerBuilder["Service"]["build"];

/**
 * Build the per-request SDK v2 server factory over the same execution stack
 * and host configuration used by {@link makeMcpBuildServer}.
 */
export const makeMcpBuildServerV2 =
  (executionStack: McpExecutionStackLayer, hostOptions?: McpBuildHostOptions): McpBuildServerV2 =>
  (principal, options) => {
    const { resource, ...requestOptions } = options;
    return Effect.gen(function* () {
      const { engine, executor } = yield* makeExecutionStack(
        principal.accountId,
        principal.organizationId,
        principal.organizationName,
        { mcpResource: resource },
      ).pipe(Effect.withSpan("mcp.execution_stack.build"));
      const hostConfig = yield* HostConfig;
      return { engine, executor, webBaseUrl: hostConfig.webBaseUrl };
    }).pipe(
      principal.organizationSlug !== undefined
        ? Effect.provideService(RequestOrgSlug, { slug: principal.organizationSlug })
        : (effect) => effect,
      Effect.provide(executionStack),
      Effect.mapError((cause) => new McpEngineBuildError({ cause })),
      Effect.flatMap(({ engine, executor, webBaseUrl }) =>
        buildMcpServerV2({
          engine,
          artifacts: executor.artifacts,
          connections: executor.connections,
          ...(hostOptions?.loadAppShellHtml
            ? { loadAppShellHtml: hostOptions.loadAppShellHtml }
            : {}),
          ...(hostOptions?.smokeRenderArtifact
            ? { smokeRenderArtifact: hostOptions.smokeRenderArtifact }
            : {}),
          ...(hostOptions?.onArtifactUsage ? { onArtifactUsage: hostOptions.onArtifactUsage } : {}),
          ...(webBaseUrl
            ? { artifactUrl: artifactUrlFor(webBaseUrl, principal.organizationSlug) }
            : {}),
          ...requestOptions,
        }).pipe(Effect.withSpan("mcp.server.create")),
      ),
    );
  };

/** Per-host (not per-session) MCP wiring. Kept separate from
 *  `McpBuildServerOptions`, which the session store fills in per request. */
export interface McpBuildHostOptions {
  /** Serves the MCP-Apps shell resource. Hosts that can render generative UI
   *  pass `loadMcpAppsShellHtml` from `@executor-js/mcp-apps-shell`; omitting it
   *  leaves the ui-bearing tools unregistered. */
  readonly loadAppShellHtml?: () => Promise<string>;
  /** Trial-renders an artifact before it is saved, so a component that throws
   *  on first render is refused at create time. Hosts that can afford React on
   *  the server pass `smokeRenderArtifact` from `@executor-js/mcp-apps-shell`,
   *  which loads it behind a dynamic import; omitting it skips the check. */
  readonly smokeRenderArtifact?: (code: string) => Promise<ArtifactSmokeRenderResult>;
  /** Forwarded to the tool server's `onArtifactUsage`: best-effort observation
   *  of agent-driven artifact operations, for hosts recording product
   *  analytics. */
  readonly onArtifactUsage?: (action: "created" | "viewed" | "updated") => Effect.Effect<void>;
}

/**
 * The standard console `McpErrorReporter` seam: route an orchestration defect
 * the MCP envelope would otherwise swallow into a 500 through the host's
 * `ErrorCapture`, so operators still see it. Hosts differ only in the capture
 * layer (self-host/Cloudflare console; cloud overrides with Sentry separately).
 */
export const makeConsoleMcpErrorReporter = (
  errorCapture: Layer.Layer<ErrorCapture>,
): Layer.Layer<McpErrorReporter> =>
  Layer.effect(
    McpErrorReporter,
    Effect.gen(function* () {
      const capture = yield* ErrorCapture;
      return { report: (cause) => Effect.asVoid(capture.captureException(cause)) };
    }),
  ).pipe(Layer.provide(errorCapture));
