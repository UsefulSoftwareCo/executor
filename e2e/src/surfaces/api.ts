// API surface: the typed Effect `HttpApiClient` a real consumer codes against,
// over the wire to the target's dev server. Auth comes from the scenario's
// Identity — either ready-made headers (cloud's stub session cookie) or a
// Better Auth email sign-in (selfhost). Assertions and failure output are
// vitest's job; a failed call surfaces as a typed HttpClientError in the
// test output.
import { Effect } from "effect";
import { HttpApiClient, type HttpApi, type HttpApiGroup } from "effect/unstable/httpapi";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { Identity, Target } from "../target";

export interface ApiSurface {
  /** Typed client for `apiDef`, authenticated as `identity`. */
  readonly client: <ApiId extends string, Groups extends HttpApiGroup.Any>(
    apiDef: HttpApi.HttpApi<ApiId, Groups>,
    identity: Identity,
  ) => Effect.Effect<
    HttpApiClient.Client<Groups>,
    unknown,
    HttpClient.HttpClient | HttpApiGroup.MiddlewareClient<Groups>
  >;
}

export const makeApiSurface = (target: Target): ApiSurface => ({
  client: (apiDef, identity) =>
    Effect.gen(function* () {
      const headers = identity.headers ?? (yield* signInHeaders(target.baseUrl, identity));
      return yield* HttpApiClient.make(apiDef, {
        baseUrl: new URL("/api", target.baseUrl).toString(),
        transformClient: HttpClient.mapRequest((request) =>
          Object.entries(headers).reduce(
            (req, [key, value]) => HttpClientRequest.setHeader(req, key, value),
            request,
          ),
        ),
      });
    }),
});

// Better Auth email sign-in → session cookie (selfhost). The `origin` header is
// required: Better Auth rejects state-changing requests without one.
const signInHeaders = (baseUrl: string, identity: Identity) =>
  Effect.promise(async (): Promise<Record<string, string>> => {
    const credentials = identity.credentials;
    if (!credentials) throw new Error(`identity ${identity.label} has no headers or credentials`);
    const response = await fetch(new URL("/api/auth/sign-in/email", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(baseUrl).origin },
      body: JSON.stringify(credentials),
      redirect: "manual",
    });
    const cookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    if (!cookie) throw new Error(`api: sign-in set no cookie (${response.status})`);
    return { cookie };
  });
