// The Add connection flow must honor the authorization server's advertised
// client-registration mechanism. CIMD is preferred over DCR, so a server that
// advertises both receives Executor's hosted metadata-document URL as the
// client_id and never receives a dynamic-registration request.
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
  "MCP OAuth · advertised CIMD starts authorization without dynamic registration",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const oauth = yield* OAuthTestServer;
      const server = yield* serveMcpServerWithOAuth(
        () => makeGreetingMcpServer({ name: "cimd-connect-mcp" }),
        { path: "/mcp" },
      );
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const displayName = `CIMD MCP ${randomBytes(3).toString("hex")}`;
      const slug = IntegrationSlug.make(deriveMcpNamespace({ name: displayName }));
      const clientsBefore = yield* client.oauth.listClients();
      const clientSlugsBefore = new Set(clientsBefore.map((candidate) => candidate.slug));
      let createdClientId: string | undefined;

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
            await page.getByText("Connections").first().waitFor();
          });

          await step("Connect with the advertised CIMD client", async () => {
            await page.getByRole("button", { name: "Add connection" }).first().click();
            await page.getByRole("heading", { name: /Add connection/ }).waitFor();

            const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
            await page.getByRole("button", { name: "Connect", exact: true }).click();
            const popup = await popupPromise;
            await popup.waitForURL((url) => url.pathname === "/login", { timeout: 30_000 });

            const authorize = (await Effect.runPromise(oauth.requests)).find(
              (request) => request.method === "GET" && request.path === "/authorize",
            );
            expect(
              authorize,
              "the popup reached the discovered authorization endpoint",
            ).toBeDefined();
            const clientId = authorize?.query["client_id"];
            createdClientId = clientId;
            expect(
              clientId,
              "authorization uses Executor's metadata document as client_id",
            ).toMatch(/^https?:\/\/[^/]+\/api\/oauth\/client-id-metadata\/.+\.json$/);
            await popup.close();
          });
        });

        const requests = yield* oauth.requests;
        expect(
          requests.filter((request) => request.method === "POST" && request.path === "/register"),
          "CIMD wins when the server also advertises DCR",
        ).toEqual([]);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (createdClientId) {
              const clientsAfter = yield* client.oauth.listClients();
              const created = clientsAfter.find(
                (candidate) =>
                  candidate.clientId === createdClientId && !clientSlugsBefore.has(candidate.slug),
              );
              if (created) {
                yield* client.oauth.removeClient({
                  params: { slug: created.slug },
                  payload: { owner: created.owner },
                });
              }
            }
            yield* client.mcp.removeServer({ params: { slug } });
          }).pipe(Effect.ignore),
        ),
      );
    }),
  ).pipe(Effect.provide(OAuthTestServer.layer({ clientIdMetadataDocumentSupported: true }))),
);
