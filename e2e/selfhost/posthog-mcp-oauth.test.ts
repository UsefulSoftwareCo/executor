// Hermetic selfhost browser regression for the reported PostHog MCP OAuth
// dead-end. A real Executor instance adds a wire-level OAuth-protected MCP
// server, then starts the connection flow. The product guarantee: clicking
// Connect reaches the authorization page through dynamic client registration,
// not the bring-your-own OAuth app picker with "Automatic setup unavailable".
//
// This used to call PostHog's production MCP and OAuth sites directly. That
// made Executor CI depend on a third party's availability, metadata, and popup
// response time. The local fixtures implement the same RFC 9728 discovery,
// RFC 8414 metadata, RFC 7591 registration, and authorization redirect over
// real HTTP, while keeping the assertion deterministic.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { deriveMcpNamespace } from "@executor-js/plugin-mcp";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeGreetingMcpServer, serveMcpServerWithOAuth } from "@executor-js/plugin-mcp/testing";
import { IntegrationSlug } from "@executor-js/sdk/shared";
import { OAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([mcpHttpPlugin()] as const);

scenario(
  "MCP OAuth · dynamic registration opens the discovered authorization server",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const oauth = yield* OAuthTestServer;
      const server = yield* serveMcpServerWithOAuth(
        () => makeGreetingMcpServer({ name: "dcr-regression-mcp" }),
        { path: "/mcp" },
      );
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const displayName = `PostHog MCP ${randomBytes(3).toString("hex")}`;
      const slug = IntegrationSlug.make(deriveMcpNamespace({ name: displayName }));

      yield* Effect.gen(function* () {
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the add-MCP flow pointed at the OAuth server", async () => {
            const addUrl = new URL("/integrations/add/mcp", target.baseUrl);
            addUrl.searchParams.set("url", server.endpoint);
            await visit(page, addUrl.toString());
            await page.getByText("How does this server authenticate?").waitFor({ timeout: 30_000 });
            await page.getByText("OAuth · Detected").waitFor();
            await page.getByText("OAuth metadata is discovered from this server").waitFor();
          });

          await step("Add the PostHog MCP integration", async () => {
            await page.getByPlaceholder("e.g. Linear").fill(displayName);
            await page.getByRole("button", { name: "Add integration" }).click();
            await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
            const landedSlug = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
            expect(landedSlug, "the add flow lands on the created integration").toBe(String(slug));
            await page.getByText("Connections").first().waitFor();
          });

          await step("Start OAuth from Add connection", async () => {
            await page.getByRole("button", { name: "Add connection" }).first().click();
            await page.getByRole("heading", { name: /Add connection/ }).waitFor();
            await page.getByRole("tab", { name: "OAuth" }).waitFor();

            const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
            await page.getByRole("button", { name: "Connect", exact: true }).click();
            const popup = await popupPromise;
            await popup.waitForURL((url) => url.origin === new URL(oauth.issuerUrl).origin, {
              timeout: 30_000,
            });
            await popup.waitForLoadState("domcontentloaded", { timeout: 30_000 });

            const authorizeUrl = new URL(popup.url());
            expect(authorizeUrl.origin, "OAuth opened the discovered authorization host").toBe(
              new URL(oauth.authorizationEndpoint).origin,
            );
            await popup.close();
          });
        });

        const oauthRequests = yield* oauth.requests;
        expect(
          oauthRequests.some(
            (request) => request.method === "POST" && request.path === "/register",
          ),
          "the connection flow dynamically registered its OAuth client",
        ).toBe(true);
        const authorizeRequest = oauthRequests.find(
          (request) => request.method === "GET" && request.path === "/authorize",
        );
        expect(
          authorizeRequest,
          "the popup reached the discovered authorize endpoint",
        ).toBeDefined();
        expect(authorizeRequest?.query.resource, "resource targets the MCP endpoint").toBe(
          server.endpoint,
        );
      }).pipe(Effect.ensuring(client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore)));
    }),
  ).pipe(Effect.provide(OAuthTestServer.layer())),
);
