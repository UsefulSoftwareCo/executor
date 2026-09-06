// An OAuth callback commits the fresh grant before it synchronizes a remote
// MCP catalog. A slow tools/list response must not keep the popup request open;
// the host keeps catalog work alive and the tools converge afterward.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Schedule } from "effect";
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
const CATALOG_REQUEST_DELAY_MS = 2_000;

const submitProviderLogin = async (loginUrl: string): Promise<string> => {
  const response = await fetch(loginUrl, {
    method: "POST",
    redirect: "manual",
    headers: { authorization: `Basic ${Buffer.from("alice:password").toString("base64")}` },
  });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) {
    throw new Error(`provider login did not redirect (${response.status})`);
  }
  return new URL(location, loginUrl).toString();
};

scenario(
  "MCP OAuth · callback closes before a slow remote catalog finishes syncing",
  { timeout: 240_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const server = yield* serveMcpServerWithOAuth(
        () => makeGreetingMcpServer({ name: "slow-callback-mcp" }),
        { path: "/mcp", authenticatedRequestDelayMs: CATALOG_REQUEST_DELAY_MS },
      );
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const displayName = `Slow callback MCP ${randomBytes(3).toString("hex")}`;
      const slug = IntegrationSlug.make(deriveMcpNamespace({ name: displayName }));
      const clientsBefore = new Set((yield* client.oauth.listClients()).map((item) => item.slug));

      yield* Effect.gen(function* () {
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Add an OAuth-protected MCP integration", async () => {
            const addUrl = new URL("/integrations/add/mcp", target.baseUrl);
            addUrl.searchParams.set("url", server.endpoint);
            await visit(page, addUrl.toString());
            await page.getByText("How does this server authenticate?").waitFor({ timeout: 30_000 });
            await page.getByPlaceholder("e.g. Linear").fill(displayName);
            await page.getByRole("button", { name: "Add integration" }).click();
            await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
          });

          await step("Authorize while the MCP catalog is deliberately slow", async () => {
            await page.getByRole("button", { name: "Add connection" }).first().click();
            await page.getByRole("heading", { name: /Add connection/ }).waitFor();

            const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
            await page.getByRole("button", { name: "Connect", exact: true }).click();
            const popup = await popupPromise;
            await popup.waitForURL(/\/login\?/, { timeout: 30_000 });
            const callbackUrl = await submitProviderLogin(popup.url());

            // Each authenticated MCP transport request is held for two seconds.
            // The callback has 1.5 seconds to render, so this can pass only if
            // catalog discovery is no longer part of the callback response.
            await popup.goto(callbackUrl, { waitUntil: "domcontentloaded", timeout: 1_500 });
            await page.getByText("Connection added", { exact: true }).waitFor({ timeout: 30_000 });
          });
        });

        const tools = yield* client.tools.list({ query: { integration: slug } }).pipe(
          Effect.filterOrFail(
            (items) => items.some((tool) => String(tool.name) === "simple_echo"),
            () => "slow_mcp_catalog_pending" as const,
          ),
          Effect.retry(Schedule.both(Schedule.spaced("1 second"), Schedule.recurs(20))),
        );
        expect(
          tools.map((tool) => String(tool.name)),
          "the host-kept background sync eventually publishes the remote tool",
        ).toContain("simple_echo");
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const clientsAfter = yield* client.oauth.listClients();
            for (const oauthClient of clientsAfter) {
              if (!clientsBefore.has(oauthClient.slug)) {
                yield* client.oauth.removeClient({
                  params: { slug: oauthClient.slug },
                  payload: { owner: oauthClient.owner },
                });
              }
            }
            yield* client.mcp.removeServer({ params: { slug } });
          }).pipe(Effect.ignore),
        ),
      );
    }),
  ).pipe(Effect.provide(OAuthTestServer.layer())),
);
