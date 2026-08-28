// Selfhost-only (browser): the multi-method auth UX beyond the no-auth case —
// an OAuth-DETECTED server gets an API key declared alongside at add time, and
// the connect modal's "+ method" adds a custom API key to an OAuth integration
// without displacing it. Selfhost-only because cloud has no browser identity
// yet and these paste a credential into the default store; the cross-target
// no-auth add-flow variant lives in scenarios/auth-methods-ui.test.ts. The
// selfhost instance runs with EXECUTOR_ALLOW_LOCAL_NETWORK so its outbound
// probe/dial can reach the loopback test servers. Video is the artifact.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import {
  makeGreetingMcpServer,
  serveMcpServer,
  serveMcpServerWithOAuth,
} from "@executor-js/plugin-mcp/testing";
import { OAuthTestServer } from "@executor-js/sdk/testing";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([mcpHttpPlugin()] as const);

const SlackDeepLinkManifest = Schema.Struct({
  oauth_config: Schema.Struct({
    redirect_urls: Schema.Array(Schema.String),
  }),
  settings: Schema.Struct({
    is_mcp_enabled: Schema.Boolean,
  }),
});

const decodeSlackDeepLinkManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(SlackDeepLinkManifest),
);

const SLACK_SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.files",
  "search:read.users",
  "chat:write",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "canvases:read",
  "canvases:write",
  "users:read",
  "users:read.email",
  "reactions:write",
  "reactions:read",
  "emoji:read",
  "files:read",
  "channels:write",
  "groups:write",
  "im:write",
  "mpim:write",
  "channels:read",
  "groups:read",
  "mpim:read",
] as const;

const serveSlackLikeMcpOAuthServer = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly endpoint: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const origin = `http://127.0.0.1:${port}`;
        const pathname = new URL(request.url ?? "/", origin).pathname;

        if (pathname === "/mcp") {
          response.writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32001, message: "missing_token" },
            }),
          );
          return;
        }

        if (pathname === "/.well-known/oauth-protected-resource/mcp") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              resource: `${origin}/mcp`,
              authorization_servers: [`${origin}/oauth`],
              scopes_supported: SLACK_SCOPES,
            }),
          );
          return;
        }

        if (pathname === "/.well-known/oauth-authorization-server/oauth") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              issuer: `${origin}/oauth`,
              authorization_endpoint: "https://slack.com/oauth/v2_user/authorize",
              token_endpoint: "https://slack.com/api/oauth.v2.user.access",
              code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: ["client_secret_post"],
            }),
          );
          return;
        }

        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            endpoint: `http://127.0.0.1:${port}/mcp`,
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(server.close),
  );

scenario(
  "Auth methods · a detected-OAuth server gets an API key declared alongside",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      // An OAuth-PROTECTED server: the probe gets a 401 with protected-
      // resource metadata pointing at the test OAuth issuer, so the method
      // list seeds with the detected OAuth row.
      const server = yield* serveMcpServerWithOAuth(
        () =>
          makeGreetingMcpServer({
            name: `oauth-mcp-${randomBytes(3).toString("hex")}`,
          }),
        { path: "/mcp" },
      );
      const identity = yield* target.newIdentity();

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the add-MCP flow pointed at the server", async () => {
          await visit(page, `/integrations/add/mcp?url=${encodeURIComponent(server.endpoint)}`);
          // Generous timeout: the debounced probe request can queue behind a
          // busy dev server under CI load, and there is no clean client-side
          // re-trigger to poke it mid-flight.
          await page.getByText("How does this server authenticate?").waitFor({ timeout: 90_000 });
        });

        await step("The probe detected OAuth", async () => {
          await page.getByText("Method 1 · Detected").waitFor();
          // The OAuth editor declares discovery-at-connect, not pasted URLs.
          await page.getByText("OAuth metadata is discovered from this server").waitFor();
        });

        await step("Declare an API key method alongside OAuth", async () => {
          await page.getByRole("button", { name: "Add method" }).click();
          await page.getByText("Method 2").waitFor();
          await page.getByPlaceholder("Authorization").last().waitFor();
        });

        await step("Add the integration with both methods", async () => {
          await page.getByRole("button", { name: "Add integration" }).click();
          await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, {
            timeout: 30_000,
          });
          await page.getByText("Connections").first().waitFor();
        });

        await step("The connect modal offers OAuth and the API key", async () => {
          await page.getByRole("button", { name: "Add connection" }).first().click();
          await page.getByRole("tab", { name: "OAuth" }).waitFor();
          await page.getByRole("tab", { name: "API key (Authorization)" }).waitFor();
        });
      });
    }),
  ).pipe(Effect.provide(OAuthTestServer.layer())),
);

scenario(
  "Slack MCP · Register OAuth app shows the Slack setup deep link",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const server = yield* serveSlackLikeMcpOAuthServer();
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const integrationSlug = `slack-mcp-setup-${randomBytes(3).toString("hex")}`;
      let slug: string | null = null;

      yield* Effect.gen(function* () {
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the add-MCP flow pointed at the Slack-shaped server", async () => {
            await visit(page, `/integrations/add/mcp?url=${encodeURIComponent(server.endpoint)}`);
            await page.getByText("How does this server authenticate?").waitFor({ timeout: 90_000 });
            await page.getByText("OAuth metadata is discovered from this server").waitFor();
          });

          await step("Add the OAuth MCP integration", async () => {
            await page.getByPlaceholder("e.g. Linear").fill("Slack MCP Setup");
            await page.getByPlaceholder("sentry_api").fill(integrationSlug);
            await page.getByRole("button", { name: "Add integration" }).click();
            await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, {
              timeout: 30_000,
            });
            const pathname = new URL(page.url()).pathname;
            slug = decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) ?? "");
            await page.getByText("Connections").first().waitFor();
          });

          await step("Fall back from automatic setup to app registration", async () => {
            await page.getByRole("button", { name: "Add connection" }).first().click();
            await page
              .getByRole("dialog")
              .getByRole("button", { name: "Connect", exact: true })
              .click();
            await page.getByRole("button", { name: "Register app", exact: true }).waitFor({
              timeout: 30_000,
            });
            await page.getByRole("button", { name: "Register app", exact: true }).click();
            await page.getByRole("heading", { name: "Register OAuth app" }).waitFor();
          });

          await step("The Slack setup panel embeds this form's callback URL", async () => {
            await page.getByText("Slack requires a pre-registered app").waitFor();
            const callbackUrl = await page.locator("#oauth-callback-url").innerText();
            const href = await page
              .getByRole("link", { name: "Create the Slack app" })
              .getAttribute("href");
            expect(
              href?.startsWith("https://api.slack.com/apps?new_app=1&manifest_json="),
              "the Slack app link targets Slack's manifest deep link",
            ).toBe(true);

            const url = new URL(href ?? "https://invalid.example");
            const rawManifest = url.searchParams.get("manifest_json");
            expect(rawManifest, "manifest_json is present").not.toBeNull();
            const manifest = decodeSlackDeepLinkManifest(decodeURIComponent(rawManifest ?? "{}"));
            expect(manifest.settings.is_mcp_enabled, "MCP access is enabled").toBe(true);
            expect(
              manifest.oauth_config.redirect_urls,
              "the deep link uses the displayed callback URL",
            ).toEqual([callbackUrl]);
          });
        });
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (slug !== null) {
              yield* client.mcp
                .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
                .pipe(Effect.ignore);
            }
          }),
        ),
      );
    }),
  ),
);

scenario(
  "Auth methods · a custom method added in the connect modal keeps OAuth",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      // A server that only accepts the bearer key — the connection created
      // through the custom method must render it on the wire.
      const token = `e2e-modal-key-${randomBytes(6).toString("hex")}`;
      const server = yield* serveMcpServer(() => makeGreetingMcpServer(), {
        auth: {
          validateAuthorization: (authorization) =>
            Effect.succeed(authorization === `Bearer ${token}`),
        },
      });

      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const slug = `mcp-modal-key-${randomBytes(3).toString("hex")}`;

      // The integration as the add flow would have left it: OAuth only.
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "OAuth-only MCP",
          endpoint: server.endpoint,
          slug,
          authenticationTemplate: [{ kind: "oauth2" }],
        },
      });

      // Remove the integration (and the connection it creates) afterward —
      // selfhost identities share one tenant, so a leaked connection would
      // break the "fresh identity has zero connections" scenario.
      yield* Effect.gen(function* () {
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the integration's connect modal", async () => {
            await visit(page, `/integrations/${slug}`);
            await page.getByRole("button", { name: "Add connection" }).first().click();
            await page.getByRole("tab", { name: "OAuth" }).waitFor();
          });

          await step("Add a custom API key method from the modal", async () => {
            await page.getByRole("button", { name: "Add authentication method" }).click();
            await page.getByLabel("Method name").fill("Team API key");
            await page.getByPlaceholder("Authorization").fill("Authorization");
            await page.getByPlaceholder("Bearer ").fill("Bearer ");
            await page.getByRole("button", { name: "Add method" }).click();
          });

          await step("OAuth survives next to the new method", async () => {
            await page.getByRole("tab", { name: "API key (Authorization)" }).waitFor();
            await page.getByRole("tab", { name: "OAuth" }).waitFor();
          });

          await step("Connect through the new method", async () => {
            // Custom "Authorization: Bearer " method renders the affixed field
            // with no placeholder; its accessible name is the placement name
            // ("Authorization"). The credential wizard is two steps: Continue
            // (validate) then Add connection (name + place).
            await page
              .getByRole("dialog")
              .getByRole("textbox", { name: "Authorization" })
              .fill(token);
            await page.getByRole("button", { name: "Continue" }).click();
            // Scoped to the dialog: the page also has its own "Add connection"
            // trigger button, which would otherwise make this ambiguous.
            await page.getByRole("dialog").getByRole("button", { name: "Add connection" }).click();
            await page.getByText("Connection added").waitFor();
          });
        });

        // Wire proof: discovery for the new connection hit the server with
        // the credential rendered through the custom method.
        const requests = yield* server.requests;
        expect(
          requests.some((request) => request.authorization === `Bearer ${token}`),
          "the server saw the bearer rendered through the custom method",
        ).toBe(true);
      }).pipe(
        Effect.ensuring(
          client.mcp
            .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
            .pipe(Effect.ignore),
        ),
      );
    }),
  ),
);

scenario(
  "Auth methods · the connect modal collects one value per input of a 2-input method",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      // A method with TWO credential inputs: a bearer header rendered from
      // `api_token` and a team-id query param rendered from `team_id`. The
      // server requires both on every request, so the connect-time
      // discovery dial only succeeds when the modal collected both values.
      const apiToken = `e2e-two-input-${randomBytes(4).toString("hex")}`;
      const teamId = `team-${randomBytes(3).toString("hex")}`;
      const server = yield* serveMcpServer(() => makeGreetingMcpServer(), {
        auth: {
          validateAuthorization: (authorization) =>
            Effect.succeed(authorization === `Bearer ${apiToken}`),
        },
      });

      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const slug = `mcp-two-input-${randomBytes(3).toString("hex")}`;

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Two-input MCP",
          endpoint: server.endpoint,
          slug,
          authenticationTemplate: [
            {
              slug: "token_and_team",
              type: "apiKey",
              headers: {
                Authorization: ["Bearer ", { type: "variable", name: "api_token" }],
              },
              queryParams: { team_id: [{ type: "variable", name: "team_id" }] },
            },
          ],
        },
      });

      yield* Effect.gen(function* () {
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the integration's connect modal", async () => {
            await visit(page, `/integrations/${slug}`);
            await page.getByRole("button", { name: "Add connection" }).first().click();
            await page.getByRole("tab", { name: "API key (Authorization)" }).waitFor();
          });

          const dialog = page.getByRole("dialog");
          await step("The method renders one field per credential input", async () => {
            await dialog.getByRole("textbox", { name: "Authorization" }).waitFor();
            await dialog.getByRole("textbox", { name: "team_id" }).waitFor();
          });

          await step("Fill both values and connect", async () => {
            await dialog.getByRole("textbox", { name: "Authorization" }).fill(apiToken);
            await dialog.getByRole("textbox", { name: "team_id" }).fill(teamId);
            // The credential wizard is two steps: Continue (validate) then Add
            // connection (name + place).
            await page.getByRole("button", { name: "Continue" }).click();
            // Scoped to the dialog: the page also has its own "Add connection"
            // trigger button, which would otherwise make this ambiguous.
            await dialog.getByRole("button", { name: "Add connection" }).click();
            await page.getByText("Connection added").waitFor();
          });
        });

        // Wire proof: the discovery dial rendered BOTH inputs — the bearer
        // header (the server rejects anything else) and the team-id query.
        const requests = yield* server.requests;
        expect(
          requests.some(
            (request) =>
              request.authorization === `Bearer ${apiToken}` &&
              request.url.includes(`team_id=${teamId}`),
          ),
          "the server saw the bearer header and the team-id query param together",
        ).toBe(true);
      }).pipe(
        Effect.ensuring(
          client.mcp
            .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
            .pipe(Effect.ignore),
        ),
      );
    }),
  ),
);
