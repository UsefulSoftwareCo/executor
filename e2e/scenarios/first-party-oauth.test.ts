// First-party OAuth clients: the cloud host declares executor-owned apps via
// env (`FIRST_PARTY_GITHUB_CLIENT_ID/SECRET`, set by the e2e cloud boot), and
// every org can connect through them with nothing to paste. Three guarantees:
//
//   1. Listing: `oauth.listClients` surfaces `first-party:github` with a
//      `first_party` origin and its public client id — no create call ever ran.
//   2. Flow: `oauth.start` through the first-party slug redirects to the
//      provider's authorize endpoint carrying the env-configured client id and
//      this platform's `/api/oauth/callback` — proof the config-resolved
//      identity (not a stored row) drives the flow. The redirect is asserted,
//      never followed: github.com is not visited.
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
import { clickToReveal } from "../src/surfaces/browser";

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
  "First-party OAuth · the host-declared GitHub app is listed and drives the authorize redirect",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      // First-party registrations are a cloud-host capability. This scenario
      // intentionally does not apply to self-host, whose operator supplies
      // their own OAuth apps through its existing registration flow.
      if (target.name !== "cloud") return;
      const { client: makeApiClient } = yield* Api;
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
      expect(started.status, "oauth.start redirects to the provider").toBe("redirect");
      const authorizationUrl = started.status === "redirect" ? started.authorizationUrl : "";
      const authorize = new URL(authorizationUrl);
      expect(authorize.origin + authorize.pathname).toBe(
        "https://github.com/login/oauth/authorize",
      );
      expect(authorize.searchParams.get("client_id")).toBe("e2e-first-party-github");
      expect(authorize.searchParams.get("redirect_uri")).toBe(
        new URL("/api/oauth/callback", target.baseUrl).toString(),
      );

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
  "First-party OAuth · Google offers the reviewed consumer bundle and refuses admin scopes",
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
        await step("Open the Google integration catalog", async () => {
          await page.goto("/integrations", { waitUntil: "networkidle" });
          const dialog = page.getByRole("dialog", { name: "Connect an integration" });
          await clickToReveal(page.getByRole("button", { name: /Connect/ }).first(), dialog);
        });

        const services = [
          "Google Calendar",
          "Google Meet",
          "Gmail",
          "Google Sheets",
          "Google Drive",
          "Google Docs",
          "Google Slides",
          "Google Forms",
          "Google Tasks",
          "Google People",
          "Google Photos Library",
          "Google Photos Picker",
          "Google Search Console",
        ] as const;
        const dialog = page.getByRole("dialog", { name: "Connect an integration" });
        const search = dialog.getByPlaceholder(/Search or paste a URL/);
        for (const service of services) {
          await step(`${service} is available to connect`, async () => {
            await search.fill(service);
            await dialog.getByRole("link", { name: new RegExp(`^${service}\\b`) }).waitFor();
          });
        }
      });

      const clients = yield* client.oauth.listClients();
      const google = clients.find((candidate) => String(candidate.slug) === "first-party:google");
      expect(google, "the env-declared first-party Google app is listed").toBeDefined();
      expect(google?.origin.kind).toBe("first_party");
      if (google?.origin.kind !== "first_party") return;
      expect(google.origin.allowedScopes).toContain("https://www.googleapis.com/auth/calendar");
      expect(google.origin.allowedScopes).toContain(
        "https://www.googleapis.com/auth/meetings.space.readonly",
      );
      // `gmail.modify` stays in the host-enforced allowlist on purpose: a
      // connection created before the full-Gmail review still declares it, and
      // `resolveFirstPartyScopes` filters discovered scopes through this list,
      // so dropping it would break those reconnects — as the legacy-spec case
      // further down this file asserts. The invariant that new Gmail presets
      // request `mail.google.com` instead lives in the preset unit tests
      // (packages/plugins/openapi/.../presets.test.ts), which is where the
      // request-side scope choice is actually decided.
      expect(google.origin.allowedScopes).toContain("https://mail.google.com/");
      expect(google.origin.allowedScopes).toContain(
        "https://www.googleapis.com/auth/gmail.settings.basic",
      );
      expect(google.origin.allowedScopes).not.toContain(
        "https://www.googleapis.com/auth/gmail.settings.sharing",
      );
      expect(google.origin.allowedScopes).toContain("https://www.googleapis.com/auth/spreadsheets");
      expect(google.origin.allowedScopes).toContain("https://www.googleapis.com/auth/drive.file");
      expect(google.origin.allowedScopes).toContain("https://www.googleapis.com/auth/drive");
      expect(google.origin.allowedScopes).toContain("https://www.googleapis.com/auth/documents");
      expect(google.origin.allowedScopes).toContain(
        "https://www.googleapis.com/auth/presentations",
      );
      expect(google.origin.allowedScopes).toContain("https://www.googleapis.com/auth/forms.body");
      expect(google.origin.allowedScopes).toContain(
        "https://www.googleapis.com/auth/forms.responses.readonly",
      );
      expect(google.origin.allowedScopes).toContain("https://www.googleapis.com/auth/tasks");
      expect(google.origin.allowedScopes).toContain("https://www.googleapis.com/auth/contacts");
      expect(google.origin.allowedScopes).toContain(
        "https://www.googleapis.com/auth/contacts.other.readonly",
      );
      expect(google.origin.allowedScopes).toContain(
        "https://www.googleapis.com/auth/directory.readonly",
      );
      for (const scope of [
        "user.addresses.read",
        "user.birthday.read",
        "user.emails.read",
        "user.gender.read",
        "user.organization.read",
        "user.phonenumbers.read",
      ]) {
        expect(google.origin.allowedScopes).toContain(`https://www.googleapis.com/auth/${scope}`);
      }
      expect(google.origin.allowedScopes).toContain(
        "https://www.googleapis.com/auth/photoslibrary.appendonly",
      );
      expect(google.origin.allowedScopes).toContain(
        "https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata",
      );
      expect(google.origin.allowedScopes).toContain(
        "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
      );
      expect(google.origin.allowedScopes).toContain("https://www.googleapis.com/auth/webmasters");
      expect(google.origin.allowedScopes).not.toContain(
        "https://www.googleapis.com/auth/admin.directory.user",
      );
      expect(google.origin.allowedScopes).not.toContain("https://www.googleapis.com/auth/youtube");
      expect(google.origin.allowedScopes).not.toContain(
        "https://www.googleapis.com/auth/cloud-platform",
      );

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
