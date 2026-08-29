import { Layer } from "effect";

import {
  IdentityProvider,
  BetterAuth as SharedBetterAuth,
  betterAuthIdentityLayer,
  withForcedMcpConsent,
  rewriteInvalidOrigin,
  consentRedirectClientId,
  withClientName,
} from "@executor-js/api/server";

import type { SelfHostDbHandle } from "../db/self-host-db";
import { loadConfig } from "../config";
import { buildBetterAuth, type BetterAuthHandle } from "./better-auth";

export { BetterAuth, buildBetterAuth, type BetterAuthHandle } from "./better-auth";
export { betterAuthIdentityLayer } from "@executor-js/api/server";

export interface ResolvedAuthProviders {
  readonly identityLayer: Layer.Layer<IdentityProvider>;
  readonly authHandler: (request: Request) => Promise<Response>;
  readonly betterAuth: BetterAuthHandle;
}

export const resolveAuthProviders = async (
  dbHandle: SelfHostDbHandle,
): Promise<ResolvedAuthProviders> => {
  const betterAuth = await buildBetterAuth(dbHandle.client);
  const betterAuthLayer = Layer.succeed(SharedBetterAuth)(betterAuth);

  const lookupClientName = async (clientId: string): Promise<string | null> => {
    const ctx = await betterAuth.auth.$context;
    const app = await ctx.adapter.findOne<{ name?: string | null }>({
      model: "oauthApplication",
      where: [{ field: "clientId", value: clientId }],
    });
    return app?.name ?? null;
  };

  const config = loadConfig();
  const authHandler = async (request: Request): Promise<Response> => {
    const response = await betterAuth.handler(withForcedMcpConsent(request));
    const friendlier = await rewriteInvalidOrigin(request, response, config.webBaseUrl);
    if (friendlier) return friendlier;
    if (response.status !== 302) return response;
    const clientId = consentRedirectClientId(response.headers.get("location"));
    if (!clientId) return response;
    const name = await lookupClientName(clientId);
    if (!name) return response;
    const headers = new Headers(response.headers);
    headers.set("location", withClientName(response.headers.get("location")!, name));
    return new Response(null, { status: 302, headers });
  };

  return {
    identityLayer: betterAuthIdentityLayer.pipe(Layer.provide(betterAuthLayer)),
    authHandler,
    betterAuth,
  };
};
