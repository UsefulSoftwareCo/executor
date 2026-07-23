import { Layer } from "effect";

import { makeConsoleMcpErrorReporter, makeMcpBuildServer } from "@executor-js/api/server";
import type { McpErrorReporter } from "@executor-js/host-mcp";
import { McpSessionStore } from "@executor-js/host-mcp";
import {
  makeInMemoryMcpSessionStore,
  type InMemoryMcpSessionStore,
} from "@executor-js/host-mcp/in-memory-session-store";
import {
  makeStatelessMcpSessionStore,
  type StatelessMcpSessionStore,
} from "@executor-js/host-mcp/stateless-session-store";

import type { SelfHostMcpMode } from "../config";
import { ErrorCaptureLive } from "../observability";
import { SelfHostDb, type SelfHostDbHandle } from "../db/self-host-db";
import { SelfHostExecutionStackLayer } from "../execution";

// ---------------------------------------------------------------------------
// Self-host McpSessionStore wiring. The store body (Maps, dispatch, ownership,
// lifetime), the per-session engine builder, and the console error reporter are
// ALL shared (`@executor-js/host-mcp/in-memory-session-store` + `makeMcpBuildServer`
// / `makeConsoleMcpErrorReporter` in `@executor-js/api/server`). Self-host
// supplies only its fully-provided execution-stack layer (QuickJS over the
// long-lived `SelfHostDb`) and its `ErrorCapture`. The Cloudflare host wires the
// identical seam with its own stack layer.
// ---------------------------------------------------------------------------

export { McpEngineBuildError } from "@executor-js/host-mcp/in-memory-session-store";

export type SelfHostMcpSessionStore =
  | InMemoryMcpSessionStore
  | (StatelessMcpSessionStore & {
      readonly handlePausedRequest: () => Promise<null>;
      readonly handleApprovalRequest: () => Promise<null>;
    });

/**
 * Build the in-process session store (plus its `close()` hook) over the DB
 * handle. `webBaseUrl` is the pinned public origin so browser-approval URLs use
 * the reachable public address rather than the internal bind behind a proxy.
 */
export const makeSelfHostMcpSessionStore = (
  db: SelfHostDbHandle,
  webBaseUrl?: string,
  mode: SelfHostMcpMode = "stateful",
): SelfHostMcpSessionStore => {
  const buildServer = makeMcpBuildServer(
    SelfHostExecutionStackLayer.pipe(Layer.provide(Layer.succeed(SelfHostDb)(db))),
  );
  if (mode === "stateless") {
    return {
      ...makeStatelessMcpSessionStore(buildServer),
      handlePausedRequest: () => Promise.resolve(null),
      handleApprovalRequest: () => Promise.resolve(null),
    };
  }
  return makeInMemoryMcpSessionStore(buildServer, { webBaseUrl });
};

/** The `McpSessionStore` envelope seam over a freshly built in-process store. */
export const selfHostMcpSessions = (built: SelfHostMcpSessionStore): Layer.Layer<McpSessionStore> =>
  Layer.succeed(McpSessionStore)(built.store);

/** Route 500-defects through the host's console `ErrorCapture`. */
export const selfHostMcpReporter: Layer.Layer<McpErrorReporter> =
  makeConsoleMcpErrorReporter(ErrorCaptureLive);
