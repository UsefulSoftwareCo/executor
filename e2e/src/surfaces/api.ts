// API surface driver: a typed Effect `HttpApiClient`, derived from a host's own
// `HttpApi` definition (passed in — keeps this generic across hosts), authed via
// the Better Auth cookie. Tests drive the public API through the exact typed
// client a real consumer uses. Provide `FetchHttpClient.layer` when running.
import { Effect } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export interface MakeApiClientOptions {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
}

export const makeApiClient = <A extends Parameters<typeof HttpApiClient.make>[0]>(
  api: A,
  { baseUrl, email, password }: MakeApiClientOptions,
) =>
  Effect.gen(function* () {
    const origin = new URL(baseUrl).origin;
    const signIn = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/sign-in/email", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email, password }),
        redirect: "manual",
      }),
    );
    const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    if (!cookie) return yield* Effect.die(new Error(`api: sign-in set no cookie (${signIn.status})`));
    return yield* HttpApiClient.make(api, {
      baseUrl: new URL("/api", baseUrl).toString(),
      transformClient: HttpClient.mapRequest((req) => HttpClientRequest.setHeader(req, "cookie", cookie)),
    });
  });
