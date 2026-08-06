// Selfhost repros for MCP OAuth bugs seen with a DCR connection whose
// refresh token is rejected by the provider as `invalid_grant`, including the
// reconnect journey: completing Reconnect must refresh the health verdict on
// the page without a hard reload.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

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

/** The test server's login page is plain text with Basic-auth POST — nothing a
 *  browser can click. Complete it out of band and hand back the callback URL. */
const submitProviderLogin = async (loginUrl: string): Promise<string> => {
  const credentials = Buffer.from("alice:password").toString("base64");
  const response = await fetch(loginUrl, {
    method: "POST",
    redirect: "manual",
    headers: { authorization: `Basic ${credentials}` },
  });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) {
    throw new Error(`provider login did not redirect (${response.status})`);
  }
  return new URL(location, loginUrl).toString();
};

const completeAuthorization = (authorizationUrl: string) =>
  Effect.promise(async () => {
    const login = await fetch(authorizationUrl, { redirect: "manual" });
    const loginUrl = requiredRedirect(login, authorizationUrl);
    const callbackUrl = await submitProviderLogin(loginUrl);
    const parsed = new URL(callbackUrl);
    const code = parsed.searchParams.get("code");
    if (!code) throw new Error(`OAuth callback did not include a code: ${callbackUrl}`);
    return { code };
  });

/** AS whose refresh grants are dead forever — every token it mints is already
 *  expired and refresh is rejected as `invalid_grant`. */
const serveDeadGrantOAuthServer = () =>
  serveOAuthTestServer({
    scopes: ["channels:history", "users:read"],
    supportRefresh: false,
    tokenExpiresInSeconds: 0,
    invalidRefreshTokenDescription: "Grant not found",
  });

interface GrantRevocationGate {
  /** Token endpoint to register with executor instead of the real one. */
  readonly tokenUrl: string;
  /** The provider comes back: minted tokens get their real lifetime and
   *  refresh grants are honored again. */
  readonly restore: () => void;
  readonly refreshRejections: () => number;
  readonly close: () => void;
}

/** Token-endpoint proxy in front of the test AS. While "revoked" it behaves
 *  like a provider whose grants are dead — authorization_code exchanges still
 *  succeed but mint already-expired tokens, and refresh grants are rejected
 *  with `invalid_grant` — and after `restore()` it is a plain passthrough. The
 *  test server itself cannot flip behavior after construction, and this repro
 *  needs "expired now, healthy after a fresh reconnect". */
const serveGrantRevocationGate = (upstreamTokenUrl: string) =>
  Effect.acquireRelease(
    Effect.callback<GrantRevocationGate>((resume) => {
      let revoked = true;
      let refreshRejections = 0;
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (revoked && new URLSearchParams(body).get("grant_type") === "refresh_token") {
            refreshRejections += 1;
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
              JSON.stringify({ error: "invalid_grant", error_description: "Grant not found" }),
            );
            return;
          }
          fetch(upstreamTokenUrl, {
            method: "POST",
            headers: {
              "content-type":
                request.headers["content-type"] ?? "application/x-www-form-urlencoded",
              ...(request.headers.authorization
                ? { authorization: request.headers.authorization }
                : {}),
            },
            body,
          })
            .then(async (upstream) => {
              const text = await upstream.text();
              if (revoked && upstream.ok) {
                const parsed = JSON.parse(text) as Record<string, unknown>;
                parsed["expires_in"] = 0;
                response.writeHead(upstream.status, { "content-type": "application/json" });
                response.end(JSON.stringify(parsed));
                return;
              }
              response.writeHead(upstream.status, {
                "content-type": upstream.headers.get("content-type") ?? "application/json",
              });
              response.end(text);
            })
            .catch(() => {
              response.writeHead(502, { "content-type": "application/json" });
              response.end(JSON.stringify({ error: "bad_gateway" }));
            });
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(
          Effect.succeed({
            tokenUrl: `http://127.0.0.1:${port}/token`,
            restore: () => {
              revoked = false;
            },
            refreshRejections: () => refreshRejections,
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (gate) => Effect.sync(gate.close),
  );

const seedDcrMcpOAuthConnection = (
  client: Client,
  prefix: string,
  oauth: OAuthTestServerShape,
  options?: { readonly tokenUrl?: string },
) =>
  Effect.gen(function* () {
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
        tokenUrl: options?.tokenUrl ?? probe.tokenUrl,
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

const seedExpiredDcrMcpOAuthConnection = (client: Client, prefix: string) =>
  Effect.gen(function* () {
    const oauth = yield* serveDeadGrantOAuthServer();
    return yield* seedDcrMcpOAuthConnection(client, prefix, oauth);
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

// The reconnect journey from the bug report: a connection reads Expired, the
// user completes Reconnect through the OAuth popup, and the page must show the
// recovered health WITHOUT a hard refresh. The gate makes the provider's
// grants dead during seeding (already-expired tokens, refresh rejected) and
// healthy again before the reconnect, so the only thing standing between the
// user and a green dot is the UI updating itself.
scenario(
  "MCP OAuth · completed reconnect refreshes the health verdict without a page reload",
  {
    timeout: 240_000,
  },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      const oauth = yield* serveOAuthTestServer({
        scopes: ["channels:history", "users:read"],
      });
      const gate = yield* serveGrantRevocationGate(`${oauth.issuerUrl}/token`);
      const { slug } = yield* seedDcrMcpOAuthConnection(client, "mcp-reconnect-live", oauth, {
        tokenUrl: gate.tokenUrl,
      });

      // Persist the expired verdict exactly as the user's "Check now" would.
      const seededHealth = yield* client.connections.checkHealth({
        params: { owner: "org", integration: slug, name },
        query: {},
      });
      expect(seededHealth.status, "the dead grant seeds an expired verdict").toBe("expired");
      expect(gate.refreshRejections(), "the expiry came from a rejected refresh").toBeGreaterThan(
        0,
      );

      yield* browser.session(identity, async ({ page, step }) => {
        const connections = connectionsSection(page);
        const menuTrigger = connections.locator('button[aria-haspopup="menu"]').first();

        await step("Open the integration: the connection reads Expired", async () => {
          await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
          await connections.getByText("main", { exact: true }).waitFor({ timeout: 30_000 });
          await connections.getByLabel("Status: Expired").waitFor({ timeout: 30_000 });
        });

        await step("Reconnect and complete the OAuth flow in the popup", async () => {
          // The provider comes back before the user reconnects — fresh grants
          // are fully healthy from here on.
          gate.restore();

          const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
          await menuTrigger.click();
          await page.getByRole("menuitem", { name: "Reconnect" }).click();
          const popup = await popupPromise;

          // The test AS login page is plain text driven by Basic-auth POST, so
          // complete it out of band and drive the popup to the callback — the
          // same journey a user's click-through consent takes.
          await popup.waitForURL(/\/login\?/, { timeout: 30_000 });
          const callbackUrl = await submitProviderLogin(popup.url());
          await popup.goto(callbackUrl);
          await page.getByText("Reconnected", { exact: true }).waitFor({ timeout: 30_000 });
        });

        await step("The backend already sees the connection as healthy", async () => {
          // Evidence that only the UI is stale: the same health endpoint the
          // page would call classifies the re-minted grant as healthy.
          const response = await page.request.post(healthPath(slug));
          const body = (await response.json()) as { readonly status?: string };
          console.info(`[BUG repro] post-reconnect health: ${response.status()} ${body.status}`);
          expect(response.status(), "post-reconnect health check succeeds").toBe(200);
          expect(body.status, "the re-minted grant is healthy").toBe("healthy");
        });

        await step("BUG: the row must flip to Healthy without a hard page refresh", async () => {
          await connections.getByLabel("Status: Healthy").waitFor({ timeout: 30_000 });
          await connections.getByText("Expired", { exact: true }).waitFor({
            state: "hidden",
            timeout: 5_000,
          });
        });
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
