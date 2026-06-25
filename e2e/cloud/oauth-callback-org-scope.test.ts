// Cloud-only: OAuth callbacks must preserve the URL-selected organization.
//
// A browser session cookie can be pinned to org B while a tab is operating in
// org A via the URL org selector. OAuth redirects leave the console route and
// land on /api/oauth/callback, so the callback URL itself must carry the same
// org selector that was present when oauth.start created the session.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  EXECUTOR_ORG_SELECTOR_HEADER,
  IntegrationSlug,
  OAUTH_CALLBACK_ORG_QUERY_PARAM,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import type { Identity } from "../src/target";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

const cookiePair = (response: Response, name: string): string | undefined => {
  for (const header of response.headers.getSetCookie?.() ?? []) {
    if (header.startsWith(`${name}=`)) return header.split(";")[0];
  }
  return undefined;
};

const cookieValue = (pair: string): string => {
  const [, value] = pair.split(/=(.*)/s);
  if (!value) throw new Error("cookie pair has no value");
  return value;
};

const cookieOf = (identity: Identity): string => identity.headers?.cookie ?? "";

const originHeaders = (baseUrl: string) => ({ origin: new URL(baseUrl).origin });

const activeOrg = (baseUrl: string, cookie: string) =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/auth/me", baseUrl), {
      headers: { cookie },
    });
    if (!response.ok) throw new Error(`/api/auth/me failed (${response.status})`);
    const body = (await response.json()) as {
      organization: { id: string; name: string; slug: string } | null;
    };
    if (!body.organization) throw new Error("identity has no active organization");
    return body.organization;
  });

const createOrganization = (baseUrl: string, cookie: string, name: string) =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/auth/create-organization", baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        ...originHeaders(baseUrl),
      },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      throw new Error(`/api/auth/create-organization failed (${response.status})`);
    }
    const session = cookiePair(response, "wos-session");
    if (!session) throw new Error("create organization did not refresh the session");
    const org = (await response.json()) as { id: string; name: string; slug: string };
    return { org, session };
  });

const oauthIntegrationSpec = (oauth: {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}) =>
  ({
    spec: {
      kind: "blob" as const,
      value: JSON.stringify({
        openapi: "3.0.3",
        info: { title: "OAuth org scope", version: "1.0.0" },
        paths: {
          "/me": {
            get: {
              operationId: "getMe",
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

scenario(
  "OAuth callback · URL-scoped org survives a callback while the session cookie points elsewhere",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const browser = yield* Browser;
    const oauth = yield* serveOAuthTestServer();

    const identity = yield* target.newIdentity();
    const sessionA = cookieOf(identity);
    const orgA = yield* activeOrg(target.baseUrl, sessionA);

    const { org: orgB, session: sessionB } = yield* createOrganization(
      target.baseUrl,
      sessionA,
      `OAuth Callback Org B ${randomBytes(3).toString("hex")}`,
    );
    expect(orgB.slug, "the test has two distinct org URLs").not.toBe(orgA.slug);

    const scopedToOrgAWithCookieB: Identity = {
      ...identity,
      headers: {
        cookie: sessionB,
        [EXECUTOR_ORG_SELECTOR_HEADER]: orgA.slug,
      },
      cookies: [{ name: "wos-session", value: cookieValue(sessionB) }],
    };

    const client = yield* makeApiClient(api, scopedToOrgAWithCookieB);

    const integration = IntegrationSlug.make(unique("oauthscope"));
    yield* client.openapi.addSpec({
      payload: { ...oauthIntegrationSpec(oauth), slug: integration },
    });

    const clientSlug = OAuthClientSlug.make(unique("oauthc"));
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

    yield* browser.session(scopedToOrgAWithCookieB, async ({ page, step }) => {
      await step(
        "Provider returns to the OAuth callback while the cookie is pinned to org B",
        async () => {
          const response = await page.goto(callbackPath, { waitUntil: "networkidle" });
          expect(response?.status(), "the callback renders its popup result page").toBe(200);
        },
      );

      const body = (await page.locator("body").textContent())?.trim() ?? "";
      expect(
        body,
        "the callback completes in the org where oauth.start stored the session",
      ).toContain("Connected");
      expect(body, "the callback did not fall through to the cookie-pinned org").not.toContain(
        "OAuth session expired or not found",
      );
    });

    expect(
      callback.searchParams.get(OAUTH_CALLBACK_ORG_QUERY_PARAM),
      "the provider callback URL carries the original org selector",
    ).toBe(orgA.slug);
  }).pipe(Effect.scoped),
);
