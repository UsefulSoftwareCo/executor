// Selfhost-only (browser): the multi-method auth UX beyond the no-auth case —
// an OAuth-DETECTED server gets an API key declared alongside at add time, and
// the connect modal's "+ method" adds a custom API key to an OAuth integration
// without displacing it. Selfhost-only because cloud has no browser identity
// yet and these paste a credential into the default store; the cross-target
// no-auth add-flow variant lives in scenarios/auth-methods-ui.test.ts. The
// selfhost instance runs with EXECUTOR_ALLOW_LOCAL_NETWORK so its outbound
// probe/dial can reach the loopback test servers. Video is the artifact.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
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

const api = composePluginApi([mcpHttpPlugin()] as const);

scenario(
  "Auth methods · a detected-OAuth server gets an API key declared alongside",
  { needs: ["browser"] },
  (ctx) =>
    Effect.scoped(
      Effect.gen(function* () {
        // An OAuth-PROTECTED server: the probe gets a 401 with protected-
        // resource metadata pointing at the test OAuth issuer, so the method
        // list seeds with the detected OAuth row.
        const server = yield* serveMcpServerWithOAuth(
          () => makeGreetingMcpServer({ name: `oauth-mcp-${randomBytes(3).toString("hex")}` }),
          { path: "/mcp" },
        );
        const identity = yield* ctx.target.newIdentity();

        yield* ctx.browser.session(identity, async ({ page, step }) => {
          await step("Open the add-MCP flow pointed at the server", async () => {
            await page.goto(`/integrations/add/mcp?url=${encodeURIComponent(server.endpoint)}`, {
              waitUntil: "networkidle",
            });
            await page.getByText("How does this server authenticate?").waitFor();
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

          await step("Add the source with both methods", async () => {
            await page.getByRole("button", { name: "Add source" }).click();
            await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
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
  "Auth methods · a custom method added in the connect modal keeps OAuth",
  { needs: ["browser", "api"] },
  (ctx) =>
    Effect.scoped(
      Effect.gen(function* () {
        // A server that only accepts the bearer key — the connection created
        // through the custom method must render it on the wire.
        const token = `e2e-modal-key-${randomBytes(6).toString("hex")}`;
        const server = yield* serveMcpServer(() => makeGreetingMcpServer(), {
          auth: {
            validateAuthorization: (authorization) =>
              Effect.succeed(authorization === `Bearer ${token}`),
          },
        });

        const identity = yield* ctx.target.newIdentity();
        const client = yield* ctx.api.client(api, identity);
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
          yield* ctx.browser.session(identity, async ({ page, step }) => {
            await step("Open the integration's connect modal", async () => {
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
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
              await page.getByPlaceholder("paste the value / token").fill(token);
              await page.getByRole("button", { name: "Add connection" }).click();
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
