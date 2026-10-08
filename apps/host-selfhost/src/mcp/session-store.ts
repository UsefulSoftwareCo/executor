import { Effect, Layer } from "effect";

import { makeConsoleMcpErrorReporter, makeMcpBuildServer } from "@executor-js/api/server";
import type { McpErrorReporter } from "@executor-js/host-mcp";
import {
  inMemoryMcpSessionsLayer,
  makeInMemoryMcpSessionStore,
  type InMemoryMcpSessionStore,
} from "@executor-js/host-mcp/in-memory-session-store";

import { selfHostAnalytics } from "../analytics";
import { ErrorCaptureLive } from "../observability";
import { SelfHostDb, type SelfHostDbHandle } from "../db/self-host-db";
import { SelfHostExecutionStackLayer } from "../execution";
import { makeToolUsageRecorder } from "./tool-usage-store";
import { observeToolUsageServer } from "./tool-usage";

// ---------------------------------------------------------------------------
// Self-host McpSessionStore wiring. The store body (Maps, dispatch, ownership,
// lifetime), the per-session engine builder, and the console error reporter are
// ALL shared (`@executor-js/host-mcp/in-memory-session-store` + `makeMcpBuildServer`
// / `makeConsoleMcpErrorReporter` in `@executor-js/api/server`). Self-host
// supplies only its fully-provided execution-stack layer (QuickJS over the
// long-lived `SelfHostDb`) and its `ErrorCapture`. The Cloudflare host wires the
// identical seam with its own stack layer.
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
  sessionIdleTtlMs?: number,
): InMemoryMcpSessionStore => {
  const usage = makeToolUsageRecorder(db.client);
  const build = makeMcpBuildServer(
    SelfHostExecutionStackLayer.pipe(Layer.provide(Layer.succeed(SelfHostDb)(db))),
    {
      loadAppShellHtml: loadMcpAppsShellHtml,
      smokeRenderArtifact,
      onArtifactUsage: (action) => selfHostAnalytics.record(`artifact_${action}`, { via: "agent" }),
    },
  );
  const store = makeInMemoryMcpSessionStore(
    (principal, options) =>
      Effect.promise(() => usage.ready).pipe(
        Effect.flatMap(() => build(principal, options)),
        Effect.tap(({ mcpServer }) =>
          Effect.sync(() => {
            const memberHash = usage.memberHash(principal.organizationId, principal.accountId);
            if (memberHash !== null)
              observeToolUsageServer(mcpServer, memberHash, usage.record, usage.drop);
          }),
        ),
      ),
    {
      ...(webBaseUrl === undefined ? {} : { webBaseUrl }),
      ...(sessionIdleTtlMs === undefined ? {} : { sessionIdleTtlMs }),
    },
  );
  return {
    ...store,
    close: async () => {
      await store.close();
      await usage.close();
    },
  };
};

/** The `McpSessionStore` envelope seam over a freshly built in-process store. */
export const selfHostMcpSessions = inMemoryMcpSessionsLayer;

/** Route 500-defects through the host's console `ErrorCapture`. */
export const selfHostMcpReporter: Layer.Layer<McpErrorReporter> =
  makeConsoleMcpErrorReporter(ErrorCaptureLive);
