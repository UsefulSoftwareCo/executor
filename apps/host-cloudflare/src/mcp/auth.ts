import { Effect, Layer } from "effect";

import {
  authenticated,
  McpAuthProvider,
  unauthorized,
  type McpDiscoveryRoute,
} from "@executor-js/host-mcp";

import { makeAccessVerifier } from "../auth/cloudflare-access";
import type { CloudflareConfig } from "../config";

const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const MCP_PROTECTED_RESOURCE_METADATA_PATH = `${PROTECTED_RESOURCE_METADATA_PATH}/mcp`;
const TOOLKIT_PROTECTED_RESOURCE_METADATA_PATH = `${MCP_PROTECTED_RESOURCE_METADATA_PATH}/toolkits/:toolkitSlug`;

const toolkitSlugFromPath = (pathname: string): string | undefined => {
  const mcpPrefix = "/mcp/toolkits/";
  if (pathname.startsWith(mcpPrefix)) {
    const slug = pathname.slice(mcpPrefix.length).split("/", 1)[0];
    return slug ? decodeURIComponent(slug) : undefined;
  }
  const metadataPrefix = `${MCP_PROTECTED_RESOURCE_METADATA_PATH}/toolkits/`;
  if (pathname.startsWith(metadataPrefix)) {
    const slug = pathname.slice(metadataPrefix.length).split("/", 1)[0];
    return slug ? decodeURIComponent(slug) : undefined;
  }
  return undefined;
};

const toolkitPath = (slug: string): string => `/mcp/toolkits/${encodeURIComponent(slug)}`;

const resourcePathForRequest = (request: Request): string => {
  const slug = toolkitSlugFromPath(new URL(request.url).pathname);
  return slug ? toolkitPath(slug) : "/mcp";
};

const metadataPathForRequest = (request: Request): string => {
  const slug = toolkitSlugFromPath(new URL(request.url).pathname);
  return slug
    ? `${MCP_PROTECTED_RESOURCE_METADATA_PATH}/toolkits/${encodeURIComponent(slug)}`
    : MCP_PROTECTED_RESOURCE_METADATA_PATH;
};

const protectedResourceMetadataResponse = (request: Request): Response => {
  const url = new URL(request.url);
  return new Response(
    JSON.stringify({
      resource: new URL(resourcePathForRequest(request), url.origin).toString(),
      authorization_servers: [],
    }),
    { headers: { "content-type": "application/json" } },
  );
};

// ---------------------------------------------------------------------------
// Cloudflare Access McpAuthProvider — the `/mcp` gate, identical identity to the
// API gate. Cloudflare Access sits in front of the Worker and forwards the
// signed `Cf-Access-Jwt-Assertion` on every request, including `/mcp`. So the
// MCP auth seam reuses the SAME `makeAccessVerifier` the IdentityProvider uses:
// validate the JWT, map claims onto the neutral `Principal`, done.
//
// There is no MCP OAuth here. Auth is Access's browser/service-token flow, not
// the MCP `/authorize`+`/token` dance — so `discoveryRoutes` is empty and the
// 401 challenge points at a nominal protected-resource URL only to satisfy
// clients that probe for it. An external MCP client authenticates by presenting
// an Access JWT (or `Cf-Access-Client-Id`/`-Secret` service-token headers, which
// Access converts to one). When MCP OAuth-over-Access is needed, add the
// discovery docs + a token endpoint here behind this same seam.
// ---------------------------------------------------------------------------

export const cloudflareAccessMcpAuth = (config: CloudflareConfig): Layer.Layer<McpAuthProvider> => {
  const { verify } = makeAccessVerifier(config);
  const discoveryRoutes: ReadonlyArray<McpDiscoveryRoute> = [
    {
      path: PROTECTED_RESOURCE_METADATA_PATH,
      handler: (request) => Effect.succeed(protectedResourceMetadataResponse(request)),
    },
    {
      path: MCP_PROTECTED_RESOURCE_METADATA_PATH,
      handler: (request) => Effect.succeed(protectedResourceMetadataResponse(request)),
    },
    {
      path: TOOLKIT_PROTECTED_RESOURCE_METADATA_PATH,
      handler: (request) => Effect.succeed(protectedResourceMetadataResponse(request)),
    },
  ];
  return Layer.succeed(McpAuthProvider)({
    discoveryRoutes,
    resourceMetadataUrl: (request) =>
      new URL(metadataPathForRequest(request), new URL(request.url).origin).toString(),
    authenticate: (request) =>
      verify(request).pipe(
        Effect.map((principal) => (principal ? authenticated(principal) : unauthorized())),
      ),
  });
};
