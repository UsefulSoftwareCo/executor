// First-party OAuth clients: the cloud host declares executor-owned apps via
// env (`FIRST_PARTY_GITHUB_CLIENT_ID/SECRET`, set by the e2e cloud boot), and
// every org can connect through them with nothing to paste. Three guarantees:
//
//   1. Listing: `oauth.listClients` surfaces `first-party:github` with a
//      `first_party` origin and its public client id — no create call ever ran.
//   2. Flow: the returned URL opens installation guidance, then preserves the
//      original provider authorization URL, PKCE and organization routing.
//      GitHub's links are checked without contacting the live provider.
//   3. Guardrails: the reserved `first-party:` namespace is rejected by
//      createClient, so no org can shadow the host's app with its own row.
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

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

/** A minimal integration whose OAuth template points at GitHub's endpoints, so
 *  the first-party `first-party:github` app is the matching client for it. */
const githubShapedIntegrationSpec = {
  spec: {
    kind: "blob" as const,
    value: JSON.stringify({
      openapi: "3.0.3",
      info: { title: "GitHub-shaped API", version: "1.0.0" },
      paths: {
        "/user": {
          get: {
            operationId: "getUser",
            tags: ["default"],
            responses: { "200": { description: "the caller" } },
          },
        },
      },
    }),
  },
  baseUrl: "https://api.github.com",
  authenticationTemplate: [
    {
      slug: "oauth",
      kind: "oauth2" as const,
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "read:org"],
    },
  ],
} as const;

const googleShapedIntegrationSpec = (scopes: readonly string[]) => ({
  spec: {
    kind: "blob" as const,
    value: JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Google-shaped API", version: "1.0.0" },
      paths: {
        "/resource": {
          get: {
            operationId: "getResource",
            tags: ["default"],
            responses: { "200": { description: "a Google resource" } },
          },
        },
      },
    }),
  },
  baseUrl: "https://www.googleapis.com",
  authenticationTemplate: [
    {
      slug: "oauth",
      kind: "oauth2" as const,
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes,
    },
  ],
});

scenario(
  "First-party OAuth · GitHub setup includes installation before authorization",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      // First-party registrations are a cloud-host capability. This scenario
      // intentionally does not apply to self-host, whose operator supplies
      // their own OAuth apps through its existing registration flow.
      if (target.name !== "cloud") return;
      const { client: makeApiClient } = yield* Api;
      const browser = yield* Browser;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      // 1. The config-declared app appears in listings with its public id.
      const clients = yield* client.oauth.listClients();
      const firstParty = clients.find((c) => String(c.slug) === "first-party:github");
      expect(firstParty, "the env-declared first-party GitHub app is listed").toBeDefined();
      expect(firstParty?.origin.kind).toBe("first_party");
      expect(firstParty?.clientId).toBe("e2e-first-party-github");

      // 2. A start through the first-party slug builds GitHub's authorize URL
      //    from the config identity and this platform's served callback.
      const integration = IntegrationSlug.make(unique("fpgh"));
      yield* Effect.addFinalizer(() =>
        client.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore),
      );
      yield* client.openapi.addSpec({
        payload: { ...githubShapedIntegrationSpec, slug: integration },
      });
      const started = yield* client.oauth.start({
        payload: {
          client: OAuthClientSlug.make("first-party:github"),
          clientOwner: "org",
          owner: "org",
          name: ConnectionName.make("main"),
          integration,
          template: AuthTemplateSlug.make("oauth"),
        },
      });
      expect(started.status, "oauth.start opens setup").toBe("redirect");
      if (started.status !== "redirect") return yield* Effect.die("expected redirect");
      yield* Effect.addFinalizer(() =>
        client.oauth.cancel({ payload: { state: started.state } }).pipe(Effect.ignore),
      );
      const setupUrl = new URL(started.authorizationUrl);
      expect(setupUrl.origin + setupUrl.pathname).toBe(
        new URL("/api/oauth/setup", target.baseUrl).toString(),
      );
      // A URL supplied by a caller must never replace the saved continuation.
      setupUrl.searchParams.set("authorization_url", "https://example.invalid/phishing");
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open GitHub setup and find repository installation", async () => {
          const response = await page.goto(setupUrl.toString());
          expect(response?.status()).toBe(200);
          expect(response?.headers()["cache-control"]).toBe("no-store");
          await page.getByRole("heading", { name: "Connect GitHub", exact: true }).waitFor();
          const install = page.getByRole("link", { name: "Install or configure GitHub App" });
          expect(await install.getAttribute("href")).toBe(
            "https://github.com/apps/executor-sh/installations/new",
          );
          expect(await install.getAttribute("target")).toBe("_blank");
          const authorize = new URL(
            (await page
              .getByRole("link", { name: "Continue to authorization" })
              .getAttribute("href"))!,
          );
          expect(authorize.origin + authorize.pathname).toBe(
            "https://github.com/login/oauth/authorize",
          );
          expect(authorize.searchParams.get("client_id")).toBe("e2e-first-party-github");
          expect(authorize.searchParams.get("redirect_uri")).toBe(
            new URL("/api/oauth/callback", target.baseUrl).toString(),
          );
          expect(authorize.searchParams.get("state")).toBe(setupUrl.searchParams.get("state"));
          expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
          expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
          expect(authorize.searchParams.has("scope")).toBe(false);
        });
        await step("Read setup in light mode", async () => {
          await page.emulateMedia({ colorScheme: "light" });
        });
        await step("Choose access on a narrow screen", async () => {
          await page.setViewportSize({ width: 390, height: 844 });
          expect(
            await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth),
          ).toBe(true);
        });
        await step("Read setup in dark mode on a narrow screen", async () => {
          await page.emulateMedia({ colorScheme: "dark" });
        });
        await step("Cancel setup and reopen the expired link", async () => {
          await Effect.runPromise(client.oauth.cancel({ payload: { state: started.state } }));
          const response = await page.goto(setupUrl.toString());
          expect(response?.status()).toBe(410);
          await page.getByRole("heading", { name: "Connection setup unavailable" }).waitFor();
          expect(await page.getByRole("link", { name: "Continue to authorization" }).count()).toBe(
            0,
          );
        });
      });

      // 3. The reserved namespace cannot be shadowed by a stored row. The
      //    server rejects with a StorageError, which the HTTP edge scrubs to an
      //    opaque InternalError — assert the rejection, then prove the listed
      //    app is still the config-declared one (same public id, same origin).
      yield* client.oauth
        .createClient({
          payload: {
            owner: "org",
            slug: OAuthClientSlug.make("first-party:github"),
            authorizationUrl: "https://github.com/login/oauth/authorize",
            tokenUrl: "https://github.com/login/oauth/access_token",
            grant: "authorization_code",
            clientId: "impostor",
            clientSecret: "impostor-secret",
          },
        })
        .pipe(Effect.flip);
      const after = yield* client.oauth.listClients();
      const survivors = after.filter((c) => String(c.slug) === "first-party:github");
      expect(survivors, "exactly one first-party:github remains listed").toHaveLength(1);
      expect(survivors[0]?.origin.kind).toBe("first_party");
      expect(survivors[0]?.clientId, "the impostor never shadowed the host's app").toBe(
        "e2e-first-party-github",
      );
    }),
  ),
);

scenario(
  "First-party OAuth · unlisted Google still authorizes its bundle and refuses admin scopes",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      if (target.name !== "cloud") return;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the integrations registry browser", async () => {
          await visit(page, "/integrations/browse");
          await page.getByPlaceholder(/Search integrations, or paste a URL/).waitFor();
        });
      });

      // The Executor-owned Google app is withheld from every listing: it is no
      // longer offered for new connections, so connecting Google means bringing
      // your own OAuth app. It stays fully resolvable by slug, which the
      // `oauth.start` cases below exercise — that is the guarantee for everyone
      // already connected through it. Its reviewed consumer scope bundle, no
      // longer introspectable from here, is asserted on the config it is built
      // from, in apps/cloud/src/engine/first-party-oauth-clients.test.ts.
      const clients = yield* client.oauth.listClients();
      expect(
        clients.find((candidate) => String(candidate.slug) === "first-party:google"),
        "the first-party Google app is not offered in listings",
      ).toBeUndefined();

      const calendar = IntegrationSlug.make(unique("google_calendar"));
      yield* client.openapi.addSpec({
        payload: {
          ...googleShapedIntegrationSpec([
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/calendar",
          ]),
          slug: calendar,
        },
      });
      const started = yield* client.oauth.start({
        payload: {
          client: OAuthClientSlug.make("first-party:google"),
          clientOwner: "org",
          owner: "org",
          name: ConnectionName.make("calendar"),
          integration: calendar,
          template: AuthTemplateSlug.make("oauth"),
        },
      });
      expect(started.status).toBe("redirect");
      const authorizationUrl = started.status === "redirect" ? started.authorizationUrl : "";
      const authorize = new URL(authorizationUrl);
      expect(authorize.origin + authorize.pathname).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
      expect(authorize.searchParams.get("client_id")).toBe("e2e-first-party-google");
      expect(authorize.searchParams.get("access_type")).toBe("offline");
      expect(new Set(authorize.searchParams.get("scope")?.split(" ") ?? [])).toEqual(
        new Set(["openid", "email", "profile", "https://www.googleapis.com/auth/calendar"]),
      );

      const gmail = IntegrationSlug.make(unique("google_gmail"));
      yield* client.openapi.addSpec({
        payload: {
          ...googleShapedIntegrationSpec([
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/gmail.modify",
          ]),
          slug: gmail,
        },
      });
      const gmailStarted = yield* client.oauth.start({
        payload: {
          client: OAuthClientSlug.make("first-party:google"),
          clientOwner: "org",
          owner: "org",
          name: ConnectionName.make("gmail"),
          integration: gmail,
          template: AuthTemplateSlug.make("oauth"),
        },
      });
      expect(gmailStarted.status).toBe("redirect");
      const gmailAuthorizationUrl =
        gmailStarted.status === "redirect" ? gmailStarted.authorizationUrl : "";
      expect(
        new Set(new URL(gmailAuthorizationUrl).searchParams.get("scope")?.split(" ") ?? []),
      ).toEqual(
        new Set(["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"]),
      );

      const fullGmail = IntegrationSlug.make(unique("google_gmail_full"));
      yield* client.openapi.addSpec({
        payload: {
          ...googleShapedIntegrationSpec([
            "openid",
            "email",
            "profile",
            "https://mail.google.com/",
            "https://www.googleapis.com/auth/gmail.settings.basic",
          ]),
          slug: fullGmail,
        },
      });
      const fullGmailStarted = yield* client.oauth.start({
        payload: {
          client: OAuthClientSlug.make("first-party:google"),
          clientOwner: "org",
          owner: "org",
          name: ConnectionName.make("gmail-full"),
          integration: fullGmail,
          template: AuthTemplateSlug.make("oauth"),
        },
      });
      expect(fullGmailStarted.status).toBe("redirect");
      const fullGmailAuthorizationUrl =
        fullGmailStarted.status === "redirect" ? fullGmailStarted.authorizationUrl : "";
      expect(
        new Set(new URL(fullGmailAuthorizationUrl).searchParams.get("scope")?.split(" ") ?? []),
      ).toEqual(
        new Set([
          "openid",
          "email",
          "profile",
          "https://mail.google.com/",
          "https://www.googleapis.com/auth/gmail.settings.basic",
        ]),
      );

      const drive = IntegrationSlug.make(unique("google_drive"));
      yield* client.openapi.addSpec({
        payload: {
          ...googleShapedIntegrationSpec([
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/drive",
          ]),
          slug: drive,
        },
      });
      const driveStarted = yield* client.oauth.start({
        payload: {
          client: OAuthClientSlug.make("first-party:google"),
          clientOwner: "org",
          owner: "org",
          name: ConnectionName.make("drive"),
          integration: drive,
          template: AuthTemplateSlug.make("oauth"),
        },
      });
      expect(driveStarted.status).toBe("redirect");

      const admin = IntegrationSlug.make(unique("google_admin"));
      yield* client.openapi.addSpec({
        payload: {
          ...googleShapedIntegrationSpec([
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/admin.directory.user",
          ]),
          slug: admin,
        },
      });
      const blocked = yield* client.oauth
        .start({
          payload: {
            client: OAuthClientSlug.make("first-party:google"),
            clientOwner: "org",
            owner: "org",
            name: ConnectionName.make("admin"),
            integration: admin,
            template: AuthTemplateSlug.make("oauth"),
          },
        })
        .pipe(Effect.flip);
      expect(blocked).toBeDefined();
    }),
  ),
);
