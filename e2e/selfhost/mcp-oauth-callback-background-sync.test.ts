// An OAuth callback commits the fresh grant before it synchronizes a remote
// MCP catalog. A slow tools/list response must not keep the popup request open;
// the host keeps catalog work alive and the tools converge afterward.
import { randomBytes } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { expect } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { deriveMcpNamespace } from "@executor-js/plugin-mcp";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { serveMcpServerWithOAuth } from "@executor-js/plugin-mcp/testing";
import { IntegrationSlug } from "@executor-js/sdk/shared";
import { OAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([mcpHttpPlugin()] as const);

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

for (const failsFirst of [false, true]) {
  scenario(
    `MCP OAuth · callback closes before ${failsFirst ? "failing" : "blocked"} catalog discovery and preserves the grant`,
    { timeout: 240_000 },
    Effect.scoped(
      Effect.gen(function* () {
        const target = yield* Target;
        const browser = yield* Browser;
        const { client: makeApiClient } = yield* Api;
        const gate = Promise.withResolvers<void>();
        const listing = Promise.withResolvers<void>();
        let failListing = failsFirst;
        const server = yield* serveMcpServerWithOAuth(
          () => {
            const mcp = new McpServer(
              { name: "callback-mcp", version: "1.0.0" },
              { capabilities: { tools: {} } },
            );
            mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
              listing.resolve();
              if (failListing) throw new Error("Temporary catalog outage");
              return { tools: [{ name: "simple_echo", inputSchema: { type: "object" as const } }] };
            });
            return mcp;
          },
          { path: "/mcp", beforeAuthenticatedRequest: () => gate.promise },
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
              await page
                .getByText("How does this server authenticate?")
                .waitFor({ timeout: 30_000 });
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

              // No authenticated MCP request can complete before we release
              // the gate. Callback success therefore proves ordering without
              // racing a timer against a cold browser or a loaded host.
              await popup.goto(callbackUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
              await page
                .getByText("Connection added", { exact: true })
                .waitFor({ timeout: 30_000 });
            });
          });

          const committed = yield* client.connections.list({ query: { integration: slug } });
          expect(committed.length, "the callback persisted the connection before discovery").toBe(
            1,
          );
          gate.resolve();
          yield* Effect.promise(() => listing.promise);
          const afterListing = yield* client.connections.list({ query: { integration: slug } });
          expect(
            afterListing.length,
            "a failed remote listing cannot remove the durable grant",
          ).toBe(1);
          failListing = false;

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
              gate.resolve();
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
}
