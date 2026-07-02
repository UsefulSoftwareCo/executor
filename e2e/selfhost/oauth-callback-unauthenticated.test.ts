import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

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

scenario(
  "OAuth callback · a signed-out self-host callback uses login returnTo and resumes the connection",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const browser = yield* Browser;
    const oauth = yield* serveOAuthTestServer();
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);

    const integration = IntegrationSlug.make(unique("selfhostsignedoutcb"));
    yield* client.openapi.addSpec({
      payload: { ...oauthIntegrationSpec(oauth), slug: integration },
    });

    const clientSlug = OAuthClientSlug.make(unique("selfhostsignedoutc"));
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

    yield* browser.session({ label: "anonymous" }, async ({ page, step }) => {
      await step("Provider sends a signed-out browser to the OAuth callback", async () => {
        const response = await page.goto(callbackPath, { waitUntil: "networkidle" });
        expect(response?.status(), "the callback redirects into the login flow").toBe(200);
        await page.getByText("Sign in to your instance").waitFor();
      });

      const loginUrl = new URL(page.url());
      expect(loginUrl.pathname, "the signed-out callback lands on the sign-in page").toBe("/login");
      expect(
        loginUrl.searchParams.get("returnTo"),
        "login preserves the callback so it can resume after sign-in",
      ).toBe(callbackPath);

      await step("Sign in resumes the original OAuth callback", async () => {
        await page.getByLabel("Email").fill(identity.credentials!.email);
        await page.getByLabel("Password").fill(identity.credentials!.password);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.waitForURL((url) => url.pathname === "/api/oauth/callback", {
          timeout: 30_000,
        });
        await page.waitForFunction(() => document.body.innerText.includes("Connected"), null, {
          timeout: 30_000,
        });
      });

      const body = (await page.locator("body").textContent())?.trim() ?? "";
      expect(new URL(page.url()).pathname, "the login returnTo lands back on the callback").toBe(
        "/api/oauth/callback",
      );
      expect(body, "the callback completes after the sign-in recovery").toContain("Connected");
      expect(body, "the raw protected API response is not shown").not.toContain("Unauthorized");
    });
  }).pipe(Effect.scoped),
);
