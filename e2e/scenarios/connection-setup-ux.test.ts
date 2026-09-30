import { randomBytes } from "node:crypto";
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator } from "@executor-js/emulate";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug, OAuthClientSlug } from "@executor-js/sdk/shared";
import { variable } from "@executor-js/sdk/http-auth";
import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { hydrated, visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);
const decodeRegisteredClient = Schema.decodeUnknownSync(
  Schema.Struct({ client_id: Schema.String, client_secret: Schema.String }),
);

// Each journey has its own real provider state, OAuth app, user and integration.
const connectionFixture = (registerClient: boolean) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const slug = IntegrationSlug.make(`setup-${randomBytes(4).toString("hex")}`);
    const app = OAuthClientSlug.make(`${slug}-app`);
    const baseUrl = yield* createEmulatorInstance("slack", "connection-setup");
    const emulator = yield* Effect.promise(() => connectEmulator({ baseUrl }));
    const credential = yield* Effect.promise(() =>
      emulator.credentials.mint({
        type: "oauth-authorization-code",
        redirect_uris: [new URL("/api/oauth/callback", target.baseUrl).toString()],
      }),
    );
    const {
      client_id: clientId,
      client_secret: clientSecret,
      authorization_url: authorizationUrl,
      token_url: tokenUrl,
    } = credential;
    if (!clientId || !clientSecret || !authorizationUrl || !tokenUrl) {
      return yield* Effect.die("Slack emulator did not mint an OAuth app");
    }
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const connections = yield* client.connections.list({ query: { integration: slug } });
        for (const connection of connections) {
          yield* client.connections
            .remove({
              params: {
                owner: connection.owner,
                integration: slug,
                name: connection.name,
              },
            })
            .pipe(Effect.ignore);
        }
        yield* client.oauth
          .removeClient({ params: { slug: app }, payload: { owner: "org" } })
          .pipe(Effect.ignore);
        yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
      }).pipe(Effect.ignore),
    );
    yield* client.openapi.addSpec({
      payload: {
        slug,
        name: "Team chat",
        baseUrl: "https://slack.com",
        displayDomain: "slack.com",
        spec: {
          kind: "blob",
          value: JSON.stringify({
            openapi: "3.0.3",
            info: { title: "Team chat", version: "1" },
            // No API operations: only the isolated emulator receives OAuth traffic.
            servers: [{ url: "https://slack.com" }],
            paths: {},
          }),
        },
        authenticationTemplate: [
          {
            slug: "token",
            type: "apiKey",
            headers: { Authorization: ["Bearer ", variable("token")] },
          },
          {
            slug: "oauth",
            kind: "oauth2",
            // The unconfigured case tests metadata only, without contacting a
            // provider. A unique reserved host cannot match another test's app.
            authorizationUrl: registerClient
              ? authorizationUrl
              : `https://${slug}.invalid/authorize`,
            tokenUrl: registerClient ? tokenUrl : `https://${slug}.invalid/token`,
            scopes: ["users:read"],
          },
        ],
      },
    });
    if (registerClient)
      yield* client.oauth.createClient({
        payload: {
          slug: app,
          owner: "org",
          grant: "authorization_code",
          clientId,
          clientSecret,
          authorizationUrl,
          tokenUrl,
          originIntegration: slug,
        },
      });
    return { target, browser, identity, client, slug, emulator };
  });
const fixture = connectionFixture(true);

scenario(
  "Slack OAuth · provider consent saves a connection",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, identity, slug, client, emulator } = yield* fixture;
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Sign in with a provider account without naming the connection", async () => {
          await visit(page, `/integrations/${slug}?addAccount=1`);
          await page.getByRole("tab", { name: "OAuth2", exact: true }).click();
          const opened = page.waitForEvent("popup");
          await page.getByRole("button", { name: "Connect with OAuth", exact: true }).click();
          const popup = await opened;
          await popup.waitForURL(/oauth\/v2\/authorize/);
          // The hosted emulator renders a root-relative form action. Rebase only
          // that provider transport onto this run's isolated instance.
          await popup.route("https://emulators.dev/oauth/v2/authorize/callback", (route) =>
            route.continue({ url: `${emulator.baseUrl}/oauth/v2/authorize/callback` }),
          );
          await popup.getByRole("button", { name: /admin/ }).click();
          await page
            .getByRole("heading", { name: /Add connection/ })
            .waitFor({ state: "hidden", timeout: 30_000 });
        });
      });
      const connections = yield* client.connections.list({ query: { integration: slug } });
      expect(connections, "the completed callback persists the new account").toHaveLength(1);
      expect(connections[0]?.name).toBeTruthy();
      const ledger = yield* Effect.promise(() => emulator.ledger.list());
      expect(
        ledger.some((entry) => entry.method === "POST" && entry.path.includes("oauth.v2.access")),
        "the real provider exchanged an authorization code",
      ).toBe(true);
    }),
  ),
);

scenario(
  "Connection setup · without a matching client the API key stays the default",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, identity, slug } = yield* connectionFixture(false);
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open an integration whose OAuth app has not been configured", async () => {
          await visit(page, `/integrations/${slug}?addAccount=1`);
          expect(
            await page
              .getByRole("tab", { name: "API key (Authorization)", exact: true })
              .getAttribute("aria-selected"),
            "declaring OAuth without a usable client must not replace the key form",
          ).toBe("true");
          await page.getByRole("tab", { name: "OAuth2", exact: true }).click();
          await page.getByRole("button", { name: "Register app", exact: true }).waitFor();
        });
      });
    }),
  ),
);

for (const { interaction, expectedOAuth, expectedKeys } of [
  { interaction: "untouched", expectedOAuth: "true", expectedKeys: [] },
  { interaction: "select API key", expectedOAuth: "false", expectedKeys: [""] },
  {
    interaction: "enter API key",
    expectedOAuth: "false",
    expectedKeys: ["synthetic-key-in-progress"],
  },
] as const) {
  scenario(
    `Connection setup · client list arrives with the form ${interaction}`,
    {},
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, identity, slug } = yield* fixture;
        yield* browser.session(identity, async ({ page, step }) => {
          const started = Promise.withResolvers<void>();
          const released = Promise.withResolvers<void>();
          const completed = Promise.withResolvers<void>();
          await page.route(/\/api\/oauth\/clients(?:\?|$)/, async (route) => {
            const response = await route.fetch();
            started.resolve();
            await released.promise;
            await route.fulfill({ response });
            completed.resolve();
          });
          try {
            await step("Open the dialog while the real OAuth client list is held", async () => {
              await page.goto(`/integrations/${slug}?addAccount=1`, {
                waitUntil: "domcontentloaded",
              });
              await hydrated(page);
              await started.promise;
              const keyTab = page.getByRole("tab", {
                name: "API key (Authorization)",
                exact: true,
              });
              await keyTab.waitFor();
              expect(await keyTab.getAttribute("aria-selected")).toBe("true");
            });
            await step(
              "Resolve client availability without replacing a user's choice",
              async () => {
                const keyTab = page.getByRole("tab", {
                  name: "API key (Authorization)",
                  exact: true,
                });
                const keyInput = page.getByRole("textbox", { name: "Authorization", exact: true });
                if (interaction === "select API key") await keyTab.click();
                if (interaction === "enter API key")
                  await keyInput.fill("synthetic-key-in-progress");
                released.resolve();
                await completed.promise;
                await page.waitForLoadState("networkidle");
                expect(
                  await page
                    .getByRole("tab", { name: "OAuth2", exact: true })
                    .getAttribute("aria-selected"),
                  "only an untouched form should adopt the available OAuth client",
                ).toBe(expectedOAuth);
                expect(
                  await keyTab.getAttribute("aria-selected"),
                  "late data must preserve the chosen key form",
                ).toBe(String(expectedOAuth === "false"));
                expect(
                  await Promise.all((await keyInput.all()).map((input) => input.inputValue())),
                  "any key already entered must remain unchanged",
                ).toEqual(expectedKeys);
              },
            );
          } finally {
            released.resolve();
            await page.unrouteAll({ behavior: "wait" });
          }
        });
      }),
    ),
  );
}

scenario(
  "Connection setup · a ready OAuth app is the default",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, identity, slug } = yield* fixture;
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Add a connection with both a token and a registered sign-in app", async () => {
          await visit(page, `/integrations/${slug}?addAccount=1`);
          await page.getByRole("tab", { name: "OAuth2", exact: true }).waitFor();
          await page.getByRole("tab", { name: "OAuth2", exact: true, selected: true }).waitFor();
          expect(
            await page
              .getByRole("tab", { name: "OAuth2", exact: true })
              .getAttribute("aria-selected"),
            "sign-in is selected without first switching away from API token",
          ).toBe("true");
        });
        await step("Choose an API key instead of browser sign-in", async () => {
          const tokenTab = page.getByRole("tab", { name: "API key (Authorization)", exact: true });
          await tokenTab.click();
          expect(await tokenTab.getAttribute("aria-selected")).toBe("true");
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
          await page.getByRole("heading", { name: /Add connection/ }).waitFor({ state: "hidden" });
        });
        await step("Open a new connection on browser sign-in again", async () => {
          await page.getByRole("button", { name: "Add connection", exact: true }).click();
          expect(
            await page
              .getByRole("tab", { name: "OAuth2", exact: true })
              .getAttribute("aria-selected"),
          ).toBe("true");
        });
      });
    }),
  ),
);
for (const origin of ["integration", "workspace"] as const) {
  scenario(
    origin === "integration"
      ? "Connection setup · a saved MCP app opens sign-in on the first click"
      : "Connection setup · discovery reuses a workspace OAuth app without another click",
    {},
    Effect.scoped(
      Effect.gen(function* () {
        const target = yield* Target;
        const browser = yield* Browser;
        const { client: makeClient } = yield* Api;
        const identity = yield* target.newIdentity();
        const client = yield* makeClient(composePluginApi([mcpHttpPlugin()] as const), identity);
        const base = yield* createEmulatorInstance("mcp", "saved-app");
        const emulator = yield* Effect.promise(() => connectEmulator({ baseUrl: base }));
        const slug = IntegrationSlug.make(`saved-app-${randomBytes(4).toString("hex")}`);
        const app = OAuthClientSlug.make(`${slug}-client`);
        const registered = yield* Effect.promise(async () => {
          const response = await fetch(`${base}/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              client_name: "Saved app",
              redirect_uris: [new URL("/api/oauth/callback", target.baseUrl).toString()],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "client_secret_post",
            }),
          });
          expect(response.status).toBe(201);
          return decodeRegisteredClient(await response.json());
        });
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const connections = yield* client.connections.list({ query: { integration: slug } });
            for (const connection of connections) {
              yield* client.connections
                .remove({
                  params: { owner: connection.owner, integration: slug, name: connection.name },
                })
                .pipe(Effect.ignore);
            }
            yield* client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore);
            yield* client.oauth
              .removeClient({ params: { slug: app }, payload: { owner: "org" } })
              .pipe(Effect.ignore);
          }).pipe(Effect.ignore),
        );
        yield* client.mcp.addServer({
          payload: {
            transport: "remote",
            slug,
            name: "Team MCP",
            endpoint: `${base}/mcp`,
            authenticationTemplate: [{ kind: "oauth2" }],
          },
        });
        yield* client.oauth.createClient({
          payload: {
            owner: "org",
            slug: app,
            grant: "authorization_code",
            clientId: registered.client_id,
            clientSecret: registered.client_secret,
            authorizationUrl: `${base}/authorize`,
            tokenUrl: `${base}/token`,
            resource: base,
            ...(origin === "integration" ? { originIntegration: slug } : {}),
          },
        });
        yield* Effect.promise(() => emulator.ledger.clear());
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open an integration that already has a saved OAuth app", async () => {
            await visit(page, `/integrations/${slug}?addAccount=1`);
            await page.getByRole("tab", { name: "OAuth", exact: true }).waitFor();
          });
          await step("Connect once using the saved app", async () => {
            const opened = page.waitForEvent("popup");
            await page.getByRole("button", { name: /^Connect(?: with OAuth)?$/ }).click();
            const popup = await opened;
            await popup.waitForURL(/\/authorize/);
            expect(
              new URL(popup.url()).searchParams.get("client_id"),
              "the existing app is reused without another registration step",
            ).toBe(registered.client_id);
          });
          await step("Approve provider sign-in and save the connection", async () => {
            const popup = page
              .context()
              .pages()
              .find((candidate) => candidate !== page);
            if (!popup) throw new Error("Provider sign-in window was not open");
            // The published MCP consent form omits its selected user's login.
            // Keep the real provider exchange; forward the identity clicked below.
            await popup.route(`${base}/authorize/approve`, (route) => {
              const body = new URLSearchParams(route.request().postData() ?? "");
              body.set("login", "admin");
              return route.continue({ postData: body.toString() });
            });
            await popup.getByRole("button", { name: /admin/ }).click();
            await page
              .getByRole("heading", { name: /Add connection/ })
              .waitFor({ state: "hidden", timeout: 30_000 });
          });
        });
        const connections = yield* client.connections.list({ query: { integration: slug } });
        expect(connections, "provider consent saves the connection").toHaveLength(1);
        expect(connections[0]?.owner, "a shared app keeps the connection personal").toBe("user");
        const savedClients = yield* client.oauth.listClients({});
        expect(savedClients.find((saved) => saved.slug === app)?.origin).toEqual(
          origin === "integration"
            ? { kind: "manual", integration: slug }
            : { kind: "manual", integration: null },
        );
        const ledger = yield* Effect.promise(() => emulator.ledger.list());
        expect(
          ledger.filter((entry) => entry.method === "POST" && entry.path === "/register"),
          "connecting must reuse the saved app",
        ).toHaveLength(0);
      }),
    ),
  );
}
