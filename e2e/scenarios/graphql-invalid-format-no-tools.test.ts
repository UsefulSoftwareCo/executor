// Cross-target (browser): adding a GraphQL source whose endpoint responds with
// a non-introspection shape must fail at credential validation with actionable
// copy, not save a connected account with an empty tool catalog.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { ConnectionName, IntegrationSlug, type Owner } from "@executor-js/sdk/shared";
import type { Page } from "playwright";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([] as const);
const VALID_KEY = "lin_test_key";
const INVALID_SHAPE_COPY =
  "The endpoint responded, but not with a GraphQL schema. Check that the URL points to a GraphQL endpoint";

const healthyIntrospection = {
  data: {
    __schema: {
      queryType: { name: "Query" },
      mutationType: null,
      types: [
        {
          kind: "OBJECT",
          name: "Query",
          description: null,
          fields: [
            {
              name: "viewer",
              description: "Current viewer",
              args: [],
              type: { kind: "SCALAR", name: "String", ofType: null },
            },
          ],
          inputFields: null,
          enumValues: null,
        },
        {
          kind: "SCALAR",
          name: "String",
          description: null,
          fields: null,
          inputFields: null,
          enumValues: null,
        },
      ],
    },
  },
};

const closeServer = (server: ReturnType<typeof createServer>) => {
  server.close();
  server.closeAllConnections();
};

const serveGraphqlApi = (handler: (request: IncomingMessage, response: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly endpoint: string; readonly close: () => void }>((resume) => {
      const server = createServer(handler);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            endpoint: `http://127.0.0.1:${port}/graphql`,
            close: () => closeServer(server),
          }),
        );
      });
    }),
    (server) => Effect.sync(server.close),
  );

const serveInvalidIntrospectionGraphqlApi = () =>
  serveGraphqlApi((request, response) => {
    if (request.method === "POST" && (request.url ?? "").startsWith("/graphql")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: {} }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });

const serveHealthyGraphqlApi = () =>
  serveGraphqlApi((request, response) => {
    if (request.method !== "POST" || !(request.url ?? "").startsWith("/graphql")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (request.headers.authorization !== VALID_KEY) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ errors: [{ message: "Unauthorized" }] }));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const query = body.includes("__schema") ? "__schema" : "viewer";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          query === "__schema" ? healthyIntrospection : { data: { viewer: "Test User" } },
        ),
      );
    });
  });

type CleanupClient = {
  readonly connections: {
    readonly list: (input: {
      readonly query: { readonly integration: IntegrationSlug };
    }) => Effect.Effect<
      readonly { readonly owner: Owner; readonly name: ConnectionName | string }[],
      unknown
    >;
    readonly remove: (input: {
      readonly params: {
        readonly owner: Owner;
        readonly integration: IntegrationSlug;
        readonly name: ConnectionName;
      };
    }) => Effect.Effect<unknown, unknown>;
  };
  readonly integrations: {
    readonly remove: (input: {
      readonly params: { readonly slug: IntegrationSlug };
    }) => Effect.Effect<unknown, unknown>;
  };
};

const cleanupIntegration = (apiClient: CleanupClient, slug: IntegrationSlug) =>
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
  });

const fillGraphqlSourceForm = async (
  page: Page,
  input: { readonly endpoint: string; readonly slug: IntegrationSlug; readonly name: string },
) => {
  await page.getByPlaceholder("https://api.example.com/graphql").fill(input.endpoint);
  await page.getByPlaceholder("e.g. Shopify API").fill(input.name);
  await page.locator("input").nth(2).fill(String(input.slug));
  await page.getByRole("button", { name: "Add method" }).click();
  await page.getByText("Method 1").waitFor();
  await page.getByLabel("Header name").fill("Authorization");
  await page.getByLabel("Prefix").fill("");
};

scenario(
  "GraphQL · invalid introspection format shows an actionable connection error",
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
              "Enter an invalid-shape endpoint with Authorization API key auth",
              async () => {
                await fillGraphqlSourceForm(page, {
                  endpoint: upstream.endpoint,
                  slug,
                  name: "Linear GraphQL",
                });
              },
            );

            await step("Add the GraphQL integration without add-time introspection", async () => {
              await page.getByRole("button", { name: "Add integration" }).click();
              await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
              await page.getByText("Connections").first().waitFor();
              await page.getByText("No connections yet").waitFor();
            });

            await step("Try to connect an API key and see the schema-format error", async () => {
              await page.getByRole("button", { name: "Add connection" }).first().click();
              const dialog = page.getByRole("dialog");
              await dialog.getByRole("tab", { name: "API key (Authorization)" }).waitFor();
              await dialog.getByRole("textbox", { name: "Authorization" }).fill(VALID_KEY);
              await dialog.getByRole("button", { name: "Continue" }).click();
              await dialog.getByRole("alert").getByText(INVALID_SHAPE_COPY).waitFor({
                timeout: 30_000,
              });
              await dialog.getByRole("alert").getByText("https://api.linear.app/graphql").waitFor();
              expect(await dialog.getByLabel("Display name").count()).toBe(0);
              await dialog.getByRole("button", { name: "Cancel" }).click();
            });

            await step("Open Tools and confirm there is no bare empty-tools state", async () => {
              await page.getByRole("tab", { name: "Tools" }).click();
              await page.getByText("No tools yet").first().waitFor({ timeout: 30_000 });
              expect(await page.getByText("No tools available").count()).toBe(0);
            });
          });

          const connections = yield* apiClient.connections.list({
            query: { integration: slug },
          });
          expect(
            connections.length,
            "invalid credential validation did not save a connection",
          ).toBe(0);

          const tools = yield* apiClient.tools.list({ query: { integration: slug } });
          expect(tools, "the invalid integration produced no tools").toEqual([]);
        }),
        cleanupIntegration(apiClient, slug),
      );
    }),
  ),
);

scenario(
  "GraphQL · valid introspection connects healthy and generates tools",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client } = yield* Api;
      const upstream = yield* serveHealthyGraphqlApi();
      const identity = yield* target.newIdentity();
      const apiClient = yield* client(api, identity);

      const slug = IntegrationSlug.make(`graphql_valid_format_${randomBytes(4).toString("hex")}`);

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* browser.session(identity, async ({ page, step }) => {
            await step("Open the Add GraphQL integration form", async () => {
              await page.goto("/integrations/add/graphql", { waitUntil: "networkidle" });
              await page.getByRole("heading", { name: "Add GraphQL integration" }).waitFor();
            });

            await step(
              "Enter a valid GraphQL endpoint with Authorization API key auth",
              async () => {
                await fillGraphqlSourceForm(page, {
                  endpoint: upstream.endpoint,
                  slug,
                  name: "Healthy GraphQL",
                });
              },
            );

            await step("Add the valid GraphQL integration", async () => {
              await page.getByRole("button", { name: "Add integration" }).click();
              await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
              await page.getByText("Connections").first().waitFor();
              await page.getByText("No connections yet").waitFor();
            });

            await step("Connect an API key and see the healthy schema check", async () => {
              await page.getByRole("button", { name: "Add connection" }).first().click();
              const dialog = page.getByRole("dialog");
              await dialog.getByRole("tab", { name: "API key (Authorization)" }).waitFor();
              await dialog.getByRole("textbox", { name: "Authorization" }).fill(VALID_KEY);
              await dialog.getByRole("button", { name: "Continue" }).click();
              await dialog.getByText("Healthy").waitFor({ timeout: 30_000 });
              await dialog.getByText("GraphQL schema: Query").waitFor();
              await dialog.getByLabel("Display name").fill("main");
              await dialog.locator("button").filter({ hasText: "Add connection" }).click();
              await page.getByText("Connection added").waitFor({ timeout: 30_000 });
              await page.getByText("GraphQL schema: Query").waitFor();
            });

            await step("Open Tools and see generated GraphQL tools", async () => {
              await page.getByRole("tab", { name: "Tools" }).click();
              await page.getByPlaceholder("Filter 1 tools…").waitFor({ timeout: 30_000 });
              await page.getByLabel("Filter tools").fill("viewer");
              await page.getByText("viewer").first().waitFor();
            });
          });

          const connections = yield* apiClient.connections.list({
            query: { integration: slug },
          });
          expect(connections.length, "the valid connection was created").toBe(1);
          expect(connections[0]?.lastHealth?.status).toBe("healthy");

          const tools = yield* apiClient.tools.list({ query: { integration: slug } });
          expect(tools.length, "the valid GraphQL integration produced tools").toBeGreaterThan(0);
        }),
        cleanupIntegration(apiClient, slug),
      );
    }),
  ),
);
