// ---------------------------------------------------------------------------
// OAuth metadata endpoints — returned as web `Response`s for the envelope's
// discovery routes.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { AUTHKIT_DOMAIN, resourceUrlFor } from "./auth";
import { CORS_ALLOW_ORIGIN } from "./responses";

const jsonWebResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_ALLOW_ORIGIN },
  });

// The `resource` reflects the URL-pinned org (`…/org_xxx/mcp`) when present, so a
// client that discovered metadata via the org-scoped well-known doc gets back the
// matching org-scoped resource id; the bare path yields the bare resource.
export const protectedResourceMetadataResponse = (
  organizationId: string | null = null,
  toolkitSlug: string | null = null,
): Response =>
  jsonWebResponse({
    resource: resourceUrlFor(organizationId, toolkitSlug),
    authorization_servers: [AUTHKIT_DOMAIN],
    bearer_methods_supported: ["header"],
    // Spec-faithful clients (OpenCode, mcporter) request exactly what is
    // advertised here; without offline_access they get no refresh token and
    // silently sign out at every access-token expiry.
    scopes_supported: ["openid", "profile", "email", "offline_access"],
  });

export const authorizationServerMetadataResponse: Effect.Effect<Response> = Effect.tryPromise({
  try: async () => {
    const res = await fetch(`${AUTHKIT_DOMAIN}/.well-known/oauth-authorization-server`);
    if (!res.ok) return jsonWebResponse({ error: "upstream_error" }, 502);
    return jsonWebResponse(await res.json());
  },
  catch: () => undefined,
}).pipe(Effect.catchCause(() => Effect.succeed(jsonWebResponse({ error: "upstream_error" }, 502))));
