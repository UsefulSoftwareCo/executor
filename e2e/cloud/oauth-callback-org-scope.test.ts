// Cloud-only: OAuth callbacks must preserve the URL-selected organization.
//
// A browser session cookie can be pinned to org B while a tab is operating in
// org A via the URL org selector. OAuth redirects leave the console route and
// land on /api/oauth/callback, so the provider state must carry the org selector
// without adding provider-facing query params to redirect_uri.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug, OAuthClientSlug } from "@executor-js/sdk/shared";
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

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const setWorkosSessionCookie = async (page: Page, baseUrl: string, cookie: string) => {
  await page.context().addCookies([
    {
      name: "wos-session",
      value: cookieValue(cookie),
      url: baseUrl,
    },
  ]);
};

const expectOrgShell = async (
  page: Page,
  org: { readonly name: string; readonly slug: string },
) => {
  await page.waitForURL(
    (url) => url.pathname === `/${org.slug}` || url.pathname === `/${org.slug}/`,
    {
      timeout: 30_000,
    },
  );
  await page.getByRole("button", { name: new RegExp(escapeRegExp(org.name)) }).waitFor();
  await page.getByRole("heading", { name: "Integrations" }).waitFor();
};

const installSameWindowOAuthPopup = async (page: Page) => {
  await page.addInitScript(() => {
    window.open = () =>
      ({
        get closed() {
          return false;
        },
        close() {},
        focus() {},
        location: {
          get href() {
            return window.location.href;
          },
          set href(value: string) {
            window.location.assign(String(value));
          },
        },
      }) as Window;
  });
};

const submitProviderLoginFromPage = async (page: Page): Promise<string> =>
  fetch(page.url(), {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: `Basic ${Buffer.from("alice:password").toString("base64")}`,
    },
  }).then((response) => {
    const location = response.headers.get("location");
    if (response.status !== 302 || !location) {
      throw new Error(`provider did not return callback location (${response.status})`);
    }
    return new URL(location, page.url()).toString();
  });

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
  "OAuth callback · state-scoped org survives a callback while the session cookie points elsewhere",
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

    const client = yield* makeApiClient(api, identity);

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

    let callback = new URL("http://invalid.example");
    let providerAuthorizeUrl = new URL("http://invalid.example");
    yield* browser.session(identity, async ({ page, step }) => {
      await installSameWindowOAuthPopup(page);

      await step("Land in the original organization", async () => {
        await page.goto(`/${orgA.slug}`, { waitUntil: "networkidle" });
        await expectOrgShell(page, orgA);
      });

      await step("The browser session is switched to another organization", async () => {
        await setWorkosSessionCookie(page, target.baseUrl, sessionB);
        await page.goto(`/${orgB.slug}`, { waitUntil: "networkidle" });
        await expectOrgShell(page, orgB);
      });

      await step("Start OAuth from the original organization's add-connection flow", async () => {
        await page.goto(`/${orgA.slug}/integrations/${String(integration)}?addAccount=1`, {
          waitUntil: "networkidle",
        });
        await page.getByRole("heading", { name: /Add connection/ }).waitFor({
          timeout: 30_000,
        });
        const authorizeRequest = page.waitForRequest(
          (request) => {
            const url = new URL(request.url());
            return url.origin === new URL(oauth.issuerUrl).origin && url.pathname === "/authorize";
          },
          { timeout: 30_000 },
        );
        await page.getByRole("button", { name: "Connect with OAuth" }).click();
        providerAuthorizeUrl = new URL((await authorizeRequest).url());
        await page.waitForURL(
          (url) => url.origin === new URL(oauth.issuerUrl).origin && url.pathname === "/login",
          { timeout: 30_000 },
        );
        const redirectUri = new URL(providerAuthorizeUrl.searchParams.get("redirect_uri") ?? "");
        expect(redirectUri.pathname, "the provider redirects to the OAuth callback").toBe(
          "/api/oauth/callback",
        );
        expect(redirectUri.search, "the provider-facing redirect_uri has no org query").toBe("");
        expect(
          providerAuthorizeUrl.searchParams.get("state"),
          "OAuth state is present",
        ).toBeTruthy();
        await page.getByText("OAuth test login").waitFor();
      });

      await step("The provider returns to the OAuth callback", async () => {
        const callbackUrl = await submitProviderLoginFromPage(page);
        callback = new URL(callbackUrl);
        const response = await page.goto(callbackUrl, { waitUntil: "networkidle" });
        expect(response?.status(), "the callback renders its popup result page").toBe(200);
      });

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
      new URL(providerAuthorizeUrl.searchParams.get("redirect_uri") ?? "").search,
      "the provider-facing redirect_uri remains static",
    ).toBe("");
    expect(
      callback.searchParams.has("executor_org"),
      "the provider callback has no org query",
    ).toBe(false);
  }).pipe(Effect.scoped),
);
