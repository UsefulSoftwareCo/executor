import { Layer } from "effect";

import { IdentityProvider } from "@executor-js/api/server";
import type { McpAuthProvider, McpErrorReporter, McpSessionStore } from "@executor-js/host-mcp";

import { BetterAuth, type BetterAuthHandle } from "../auth/better-auth";
import type { SelfHostDbHandle } from "../db/self-host-db";
import { selfHostMcpAuth } from "./auth";
import {
  makeSelfHostMcpSessionStore,
  selfHostMcpReporter,
  selfHostMcpSessions,
} from "./session-store";

export { selfHostMcpAuth } from "./auth";
export {
  makeSelfHostMcpSessionStore,
  selfHostMcpReporter,
  selfHostMcpSessions,
  McpEngineBuildError,
} from "./session-store";

// ---------------------------------------------------------------------------
// The self-host MCP serving seams, fed to `ExecutorApp.make`'s `mcp` group.
//
// `ExecutorApp.make` mounts the shared, provider-neutral MCP serving envelope
// from @executor-js/host-mcp (the two root OAuth discovery docs + the multi-user
// /mcp endpoint, top-level per the ecosystem convention). The envelope does its
// own auth + session handling and is mounted OUTSIDE the API's execution
// middleware, like /api/auth.
//
// Self-host provides the TWO envelope seams plus an error-reporter override:
//   - McpAuthProvider  -> `selfHostMcpAuth` (Better Auth mcp() OAuth). It still
//                         requires `IdentityProvider`, which `make` provides from
//                         the resolved identity seam.
//   - McpSessionStore  -> `selfHostMcpSessions`: in-process Map. The store owns
//                         dispatch (create + forward + ownership) and builds its
//                         engine internally over the shared SelfHostDb.
//   - McpErrorReporter -> `selfHostMcpReporter`: route 500 defects through the
//                         host's console capture.
//
// The OAuth endpoints (/api/auth/mcp/{register,authorize,token}) stay on the
// Better Auth handler mounted at /api/auth — not in the envelope.
// ---------------------------------------------------------------------------

export interface SelfHostMcpSeams {
  /** Resolve a request to an MCP `AuthOutcome` + declare the discovery routes. */
  readonly auth: Layer.Layer<McpAuthProvider, never, IdentityProvider>;
  /** The in-process session store seam (dispatch + lifetime). */
  readonly sessions: Layer.Layer<McpSessionStore>;
  /** Route 500 defects through the host's console `ErrorCapture`. */
  readonly reporter: Layer.Layer<McpErrorReporter>;
  /** Dispose all live in-process MCP sessions at shutdown (not a seam). */
  readonly close: () => Promise<void>;
}

/**
 * Build the self-host MCP serving seams over the long-lived DB handle. The auth
 * seam is `selfHostMcpAuth` (Better Auth mcp() OAuth), with the Better Auth
 * instance provided; it still requires `IdentityProvider` from the resolved
 * identity seam. Returns the three seam Layers plus the `close()` lifetime hook
 * the app wires into shutdown.
 */
export const makeSelfHostMcpSeams = (
  dbHandle: SelfHostDbHandle,
  betterAuth: BetterAuthHandle,
): SelfHostMcpSeams => {
  const sessionStore = makeSelfHostMcpSessionStore(dbHandle);
  const auth: Layer.Layer<McpAuthProvider, never, IdentityProvider> = selfHostMcpAuth.pipe(
    Layer.provide(Layer.succeed(BetterAuth)(betterAuth)),
  );
  return {
    auth,
    sessions: selfHostMcpSessions(sessionStore),
    reporter: selfHostMcpReporter,
    close: sessionStore.close,
  };
};
