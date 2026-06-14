import { Layer } from "effect";

import { makeConsoleMcpErrorReporter, makeMcpBuildServer } from "@executor-js/api/server";
import type { McpErrorReporter } from "@executor-js/host-mcp";
import {
  inMemoryMcpSessionsLayer,
  makeInMemoryMcpSessionStore,
  type InMemoryMcpSessionStore,
} from "@executor-js/host-mcp/in-memory-session-store";

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
    ),
    { webBaseUrl },
  );

/** The `McpSessionStore` envelope seam over a freshly built in-process store. */
export const selfHostMcpSessions = inMemoryMcpSessionsLayer;

/** Route 500-defects through the host's console `ErrorCapture`. */
export const selfHostMcpReporter: Layer.Layer<McpErrorReporter> =
  makeConsoleMcpErrorReporter(ErrorCaptureLive);
