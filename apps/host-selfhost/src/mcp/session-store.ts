import { Layer } from "effect";

import {
  makeConsoleMcpErrorReporter,
  makeMcpBuildServer,
  makeMcpBuildServerV2,
} from "@executor-js/api/server";
import { McpModernServerBuilder, type McpErrorReporter } from "@executor-js/host-mcp";
import {
  inMemoryMcpSessionsLayer,
  makeInMemoryMcpSessionStore,
  type InMemoryMcpSessionStore,
} from "@executor-js/host-mcp/in-memory-session-store";

import { selfHostAnalytics } from "../analytics";
import { ErrorCaptureLive } from "../observability";
import { SelfHostDb, type SelfHostDbHandle } from "../db/self-host-db";
import { SelfHostExecutionStackLayer } from "../execution";

// ---------------------------------------------------------------------------
// Self-host McpSessionStore wiring. The store body (Maps, dispatch, ownership,
// lifetime), the per-session engine builder, and the console error reporter are
// ALL shared (`@executor-js/host-mcp/in-memory-session-store` + `makeMcpBuildServer`
// / `makeConsoleMcpErrorReporter` in `@executor-js/api/server`). Self-host
// supplies only its fully-provided execution-stack layer (QuickJS over the
// long-lived `SelfHostDb`) and its `ErrorCapture`; the builder creates the
// connection-lifetime SDK v2 assembly used by the shared store.
// ---------------------------------------------------------------------------

import { loadMcpAppsShellHtml } from "@executor-js/mcp-apps-shell";
import { smokeRenderArtifact } from "@executor-js/mcp-apps-shell/smoke-render";

export { McpEngineBuildError } from "@executor-js/host-mcp/in-memory-session-store";

/**
 * Build the in-process session store (plus its `close()` hook) over the DB
 * handle. `webBaseUrl` is the pinned public origin so browser-approval URLs use
 * the reachable public address rather than the internal bind behind a proxy.
 */
export const makeSelfHostMcpSessionStore = (
  db: SelfHostDbHandle,
  webBaseUrl?: string,
): InMemoryMcpSessionStore =>
  makeInMemoryMcpSessionStore(
    makeMcpBuildServer(
      SelfHostExecutionStackLayer.pipe(Layer.provide(Layer.succeed(SelfHostDb)(db))),
      {
        loadAppShellHtml: loadMcpAppsShellHtml,
        smokeRenderArtifact,
        // Artifact operations on the MCP plane come from an agent's tools.
        onArtifactUsage: (action) =>
          selfHostAnalytics.record(`artifact_${action}`, { via: "agent" }),
      },
    ),
    { webBaseUrl },
  );

/** Build the stateless SDK v2 server seam over the same self-host stack/config. */
export const makeSelfHostMcpModernServerBuilder = (
  db: SelfHostDbHandle,
): Layer.Layer<McpModernServerBuilder> =>
  Layer.succeed(McpModernServerBuilder)({
    build: makeMcpBuildServerV2(
      SelfHostExecutionStackLayer.pipe(Layer.provide(Layer.succeed(SelfHostDb)(db))),
      {
        loadAppShellHtml: loadMcpAppsShellHtml,
        smokeRenderArtifact,
        onArtifactUsage: (action) =>
          selfHostAnalytics.record(`artifact_${action}`, { via: "agent" }),
      },
    ),
  });

/** The `McpSessionStore` envelope seam over a freshly built in-process store. */
export const selfHostMcpSessions = inMemoryMcpSessionsLayer;

/** Route 500-defects through the host's console `ErrorCapture`. */
export const selfHostMcpReporter: Layer.Layer<McpErrorReporter> =
  makeConsoleMcpErrorReporter(ErrorCaptureLive);
