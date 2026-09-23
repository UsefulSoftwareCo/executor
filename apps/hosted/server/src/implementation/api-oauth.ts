/** OAuth discovery for ordinary API clients, independent of browser sessions. */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { ApiAuthentication } from "../contracts/auth.ts";

/** RFC 9728 metadata for the organization management API. */
export const apiProtectedResource = Effect.gen(function* () {
  const { origin } = yield* ApiAuthentication;
  return HttpServerResponse.jsonUnsafe({
    resource: `${origin}/api`,
    authorization_servers: [`${origin}/api/auth`],
    scopes_supported: ["executor", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "Executor API",
  });
});

/** API discovery starts with a standard bearer challenge; this is not an API operation. */
export const apiChallenge = Effect.gen(function* () {
  const { origin } = yield* ApiAuthentication;
  return HttpServerResponse.empty({
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api", scope="executor offline_access"`,
    },
  });
});
