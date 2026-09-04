import { Effect, Layer } from "effect";

import { McpErrorReporter, type Principal } from "@executor-js/host-mcp";
import {
  McpEngineBuildError,
  type McpBuildServer,
  type McpBuildServerOptions,
} from "@executor-js/host-mcp/in-memory-session-store";
import { createExecutorMcpServer } from "@executor-js/host-mcp/tool-server";
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
// Every host that serves MCP from one isolate (self-host, the Cloudflare QuickJS
// host) builds its per-session McpServer the same way — assemble the scoped
// engine via `makeExecutionStack`, wrap it with `createExecutorMcpServer` — and
// reports orchestration defects through the same console `ErrorCapture` seam.
// These two factories are the single home for that logic; a host supplies ONLY
// its fully-provided execution-stack layer and its `ErrorCapture` layer. The
// cross-isolate variant (cloud's Durable Object store) is the exception that
// builds its engine inside the DO.
// ---------------------------------------------------------------------------

/** The five execution-stack seams a host fully provides (no residual). */
export type McpExecutionStackLayer = Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator
>;

/**
 * Build the per-session MCP server factory over a host's execution stack:
 * `makeExecutionStack` → engine → `createExecutorMcpServer`. Hosts differ only
 * in the injected stack layer (libSQL vs D1, etc.).
 */
export const makeMcpBuildServer =
  (executionStack: McpExecutionStackLayer, hostOptions?: McpBuildHostOptions): McpBuildServer =>
  (principal: Principal, options?: McpBuildServerOptions) =>
    Effect.gen(function* () {
      const { engine, executor } = yield* makeExecutionStack(
        principal.accountId,
        principal.organizationId,
        principal.organizationName,
        {
          mcpResource: options?.resource,
          orgWrites: "request",
        },
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
        createExecutorMcpServer({
          engine,
          artifacts: executor.artifacts,
          connections: executor.connections,
          tools: executor.tools,
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
          ...(options ?? {}),
        }).pipe(
          Effect.withSpan("mcp.server.create"),
          // A passthrough session with no catalog is a build failure like any
          // other: the client gets the same retryable envelope.
          Effect.mapError((cause) => new McpEngineBuildError({ cause })),
          Effect.map((mcpServer) => ({ mcpServer, engine })),
        ),
      ),
    );

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
