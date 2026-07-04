import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import type { Page } from "playwright";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  type Owner,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const owner: Owner = "user";
const template = AuthTemplateSlug.make("oauth2");
const seededName = ConnectionName.make("mcp-linear-app-oauth");
const originalName = ConnectionName.make("mcpLinearAppOauth");
const duplicateName = ConnectionName.make("mcplinearappoauth");
const displayLabel = "mcpLinearAppOauth";

const freshSlug = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;

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

const completeAuthorizationHeadlessly = (authorizationUrl: string) =>
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

const completePopupLogin = async (popup: Page): Promise<void> => {
  await popup.waitForURL(/\/login\?transaction=/, { timeout: 30_000 });
  await popup.setExtraHTTPHeaders({
    authorization: `Basic ${Buffer.from("alice:password").toString("base64")}`,
  });
  const callbackResponse = popup.waitForResponse(
    (response) => response.url().includes("/api/oauth/callback") && response.status() === 200,
    { timeout: 30_000 },
  );
  await popup.evaluate(() => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = window.location.href;
    document.body.append(form);
    form.submit();
  });
  await callbackResponse;
};

const listScenarioConnections = (client: Client, slug: IntegrationSlug) =>
  client.connections.list({ query: { integration: slug, owner } });

const summarizeConnections = (
  rows: readonly {
    readonly owner: Owner;
    readonly name: ConnectionName;
    readonly address: unknown;
    readonly identityLabel: string | null;
    readonly lastHealth: { readonly status: string } | null;
  }[],
): string =>
  JSON.stringify(
    rows.map((row) => ({
      owner: row.owner,
      name: String(row.name),
      address: String(row.address),
      identityLabel: row.identityLabel,
      health: row.lastHealth?.status ?? null,
    })),
  );

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
        name: `DCR reconnect duplicate ${String(slug)}`,
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
        owner,
        slug: clientSlug,
        issuer: probe.issuer ?? null,
        registrationEndpoint: probe.registrationEndpoint,
        authorizationUrl: probe.authorizationUrl,
        tokenUrl: probe.tokenUrl,
        resource: probe.resource ?? oauth.mcpResourceUrl,
        scopes: probe.scopesSupported ?? [],
        tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
        clientName: "Executor e2e MCP OAuth reconnect duplicate",
        originIntegration: slug,
      },
    });
    yield* Effect.addFinalizer(() =>
      client.oauth
        .removeClient({ params: { slug: registered.client }, payload: { owner } })
        .pipe(Effect.ignore),
    );

    const started = yield* client.oauth.start({
      payload: {
        owner,
        client: registered.client,
        clientOwner: owner,
        name: seededName,
        integration: slug,
        template,
        identityLabel: displayLabel,
      },
    });
    expect(started.status, "DCR MCP OAuth starts an authorization-code redirect").toBe("redirect");
    if (started.status !== "redirect") return yield* Effect.die("OAuth start did not redirect");

    const callback = yield* completeAuthorizationHeadlessly(started.authorizationUrl);
    yield* client.oauth.complete({ payload: { state: started.state, code: callback.code } });
    yield* Effect.addFinalizer(() =>
      Effect.all(
        [
          client.connections
            .remove({ params: { owner, integration: slug, name: originalName } })
            .pipe(Effect.ignore),
          client.connections
            .remove({ params: { owner, integration: slug, name: duplicateName } })
            .pipe(Effect.ignore),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.ignore),
    );

    const initial = yield* listScenarioConnections(client, slug);
    console.info(`[DCR duplicate repro] initial API connections: ${summarizeConnections(initial)}`);
    expect(initial.map((connection) => String(connection.name))).toEqual([String(originalName)]);

    const health = yield* client.connections.checkHealth({
      params: { owner, integration: slug, name: originalName },
      query: {},
    });
    expect(health.status, "the seed connection is expired before reconnect").toBe("expired");
    yield* oauth.clearRequests;

    return { oauth, slug };
  });

const oauthRequestSummary = (
  requests: readonly { readonly method: string; readonly path: string }[],
) => requests.map((request) => `${request.method} ${request.path}`).join(", ");

scenario(
  "MCP OAuth reconnect updates the existing DCR connection",
  {
    timeout: 180_000,
    expectedFailure:
      "DCR reconnect currently remints mcpLinearAppOauth as mcplinearappoauth and leaves the expired row behind.",
  },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const { oauth, slug } = yield* seedExpiredDcrMcpOAuthConnection(
        client,
        "mcp-dcr-reconnect-duplicate",
      );

      let uiRowCount = -1;
      let uiLabelCount = -1;
      let uiExpiredCount = -1;

      yield* browser.session(identity, async ({ page, step }) => {
        const connections = connectionsSection(page);
        const menuTrigger = connections.locator('button[aria-haspopup="menu"]').first();

        await step("Open the integration with one expired OAuth connection", async () => {
          await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
          await connections.getByText(displayLabel, { exact: true }).waitFor({ timeout: 30_000 });
          await connections.getByLabel("Status: Expired").waitFor({ timeout: 30_000 });
          expect(
            await connections.locator('button[aria-haspopup="menu"]').count(),
            "the UI starts with one connection row",
          ).toBe(1);
        });

        await step("Reconnect and complete the OAuth popup", async () => {
          const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
          await menuTrigger.click();
          await page.getByRole("menuitem", { name: "Reconnect" }).click();
          const popup = await popupPromise;
          await completePopupLogin(popup);
          await page.getByText("Reconnected", { exact: true }).waitFor({ timeout: 30_000 });
          await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 30_000 });
        });

        await step("Read the connection list after reconnect", async () => {
          await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
          await connections
            .getByText(displayLabel, { exact: true })
            .first()
            .waitFor({ timeout: 30_000 });
          uiRowCount = await connections.locator('button[aria-haspopup="menu"]').count();
          uiLabelCount = await connections.getByText(displayLabel, { exact: true }).count();
          uiExpiredCount = await connections.getByLabel("Status: Expired").count();
          console.info(
            `[DCR duplicate repro] UI rows=${uiRowCount} labels=${uiLabelCount} expired=${uiExpiredCount}`,
          );
        });
      });

      const requests = yield* oauth.requests;
      console.info(`[DCR duplicate repro] OAuth server requests: ${oauthRequestSummary(requests)}`);

      const after = yield* listScenarioConnections(client, slug);
      console.info(`[DCR duplicate repro] after API connections: ${summarizeConnections(after)}`);

      expect(after, "API list should contain exactly one connection after reconnect").toHaveLength(
        1,
      );
      expect(String(after[0]?.name), "Reconnect should preserve the original connection name").toBe(
        String(originalName),
      );
      expect(
        String(after[0]?.address),
        "Reconnect should preserve the original connection address",
      ).toContain(`.${String(originalName)}`);
      expect(
        after[0]?.lastHealth?.status,
        "Reconnect should clear the expired health state",
      ).not.toBe("expired");
      expect(uiRowCount, "UI list should contain exactly one connection row").toBe(1);
      expect(uiLabelCount, "UI list should show the original connection label once").toBe(1);
      expect(uiExpiredCount, "UI list should not show an expired row after reconnect").toBe(0);
    }),
  ),
);
