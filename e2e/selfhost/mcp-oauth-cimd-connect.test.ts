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
  "MCP OAuth · CIMD advertises refresh support and completes connection without dynamic registration",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const oauth = yield* OAuthTestServer;
      const server = yield* serveMcpServerWithOAuth(
        () => makeGreetingMcpServer({ name: "cimd-connect-mcp" }),
        { path: "/mcp", scopes: ["read", "offline_access"] },
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
            expect(
              (authorize?.query["scope"] ?? "").split(" "),
              "authorization requests the resource's offline access scope",
            ).toContain("offline_access");
            const clientId = authorize?.query["client_id"] ?? "";
            createdClientId = clientId || undefined;
            expect(
              clientId,
              "authorization uses Executor's metadata document as client_id",
            ).toMatch(/^https?:\/\/[^/]+\/api\/oauth\/client-id-metadata\/.+\.json$/);
            const metadataResponse = await page.request.get(clientId);
            expect(metadataResponse.status(), "the client metadata document is reachable").toBe(
              200,
            );
            expect(
              await metadataResponse.json(),
              "the client declares the grant required by offline_access",
            ).toMatchObject({
              grant_types: ["authorization_code", "refresh_token"],
            });
            expect(authorize).toBeDefined();
            // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- test boundary: authorization must exist before completing the flow
            if (authorize === undefined) throw new Error("Missing authorization request");
            const completed = await Effect.runPromise(
              oauth.completeAuthorizationCodeFlow({ authorizationUrl: authorize.url }),
            );
            await popup.goto(completed.callbackUrl);
            await page
              .getByRole("heading", { name: /Add connection/ })
              .waitFor({ state: "hidden" });
            await popup.close().catch(() => undefined);
          });
        });

        const connections = yield* client.connections.list({ query: { integration: slug } });
        expect(connections, "the OAuth callback saved the connection").toHaveLength(1);
        const tools = yield* client.tools.list({ query: { integration: slug } });
        expect(
          tools.some((tool) => tool.name === "simple_echo"),
          "authenticated discovery finds the upstream tool",
        ).toBe(true);

        const invoked = yield* client.executions.execute({
          payload: {
            code: `return await ${tools[0]?.address}({});`,
            autoApprove: true,
          },
        });
        expect(invoked.status).toBe("completed");
        expect(invoked.text, "the connected tool runs through authenticated MCP").toContain(
          "mcp-ok",
        );

        const requests = yield* oauth.requests;
        expect(
          requests.some(
            (request) =>
              request.path === "/token" &&
              new URLSearchParams(request.body).get("grant_type") === "authorization_code",
          ),
          "the callback exchanged the code using the advertised client",
        ).toBe(true);
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
  ).pipe(
    Effect.provide(
      OAuthTestServer.layer({
        clientIdMetadataDocumentSupported: true,
        scopes: ["read", "offline_access"],
      }),
    ),
  ),
);
