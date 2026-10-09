/** OAuth discovery for ordinary API clients, independent of browser sessions. */
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { requestResourceOrigin } from "@executor-js/mcp-auth";
import { ApiAuthentication } from "../contracts/auth.ts";

/** RFC 9728 metadata for the organization management API. */
export const apiProtectedResource = Effect.gen(function* () {
  const { issuer, resourceOrigins } = yield* ApiAuthentication;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const resourceOrigin = requestResourceOrigin(resourceOrigins.api, request.headers.host);
  return HttpServerResponse.jsonUnsafe({
    resource: `${resourceOrigin}/api`,
    authorization_servers: [issuer],
    scopes_supported: ["executor", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "Executor API",
  });
});

/** API discovery starts with a standard bearer challenge; this is not an API operation. */
export const apiChallenge = Effect.gen(function* () {
  const { resourceOrigins } = yield* ApiAuthentication;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const resourceOrigin = requestResourceOrigin(resourceOrigins.api, request.headers.host);
  return HttpServerResponse.empty({
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": `Bearer resource_metadata="${resourceOrigin}/.well-known/oauth-protected-resource/api", scope="executor offline_access"`,
    },
  });
});
