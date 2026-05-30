import { Layer } from "effect";

import { IdentityProvider } from "@executor-js/api/server";

import type { SelfHostDbHandle } from "../db/self-host-db";
import { BetterAuth, buildBetterAuth, type BetterAuthHandle } from "./better-auth";
import { betterAuthIdentityLayer } from "./identity";

export { BetterAuth, buildBetterAuth, type BetterAuthHandle } from "./better-auth";
export { betterAuthIdentityLayer } from "./identity";

// ---------------------------------------------------------------------------
// Resolve the self-host auth providers.
//
// Build the Better Auth instance over the shared libSQL file, expose its
// `IdentityProvider` (cookie/bearer/api-key) and its web handler (mounted at
// /api/auth/*). Returns the live `BetterAuthHandle` so the composition root can
// build the account API and the Better Auth MCP OAuth seam.
//
// This is the one and only production auth path. Tests that need a fake identity
// (single-admin / header-driven) compose `ExecutorApp.make` directly through
// `makeSelfHostTestApp` (src/testing/test-app.ts) rather than passing through
// here, so this resolution is unconditional.
// ---------------------------------------------------------------------------

export interface ResolvedAuthProviders {
  /** The resolved Better Auth `IdentityProvider` seam (cookie/bearer/api-key). */
  readonly identityLayer: Layer.Layer<IdentityProvider>;
  /** Better Auth's web handler (`/api/auth/*`). */
  readonly authHandler: (request: Request) => Promise<Response>;
  /** The live Better Auth handle (account API + Better Auth MCP OAuth seam). */
  readonly betterAuth: BetterAuthHandle;
}

export const resolveAuthProviders = async (
  dbHandle: SelfHostDbHandle,
): Promise<ResolvedAuthProviders> => {
  const betterAuth = await buildBetterAuth(dbHandle.url, dbHandle.client);
  const betterAuthLayer = Layer.succeed(BetterAuth)(betterAuth);
  return {
    identityLayer: betterAuthIdentityLayer.pipe(Layer.provide(betterAuthLayer)),
    authHandler: betterAuth.handler,
    betterAuth,
  };
};
