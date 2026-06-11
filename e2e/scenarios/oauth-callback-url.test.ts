// The OAuth callback URL a user must allow-list on their provider, surfaced when
// they register an OAuth app. Two guarantees:
//
//   1. Accuracy (every target): the callback the authorization-code flow sends
//      to the provider is `${origin}/api/oauth/callback` — the URL the form
//      shows. Run on cloud + self-host so the per-platform mount prefix is
//      proven, not assumed. `ExecutorApp.make` derives this path from the same
//      `mountPrefix` that mounts the API, so omitting a per-host knob can no
//      longer drift it (it previously 404'd on prefix-mounted self-host).
//   2. Existence (cloud, browser): registering an OAuth app in the connect
//      modal renders that exact URL with a copy affordance, so a user can find
//      and use it.
//
// The form's value and the flow's `redirect_uri` come from the SAME helper
// (`oauthCallbackUrl()` → `${window.location.origin}/api/oauth/callback`), so
// asserting the flow uses `${baseUrl}/api/oauth/callback` is asserting the
// displayed URL is the real one.
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

/** An OpenAPI integration that declares an OAuth (authorization-code) method
 *  pointed at `oauth`, so the connect modal treats it as an OAuth integration
 *  and a `start` flow has something to attach its connection to. */
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
  "OAuth · the authorization-code flow redirects to this platform's /api/oauth/callback",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const oauth = yield* serveOAuthTestServer();
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      // What the registration form shows for THIS target — the same value the
      // React `oauthCallbackUrl()` helper resolves from `window.location`.
      const expectedCallback = new URL("/api/oauth/callback", target.baseUrl).toString();

      const integration = IntegrationSlug.make(unique("cburlint"));
      yield* client.openapi.addSpec({
        payload: { ...oauthIntegrationSpec(oauth), slug: integration },
      });

      const clientSlug = OAuthClientSlug.make(unique("cburlc"));
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

      // start WITHOUT a redirectUri — the platform falls back to its OWN
      // configured callback, which is exactly what the form would have shown.
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
      expect(started.status, "oauth.start hands back a redirect to the authorization server").toBe(
        "redirect",
      );
      const authorizationUrl = started.status === "redirect" ? started.authorizationUrl : "";

      const redirectUri = new URL(authorizationUrl).searchParams.get("redirect_uri");
      expect(
        redirectUri,
        "the authorization request redirects to this platform's served callback",
      ).toBe(expectedCallback);
    }),
  ),
);

scenario(
  "OAuth · registering an app in the connect modal shows the callback URL to allow-list",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const browser = yield* Browser;
    const oauth = yield* serveOAuthTestServer();
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);
    const expectedCallback = new URL("/api/oauth/callback", target.baseUrl).toString();

    // An OAuth integration with no registered app yet, so the connect modal
    // offers the "Register app" CTA (no automatic registration to short-circuit
    // it).
    const integration = IntegrationSlug.make(unique("cburlui"));
    yield* client.openapi.addSpec({
      payload: { ...oauthIntegrationSpec(oauth), slug: integration },
    });

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the connect modal for an OAuth integration", async () => {
        await page.goto(`/integrations/${String(integration)}?addAccount=1`, {
          waitUntil: "networkidle",
        });
        await page.getByRole("button", { name: "Register app", exact: true }).click();
      });

      await step("The OAuth app form shows this platform's callback URL", async () => {
        const callback = page.locator("#oauth-callback-url");
        await callback.waitFor();
        const shown = (await callback.textContent())?.trim();
        expect(shown, "the displayed callback URL matches the platform's served callback").toBe(
          expectedCallback,
        );
      });
    });
  }).pipe(Effect.scoped),
);
