// Cross-target (browser): GraphQL source discovery can fail silently at
// connection-create time. The UI journey is the reported shape: add a GraphQL
// integration, connect an API key, see the connection saved, then land on an
// empty Tools tab with no visible error explaining that introspection failed.
//
// This is intentionally a passing repro of the current buggy behavior. The
// upstream is a local node:http server that returns HTTP 200 with a GraphQL-ish
// body in the wrong introspection shape: `{ "data": {} }`.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([] as const);

const serveInvalidIntrospectionGraphqlApi = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly endpoint: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        if (request.method === "POST" && (request.url ?? "").startsWith("/graphql")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: {} }));
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            endpoint: `http://127.0.0.1:${port}/graphql`,
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
  "GraphQL · invalid introspection format creates a connected account with zero tools",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client } = yield* Api;
      const upstream = yield* serveInvalidIntrospectionGraphqlApi();
      const identity = yield* target.newIdentity();
      const apiClient = yield* client(api, identity);

      const slug = IntegrationSlug.make(`graphql_invalid_format_${randomBytes(4).toString("hex")}`);

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* browser.session(identity, async ({ page, step }) => {
            await step("Open the Add GraphQL integration form", async () => {
              await page.goto("/integrations/add/graphql", { waitUntil: "networkidle" });
              await page.getByRole("heading", { name: "Add GraphQL integration" }).waitFor();
            });

            await step(
              "Enter the endpoint and declare Linear-style Authorization API key auth",
              async () => {
                await page
                  .getByPlaceholder("https://api.example.com/graphql")
                  .fill(upstream.endpoint);
                await page.getByPlaceholder("e.g. Shopify API").fill("Linear GraphQL");
                await page.locator("input").nth(2).fill(String(slug));
                await page.getByRole("button", { name: "Add method" }).click();
                await page.getByText("Method 1").waitFor();
                await page.getByLabel("Header name").fill("Authorization");
                await page.getByLabel("Prefix").fill("");
              },
            );

            await step("Add the GraphQL integration without add-time introspection", async () => {
              await page.getByRole("button", { name: "Add integration" }).click();
              await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
              await page.getByText("Connections").first().waitFor();
              await page.getByText("No connections yet").waitFor();
            });

            await step("Connect an API key", async () => {
              await page.getByRole("button", { name: "Add connection" }).first().click();
              const dialog = page.getByRole("dialog");
              await dialog.getByRole("tab", { name: "API key (Authorization)" }).waitFor();
              await dialog.getByRole("textbox", { name: "Authorization" }).fill("lin_test_key");
              await dialog.getByRole("button", { name: "Continue" }).click();
              await dialog.getByLabel("Display name").fill("main");
              await dialog.getByRole("button", { name: "Add connection" }).click();
              await page.getByText("Connection added").waitFor({ timeout: 30_000 });
              await page.getByText("main").waitFor();
            });

            await step("Open Tools and observe the empty catalog with no error", async () => {
              await page.getByRole("tab", { name: "Tools" }).click();
              await page.getByPlaceholder("Filter 0 tools…").waitFor({ timeout: 30_000 });
              await page.getByText("No tools available").first().waitFor();

              const visibleErrorCopy = await page
                .getByText(
                  /Failed to add connection|Failed to load tools|Introspection failed|invalid shape/i,
                )
                .count();
              expect(
                visibleErrorCopy,
                "no visible error explains the invalid introspection body",
              ).toBe(0);
            });
          });

          const connections = yield* apiClient.connections.list({
            query: { integration: slug },
          });
          expect(connections.length, "the connection was created").toBe(1);

          const tools = yield* apiClient.tools.list({ query: { integration: slug } });
          expect(tools, "the connected GraphQL integration produced no tools").toEqual([]);
        }),
        Effect.gen(function* () {
          const connections = yield* apiClient.connections
            .list({ query: { integration: slug } })
            .pipe(Effect.catch(() => Effect.succeed([])));
          for (const connection of connections) {
            yield* apiClient.connections
              .remove({
                params: {
                  owner: connection.owner,
                  integration: slug,
                  name: ConnectionName.make(String(connection.name)),
                },
              })
              .pipe(Effect.ignore);
          }
          yield* apiClient.integrations.remove({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
