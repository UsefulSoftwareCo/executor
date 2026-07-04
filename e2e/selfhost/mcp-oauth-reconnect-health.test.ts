// Selfhost repros for two MCP OAuth bugs seen with a DCR connection whose
// refresh token is rejected by the provider as `invalid_grant`.
import { randomBytes } from "node:crypto";

import { Effect } from "effect";
import { expect } from "@effect/vitest";
import type { HttpApiClient } from "effect/unstable/httpapi";
import type { Page } from "playwright";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer, type OAuthTestServerShape } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const name = ConnectionName.make("main");
const template = AuthTemplateSlug.make("oauth2");

const freshSlug = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;

const healthPath = (slug: IntegrationSlug): string =>
  `/api/connections/org/${String(slug)}/${String(name)}/health`;

const oauthReconnectRequest = (url: string): boolean =>
  url.includes("/api/oauth/probe") ||
  url.includes("/api/oauth/start") ||
  url.includes("/api/oauth/clients/register-dynamic");

const connectionsSection = (page: Page) =>
  page.locator("section").filter({
    has: page.getByRole("heading", { level: 3, name: "Connections" }),
  });

const requiredRedirect = (response: Response, from: string): string => {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`Expected redirect from ${from}, got HTTP ${response.status}`);
  }
  return new URL(location, from).toString();
};

const completeAuthorization = (authorizationUrl: string) =>
  Effect.promise(async () => {
    const login = await fetch(authorizationUrl, { redirect: "manual" });
    const loginUrl = requiredRedirect(login, authorizationUrl);
    const credentials = Buffer.from("alice:password").toString("base64");
    const callback = await fetch(loginUrl, {
      method: "POST",
      headers: { authorization: `Basic ${credentials}` },
      redirect: "manual",
    });
    const callbackUrl = requiredRedirect(callback, loginUrl);
    const parsed = new URL(callbackUrl);
    const code = parsed.searchParams.get("code");
    if (!code) throw new Error(`OAuth callback did not include a code: ${callbackUrl}`);
    return { code };
  });

const seedExpiredDcrMcpOAuthConnection = (client: Client, prefix: string) =>
  Effect.gen(function* () {
    const oauth = yield* serveOAuthTestServer({
      scopes: ["channels:history", "users:read"],
      supportRefresh: false,
      tokenExpiresInSeconds: 0,
      invalidRefreshTokenDescription: "Grant not found",
    });
    const slug = IntegrationSlug.make(freshSlug(prefix));
    const clientSlug = OAuthClientSlug.make(freshSlug(`${prefix}-client`));

    yield* client.mcp.addServer({
      payload: {
        transport: "remote",
        name: `OAuth repro ${String(slug)}`,
        endpoint: oauth.mcpResourceUrl,
        slug: String(slug),
        authenticationTemplate: [{ kind: "oauth2" }],
      },
    });
    yield* Effect.addFinalizer(() =>
      client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore),
    );

    const probe = yield* client.oauth.probe({ payload: { url: oauth.mcpResourceUrl } });
    if (!probe.registrationEndpoint) {
      return yield* Effect.die("OAuth probe did not discover a DCR registration endpoint");
    }

    const registered = yield* client.oauth.registerDynamic({
      payload: {
        owner: "org",
        slug: clientSlug,
        issuer: probe.issuer ?? null,
        registrationEndpoint: probe.registrationEndpoint,
        authorizationUrl: probe.authorizationUrl,
        tokenUrl: probe.tokenUrl,
        resource: probe.resource ?? oauth.mcpResourceUrl,
        scopes: probe.scopesSupported ?? [],
        tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
        clientName: "Executor e2e MCP OAuth repro",
        originIntegration: slug,
      },
    });
    yield* Effect.addFinalizer(() =>
      client.oauth
        .removeClient({ params: { slug: registered.client }, payload: { owner: "org" } })
        .pipe(Effect.ignore),
    );

    const started = yield* client.oauth.start({
      payload: {
        owner: "org",
        client: registered.client,
        clientOwner: "org",
        name,
        integration: slug,
        template,
      },
    });
    expect(started.status, "DCR MCP OAuth starts an authorization-code redirect").toBe("redirect");
    if (started.status !== "redirect") return yield* Effect.die("OAuth start did not redirect");

    const callback = yield* completeAuthorization(started.authorizationUrl);
    yield* client.oauth.complete({ payload: { state: started.state, code: callback.code } });
    yield* Effect.addFinalizer(() =>
      client.connections
        .remove({ params: { owner: "org", integration: slug, name } })
        .pipe(Effect.ignore),
    );
    yield* oauth.clearRequests;

    return { oauth, slug };
  });

const logTokenRequests = (label: string, oauth: OAuthTestServerShape) =>
  Effect.gen(function* () {
    const requests = yield* oauth.requests;
    const refresh = requests
      .filter((request) => request.path === "/token" && request.body.includes("refresh_token"))
      .map((request) => `${request.method} ${request.path} ${request.body}`);
    console.info(`[BUG repro] ${label}: refresh token requests: ${refresh.join(" | ") || "none"}`);
  });

scenario(
  "MCP OAuth · invalid_grant refresh during health check returns expired instead of 500",
  {
    timeout: 180_000,
  },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const { oauth, slug } = yield* seedExpiredDcrMcpOAuthConnection(client, "mcp-hc-invalid");

      const apiResult = yield* client.connections.checkHealth({
        params: { owner: "org", integration: slug, name },
        query: {},
      });
      expect(apiResult.status, "typed checkHealth classifies the dead grant").toBe("expired");
      expect(apiResult.detail, "the provider rejection detail is surfaced").toContain(
        "Grant not found",
      );
      const reread = yield* client.connections.get({
        params: { owner: "org", integration: slug, name },
      });
      expect(reread.lastHealth?.status, "the expired health verdict persisted").toBe("expired");
      expect(reread.lastHealth?.detail, "the persisted detail is useful").toContain(
        "Grant not found",
      );
      yield* logTokenRequests("typed checkHealth", oauth);
      yield* oauth.clearRequests;

      yield* browser.session(identity, async ({ page, step }) => {
        const connections = connectionsSection(page);
        const menuTrigger = connections.locator('button[aria-haspopup="menu"]').first();

        await step("Open the MCP integration with its expired OAuth connection", async () => {
          await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
          await connections.getByText("main", { exact: true }).waitFor({ timeout: 30_000 });
        });

        await step(
          "Check now should render Expired without the generic failure toast",
          async () => {
            const responsePromise = page.waitForResponse(
              (response) =>
                response.url().includes(healthPath(slug)) && response.request().method() === "POST",
              { timeout: 30_000 },
            );
            await menuTrigger.click();
            await page.getByRole("menuitem", { name: "Check now" }).click();
            const response = await responsePromise;
            const body = await response.text();
            console.info(`[BUG repro] UI health response: ${response.status()} ${body}`);

            expect(
              response.status(),
              `health check should return HTTP 200 with status expired; body: ${body}`,
            ).toBe(200);
            const json = JSON.parse(body) as { readonly status?: string };
            expect(json.status, "unrefreshable OAuth grants are an expired credential").toBe(
              "expired",
            );
            await connections.getByLabel("Status: Expired").waitFor({ timeout: 30_000 });
            await page.getByText("Health check failed", { exact: true }).waitFor({
              state: "hidden",
              timeout: 5_000,
            });
          },
        );
      });
    }),
  ),
);

scenario(
  "MCP OAuth · DCR reconnect keeps the dialog open and reaches OAuth start",
  {
    timeout: 180_000,
  },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const { slug } = yield* seedExpiredDcrMcpOAuthConnection(client, "mcp-dcr-reconnect");

      yield* browser.session(identity, async ({ page, step }) => {
        const connections = connectionsSection(page);
        const menuTrigger = connections.locator('button[aria-haspopup="menu"]').first();
        const dialog = page.getByRole("dialog");
        const oauthRequests: string[] = [];

        page.on("request", (request) => {
          if (oauthReconnectRequest(request.url())) oauthRequests.push(request.url());
        });

        await step("Open the MCP integration with its DCR OAuth connection", async () => {
          await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
          await connections.getByText("main", { exact: true }).waitFor({ timeout: 30_000 });
        });

        await step("Reconnect should keep a dialog visible and reach OAuth", async () => {
          const oauthRequest = page
            .waitForRequest((request) => oauthReconnectRequest(request.url()), { timeout: 30_000 })
            .then((request) => request.url());

          await menuTrigger.click();
          await page.getByRole("menuitem", { name: "Reconnect" }).click();

          await dialog.waitFor({ state: "visible", timeout: 30_000 });
          const reachedOAuth = await oauthRequest;
          await page.waitForTimeout(2_000);
          await dialog.waitFor({ state: "visible", timeout: 1_000 });
          console.info(
            `[MCP OAuth repro] reconnect dialog stayed open; OAuth requests: ${
              oauthRequests.join(", ") || reachedOAuth
            }`,
          );
          expect(reachedOAuth, "Reconnect should issue an OAuth request").toBeTruthy();
        });
      });
    }),
  ),
);
