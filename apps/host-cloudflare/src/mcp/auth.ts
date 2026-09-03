import { Effect, Layer } from "effect";

import {
  authenticated,
  defaultMcpResource,
  McpAuthProvider,
  mcpResourceFromPathname,
  mcpResourcePath,
  unauthorized,
  type McpDiscoveryRoute,
  type McpResource,
} from "@executor-js/host-mcp";

import { makeAccessVerifier } from "../auth/cloudflare-access";
import type { CloudflareConfig } from "../config";

const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const MCP_PROTECTED_RESOURCE_METADATA_PATH = `${PROTECTED_RESOURCE_METADATA_PATH}/mcp`;
const SCOPED_PROTECTED_RESOURCE_METADATA_PATHS = [
  `${MCP_PROTECTED_RESOURCE_METADATA_PATH}/toolkits/:slug`,
  `${MCP_PROTECTED_RESOURCE_METADATA_PATH}/integrations/:slugs`,
  `${MCP_PROTECTED_RESOURCE_METADATA_PATH}/tools/:toolId`,
] as const;

// The resource a request names, whether it dialed the transport path or its
// metadata doc. The grammar is the shared one from host-mcp.
const resourceForRequest = (request: Request): McpResource => {
  const pathname = new URL(request.url).pathname;
  const bare = pathname.startsWith(PROTECTED_RESOURCE_METADATA_PATH)
    ? pathname.slice(PROTECTED_RESOURCE_METADATA_PATH.length)
    : pathname;
  return mcpResourceFromPathname(bare) ?? defaultMcpResource;
};

const resourcePathForRequest = (request: Request): string =>
  mcpResourcePath(resourceForRequest(request));

const metadataPathForRequest = (request: Request): string =>
  `${PROTECTED_RESOURCE_METADATA_PATH}${resourcePathForRequest(request)}`;

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
    ...SCOPED_PROTECTED_RESOURCE_METADATA_PATHS.map((path) => ({
      path,
      handler: (request: Request) => Effect.succeed(protectedResourceMetadataResponse(request)),
    })),
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
