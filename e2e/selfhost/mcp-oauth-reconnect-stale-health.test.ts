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
      tokenExpiresInSeconds: 0,
      invalidRefreshTokenDescription: "Grant not found",
    });
    const slug = IntegrationSlug.make(freshSlug(prefix));
    const clientSlug = OAuthClientSlug.make(freshSlug(`${prefix}-client`));

    yield* client.mcp.addServer({
      payload: {
        transport: "remote",
        name: `DCR reconnect stale health ${String(slug)}`,
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
        clientName: "Executor e2e MCP OAuth reconnect stale health",
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
    yield* oauth.clearRefreshTokens;
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
    expect(initial.map((connection) => String(connection.name))).toEqual([String(originalName)]);

    const health = yield* client.connections.checkHealth({
      params: { owner, integration: slug, name: originalName },
      query: {},
    });
    expect(health.status, "the seed connection is expired before reconnect").toBe("expired");
    yield* oauth.clearRequests;

    return { slug };
  });

const openConnectionMenu = async (page: Page): Promise<void> => {
  await page.getByText(displayLabel, { exact: true }).hover();
  const buttons = page.getByRole("button");
  const count = await buttons.count();
  for (let index = 0; index < count; index++) {
    const button = buttons.nth(index);
    const text = ((await button.textContent().catch(() => null)) ?? "").trim();
    if (text === "Add connection") continue;
    await button.click({ timeout: 1_000 }).catch(() => {});
    if (
      await page
        .getByRole("menuitem", { name: "Reconnect" })
        .isVisible()
        .catch(() => false)
    ) {
      return;
    }
    await page.keyboard.press("Escape").catch(() => {});
  }
  throw new Error("Could not open the connection row menu");
};

scenario(
  "MCP OAuth reconnect clears an expired row without a page reload",
  {
    timeout: 180_000,
    expectedFailure:
      "OAuth reconnect clears server-side health, but the mounted account row keeps its stale Expired badge until the route reloads.",
  },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const { slug } = yield* seedExpiredDcrMcpOAuthConnection(
        client,
        "mcp-dcr-reconnect-stale-health",
      );

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the integration with an expired OAuth connection", async () => {
          await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
          await page.getByText(displayLabel, { exact: true }).waitFor({ timeout: 30_000 });
          await page.getByLabel("Status: Expired", { exact: true }).waitFor({
            timeout: 30_000,
          });
          await page.getByText("Expired", { exact: true }).waitFor({ timeout: 30_000 });
        });

        await step("Reconnect and complete the OAuth popup", async () => {
          const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
          await openConnectionMenu(page);
          await page.getByRole("menuitem", { name: "Reconnect" }).click();
          const popup = await popupPromise;
          await completePopupLogin(popup);
          await page.getByText("Reconnected", { exact: true }).waitFor({ timeout: 30_000 });
          await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 30_000 });
        });

        const rows = await Effect.runPromise(listScenarioConnections(client, slug));
        console.info(`[stale health repro] API after reconnect: ${summarizeConnections(rows)}`);
        expect(rows, "API list should still contain one connection after reconnect").toHaveLength(
          1,
        );
        expect(
          rows[0]?.lastHealth?.status,
          "server-side reconnect should clear the expired health state",
        ).not.toBe("expired");

        await step("The mounted row should clear Expired without reload", async () => {
          await page.getByLabel("Status: Expired", { exact: true }).waitFor({
            state: "hidden",
            timeout: 10_000,
          });
        });
      });
    }),
  ),
);
