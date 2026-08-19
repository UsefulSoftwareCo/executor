import { Effect, Layer } from "effect";

import { IdentityProvider } from "@executor-js/api/server";
import type {
  McpAuthProvider,
  McpErrorReporter,
  McpSessionStore,
  Principal,
} from "@executor-js/host-mcp";

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
  /**
   * The browser-approval HTTP handler, mounted by the app at
   * `/api/mcp-sessions/*`: a session-cookie-gated web handler that serves the
   * paused-execution detail (GET) and records the human's decision (POST
   * `/resume`) for the console approval page. Browser elicitation mode only.
   */
  readonly approvalHandler: (request: Request) => Promise<Response>;
  /** Dispose all live in-process MCP sessions at shutdown (not a seam). */
  readonly close: () => Promise<void>;
}

const jsonResponse = (value: unknown, status: number): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const parseRoles = (role: string | null | undefined): ReadonlyArray<string> =>
  (role ?? "user")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

type BetterAuthSession = NonNullable<
  Awaited<ReturnType<BetterAuthHandle["auth"]["api"]["getSession"]>>
>;

const principalFromSession = (
  resolved: BetterAuthSession,
  betterAuth: BetterAuthHandle,
): Principal => ({
  accountId: resolved.user.id,
  organizationId: resolved.session.activeOrganizationId ?? betterAuth.organizationId,
  organizationName: betterAuth.organizationName,
  email: resolved.user.email,
  name: resolved.user.name ?? null,
  avatarUrl: resolved.user.image ?? null,
  roles: parseRoles(resolved.user.role ?? null),
});

/**
 * Gate the browser-approval endpoints behind a valid Better Auth session (the
 * console page calls them with the user's cookie), then delegate to the
 * in-process store's paused/resume handlers with the resolved principal so the
 * store can enforce MCP session ownership before exposing or recording a
 * browser-approval decision.
 */
const makeApprovalHandler =
  (
    store: ReturnType<typeof makeSelfHostMcpSessionStore>,
    betterAuth: BetterAuthHandle,
  ): ((request: Request) => Promise<Response>) =>
  async (request) => {
    // A malformed cookie must read as unauthenticated, not 500.
    const session = await Effect.runPromise(
      Effect.tryPromise({
        try: () => betterAuth.auth.api.getSession({ headers: request.headers }),
        catch: () => "session lookup failed",
      }).pipe(Effect.orElseSucceed(() => null)),
    );
    if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
    const principal = principalFromSession(session, betterAuth);

    return (
      (await store.handlePausedRequest(request, principal)) ??
      (await store.handleApprovalRequest(request, principal)) ??
      jsonResponse({ error: "Not found" }, 404)
    );
  };

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
  webBaseUrl?: string,
): SelfHostMcpSeams => {
  const sessionStore = makeSelfHostMcpSessionStore(dbHandle, webBaseUrl);
  const auth: Layer.Layer<McpAuthProvider, never, IdentityProvider> = selfHostMcpAuth.pipe(
    Layer.provide(Layer.succeed(BetterAuth)(betterAuth)),
  );
  return {
    auth,
    sessions: selfHostMcpSessions(sessionStore),
    reporter: selfHostMcpReporter,
    approvalHandler: makeApprovalHandler(sessionStore, betterAuth),
    close: sessionStore.close,
  };
};
