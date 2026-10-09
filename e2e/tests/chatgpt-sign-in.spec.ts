import { expect, layer } from "@effect/vitest";
import { Config, Effect, Redacted, Ref, Schema } from "effect";
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

const Authorization = Schema.Struct({ url: Schema.RedactedFromValue(Schema.String) });

layer(FetchHttpClient.layer, { excludeTestServices: true })("ChatGPT preview sign-in", (it) => {
  it.effect("returns through the registered host to browser-bound PKCE state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const origin = yield* Config.String("CHATGPT_PREVIEW_ORIGIN");
        const callbackOrigin = yield* Config.String("CHATGPT_CALLBACK_ORIGIN");
        const edgeOrigin = yield* Config.String("CHATGPT_EDGE_ORIGIN");
        for (const at of [origin, callbackOrigin, edgeOrigin])
          expect(new URL(at).hostname.endsWith(".executor.engineering")).toBe(true);
        const jar = yield* Ref.make(Cookies.empty);
        const http = (yield* HttpClient.HttpClient).pipe(HttpClient.withCookiesRef(jar));
        const request = (path: string, body: unknown) =>
          HttpClientRequest.post(`${origin}${path}`, {
            headers: { origin, "x-skip-oauth-proxy": "true" },
          }).pipe(HttpClientRequest.bodyJson(body), Effect.flatMap(http.execute));
        const start = Effect.gen(function* () {
          const response = yield* request("/api/auth/sign-in/social", {
            provider: "openai",
            callbackURL: "/",
            errorCallbackURL: "/login",
            disableRedirect: true,
          });
          expect(response.status).toBe(200);
          const data = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Authorization)),
          );
          const url = new URL(Redacted.value(data.url));
          expect(url.origin).toBe("https://auth.openai.com");
          expect(url.pathname).toBe("/api/accounts/authorize");
          expect(url.searchParams.get("redirect_uri")).toBe(
            `${callbackOrigin}/api/auth/callback/openai`,
          );
          expect(url.searchParams.get("response_type")).toBe("code");
          expect(url.searchParams.get("code_challenge_method")).toBe("S256");
          expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([
            "email",
            "openid",
            "profile",
          ]);
          expect(url.searchParams.has("client_secret")).toBe(false);
          for (const key of ["state", "nonce", "code_challenge"])
            expect((url.searchParams.get(key)?.length ?? 0) >= 16).toBe(true);
          return url;
        });
        const page = yield* http.get(`${origin}/login`);
        expect(page.status).toBe(200);
        expect(yield* page.text).toContain("Continue with ChatGPT");
        const formerLogin = yield* http.get(`${callbackOrigin}/login?mode=signup`);
        expect(formerLogin.status).toBe(308);
        expect(formerLogin.headers.location).toBe(`${origin}/login?mode=signup`);
        expect(formerLogin.headers["cache-control"]).toContain("no-store");
        for (const asset of ["chatgpt-black.svg", "chatgpt-white.svg"]) {
          const response = yield* http.get(`${origin}/auth/${asset}`);
          expect(response.status).toBe(200);
          expect(yield* response.text).toContain("<svg");
        }
        const first = yield* start;
        const second = yield* start;
        for (const key of ["state", "nonce", "code_challenge"])
          expect(first.searchParams.get(key) !== second.searchParams.get(key)).toBe(true);
        const callback = new URL(`${callbackOrigin}/api/auth/callback/openai`);
        callback.searchParams.set(
          "state",
          yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
            second.searchParams.get("state"),
          ),
        );
        callback.searchParams.set("error", "access_denied");
        const browserCallback = new URL(`${callback.pathname}${callback.search}`, origin);
        // Both supported stable callback hosts preserve the entire transaction while returning
        // to the browser host. Neither redirect consumes state or creates a session on that host.
        for (const [at, status] of [
          [callbackOrigin, 308],
          [edgeOrigin, 302],
        ] as const) {
          const redirected = yield* http.get(new URL(`${callback.pathname}${callback.search}`, at));
          expect(redirected.status).toBe(status);
          expect(redirected.headers.location).toBe(browserCallback.href);
          expect(redirected.headers["cache-control"]).toContain("no-store");
          expect(redirected.headers["set-cookie"]).toBeUndefined();
        }
        const cancelled = yield* http.get(browserCallback.href);
        expect(cancelled.status).toBe(302);
        expect(
          new URL(
            yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(cancelled.headers.location),
            origin,
          ).searchParams.get("error"),
        ).toBe("access_denied");
        const replay = yield* http.get(browserCallback.href);
        expect(replay.status).toBe(302);
        expect(
          new URL(
            yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(replay.headers.location),
            origin,
          ).searchParams.get("error"),
        ).not.toBe("access_denied");
        const missing = yield* http.get(`${origin}/api/auth/callback/openai?code=invalid`);
        expect(missing.status).toBe(302);
        expect(
          new URL(
            yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(missing.headers.location),
            origin,
          ).searchParams.get("error"),
        ).toBe("state_not_found");
        const forged = yield* request("/api/auth/sign-in/social", {
          provider: "openai",
          idToken: { token: "eyJhbGciOiJub25lIn0.e30." },
        });
        expect(forged.status).toBe(401);
        yield* forged.text;
        const session = yield* http.get(`${origin}/api/auth/get-session`);
        expect(session.status).toBe(200);
        expect(yield* session.json).toBeNull();
      }).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })),
    ),
  );
});
