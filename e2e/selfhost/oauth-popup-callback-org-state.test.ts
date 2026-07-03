import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  decodeOAuthCallbackState,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

const oauthIntegrationSpec = (oauth: {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}) =>
  ({
    spec: {
      kind: "blob" as const,
      value: JSON.stringify({
        openapi: "3.0.3",
        info: { title: "OAuth-protected API", version: "1.0.0" },
        paths: {
          "/me": {
            get: {
              operationId: "getMe",
              tags: ["default"],
              responses: { "200": { description: "the caller" } },
            },
          },
        },
      }),
    },
    baseUrl: "http://127.0.0.1:59999",
    authenticationTemplate: [
      {
        slug: "oauth",
        kind: "oauth2" as const,
        authorizationUrl: oauth.authorizationEndpoint,
        tokenUrl: oauth.tokenEndpoint,
        scopes: ["read"],
      },
    ],
  }) as const;

// Better Auth email sign-in → session cookie, so the callback (a browser GET
// behind the session) can be driven with a plain authenticated fetch. Mirrors
// what the API surface does internally; kept local to keep this a black-box HTTP
// journey with no browser dependency.
const sessionCookie = (baseUrl: string, credentials: { email: string; password: string }) =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/auth/sign-in/email", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(baseUrl).origin },
      body: JSON.stringify(credentials),
    });
    const cookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    if (!cookie) throw new Error(`sign-in set no cookie (${response.status})`);
    return cookie;
  });

// Regression guard for the org-wrapped callback state. Self-host binds every
// request to an org slug ("default"), so `oauth.start` wraps the raw session
// token in the state it sends the provider. The provider echoes that wrapped
// value back on the callback; the shared popup callback must unwrap it to the
// raw token before looking up the session. Before the fix it passed the wrapped
// value straight to `oauth.complete`, which looks up by the raw token and failed
// with "OAuth session expired or not found".
scenario(
  "OAuth callback · a self-host org-context popup callback completes with the wrapped state",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const oauth = yield* serveOAuthTestServer();
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);

    const integration = IntegrationSlug.make(unique("selfhostorgstate"));
    yield* client.openapi.addSpec({
      payload: { ...oauthIntegrationSpec(oauth), slug: integration },
    });

    const clientSlug = OAuthClientSlug.make(unique("selfhostorgstate"));
    yield* client.oauth.createClient({
      payload: {
        owner: "org",
        slug: clientSlug,
        authorizationUrl: oauth.authorizationEndpoint,
        tokenUrl: oauth.tokenEndpoint,
        grant: "authorization_code",
        clientId: "test-client",
        clientSecret: "test-secret",
      },
    });

    const started = yield* client.oauth.start({
      payload: {
        client: clientSlug,
        clientOwner: "org",
        owner: "org",
        name: ConnectionName.make("main"),
        integration,
        template: AuthTemplateSlug.make("oauth"),
      },
    });
    expect(started.status, "oauth.start begins at the provider").toBe("redirect");
    const authorizationUrl = started.status === "redirect" ? started.authorizationUrl : "";

    // The bug's precondition: the state sent to the provider is NOT the raw
    // session token, it is the org-slug-wrapped envelope. If this stops being
    // true the callback path below no longer exercises the regression.
    const providerState = new URL(authorizationUrl).searchParams.get("state") ?? "";
    expect(
      decodeOAuthCallbackState(providerState),
      "self-host org context wraps the OAuth state with the org slug before redirecting",
    ).not.toBeNull();

    const authorize = yield* Effect.promise(() => fetch(authorizationUrl, { redirect: "manual" }));
    expect(authorize.status, "the provider asks the user to log in").toBe(302);
    const consent = yield* Effect.promise(() =>
      fetch(authorize.headers.get("location") ?? "", {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Basic ${Buffer.from("alice:password").toString("base64")}`,
        },
      }),
    );
    expect(consent.status, "provider consent redirects back to Executor").toBe(302);
    const callback = new URL(consent.headers.get("location") ?? "");
    const callbackPath = `${callback.pathname}${callback.search}`;
    expect(
      callback.searchParams.get("state"),
      "the provider echoes the wrapped state back on the callback",
    ).toBe(providerState);

    const cookie = yield* sessionCookie(target.baseUrl, identity.credentials!);
    const response = yield* Effect.promise(() =>
      fetch(new URL(callbackPath, target.baseUrl), { headers: { cookie } }),
    );
    expect(response.status, "the callback renders its popup HTML").toBe(200);
    const html = yield* Effect.promise(() => response.text());

    expect(
      html,
      "the wrapped state is unwrapped to the raw token, so the session is found and completes",
    ).toContain("Connected");
    expect(
      html,
      "the raw session token is recovered from the wrapped state (no expired-session error)",
    ).not.toContain("OAuth session expired or not found");
  }).pipe(Effect.scoped),
);
