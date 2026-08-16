import { Effect, Layer } from "effect";

import {
  McpErrorReporter,
  type McpModernServerBuilder,
  type McpModernServerBuildOptions,
  type Principal,
} from "@executor-js/host-mcp";
import {
  McpEngineBuildError,
  type McpBuildServer as McpSessionBuildServer,
  type McpBuildServerOptions as McpSessionBuildOptions,
} from "@executor-js/host-mcp/in-memory-session-store";
import { buildMcpServer } from "@executor-js/host-mcp/tool-server";
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
// Neutral hosts build both sessionful legacy-wire connections and stateless
// modern requests from the same assembly over a scoped execution stack.
// ---------------------------------------------------------------------------

/** The five execution-stack seams a host fully provides (no residual). */
export type McpExecutionStackLayer = Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator
>;

type McpSessionBuildEffect = ReturnType<McpSessionBuildServer>;
type McpModernBuildEffect = ReturnType<McpModernServerBuilder["Service"]["build"]>;

/** A single build seam accepted by both the session store and modern envelope. */
export interface McpBuildServer {
  /** Build a connection-lifetime server and retain its engine for session-owned approvals. */
  (principal: Principal, options: McpSessionBuildOptions): McpSessionBuildEffect;
  /** Build a stateless server for one modern request. */
  (principal: Principal, options: McpModernServerBuildOptions): McpModernBuildEffect;
}

/**
 * Build the unified MCP server factory over a host's execution stack.
 * Session callers receive the server plus its approval-owning engine; modern
 * request callers receive the server directly.
 */
export const makeMcpBuildServer = (
  executionStack: McpExecutionStackLayer,
  hostOptions?: McpBuildHostOptions,
): McpBuildServer => {
  function build(principal: Principal, options: McpSessionBuildOptions): McpSessionBuildEffect;
  function build(principal: Principal, options: McpModernServerBuildOptions): McpModernBuildEffect;
  function build(
    principal: Principal,
    options: McpSessionBuildOptions | McpModernServerBuildOptions,
  ): Effect.Effect<
    Effect.Success<McpSessionBuildEffect> | Effect.Success<McpModernBuildEffect>,
    Effect.Error<McpSessionBuildEffect> | Effect.Error<McpModernBuildEffect>
  > {
    const { resource, ...serverOptions } = options;
    return Effect.gen(function* () {
      const { engine, executor } = yield* makeExecutionStack(
        principal.accountId,
        principal.organizationId,
        principal.organizationName,
        { mcpResource: resource },
      ).pipe(Effect.withSpan("mcp.execution_stack.build"));
      // Read inside the provided boundary: `webBaseUrl` is a host seam, and
      // hosts that cannot know their public URL at boot leave it unset.
      const hostConfig = yield* HostConfig;
      return { engine, executor, webBaseUrl: hostConfig.webBaseUrl };
    }).pipe(
      principal.organizationSlug !== undefined
        ? Effect.provideService(RequestOrgSlug, { slug: principal.organizationSlug })
        : (effect) => effect,
      Effect.provide(executionStack),
      Effect.mapError((cause) => new McpEngineBuildError({ cause })),
      Effect.flatMap(({ engine, executor, webBaseUrl }) =>
        buildMcpServer({
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
          ...serverOptions,
        }).pipe(
          Effect.withSpan("mcp.server.create"),
          Effect.map((mcpServer) => ("sessionful" in options ? { mcpServer, engine } : mcpServer)),
        ),
      ),
    );
  }

  return build;
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
