// A Target is one deployed shape of the product (cloud / selfhost / …) seen
// purely from the outside: base URLs, how to mint a fresh isolated identity,
// and which capabilities it supports. Scenarios are written once against this
// interface; vitest projects pick which target a run executes on via
// E2E_TARGET. Boot/teardown of the instance is NOT here — each app owns its
// own dev-server boot (see setup/*.globalsetup.ts which call into the app).
import type { Effect } from "effect";

// Deployment traits only. Host-environment services (the OpenCode binary)
// and ones implied by an optional Target method (setAccessTokenTtl →
// TtlControl) are derived in scenario.ts, not declared here.
export type Capability =
  | "api" // typed HttpApiClient over the wire
  | "browser" // web UI reachable + identity injectable into a browser context
  | "mcp-oauth" // MCP endpoint with a headless OAuth consent path
  | "billing"; // billing limits are enforced (cloud-only)

export interface Identity {
  /** Shown in transcripts ("user_ab12cd") */
  readonly label: string;
  /** Headers that authenticate API requests (e.g. a session cookie). */
  readonly headers?: Record<string, string>;
  /** Cookies to inject into a browser context for a logged-in page. */
  readonly cookies?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  /** Credentials for surfaces that sign in themselves (Better Auth, OAuth consent). */
  readonly credentials?: { readonly email: string; readonly password: string };
}

export interface Target {
  readonly name: string;
  readonly baseUrl: string;
  readonly mcpUrl: string;
  readonly capabilities: ReadonlySet<Capability>;
  /**
   * Mint a fresh identity — THE isolation model: no resets, every scenario
   * is its own user (and org where applicable) on the shared instance.
   * `org: false` yields an identity with no active organization (for flows
   * that create one, like onboarding / billing limits).
   */
  readonly newIdentity: (options?: { readonly org?: boolean }) => Effect.Effect<Identity>;
  /** Headless OAuth consent for the MCP surface, when "mcp-oauth" is supported. */
  readonly mcpConsent?: (
    identity: Identity,
  ) => (request: { authorizationUrl: string; redirectUrl: string }) => Promise<{ code: string }>;
  /**
   * Compress (or restore, with null) the authorization server's access-token
   * lifetime, when "ttl-control" is supported — what lets token-expiry
   * scenarios cross a REAL expiry in seconds instead of an hour.
   */
  readonly setAccessTokenTtl?: (seconds: number | null) => Effect.Effect<void>;
}
