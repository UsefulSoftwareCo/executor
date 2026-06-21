// Cloud: the integration catalog's full CRUD surface plus the "registered
// integration becomes invokable tools" promise, for all three bring-your-own
// protocols (OpenAPI / MCP / GraphQL) — entirely over the wire through the
// typed client. Upstream APIs are real HTTP servers started inside the
// scenario on 127.0.0.1 (the dev server allows local-network egress), so an
// execution proves the whole chain: catalog row → connection → stamped tool →
// QuickJS execution → live upstream request.
//
// Ported from apps/cloud/src/api/sources-api.node.test.ts. Cross-user
// isolation of personal connections (alice/bob in one org) is NOT covered
// here: minting a second member of an existing org has no public API surface.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import {
  makeGreetingGraphqlSchema,
  serveGraphqlTestServer,
} from "@executor-js/plugin-graphql/testing";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { serveOpenApiEchoTestServer } from "@executor-js/plugin-openapi/testing";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin(), mcpHttpPlugin(), graphqlHttpPlugin()] as const);

/** Unique, JS-identifier-safe slug per run (tool addresses are dotted member
 *  expressions inside executed code, so no dashes). */
const newSlug = (prefix: string) =>
  IntegrationSlug.make(`${prefix}_${randomBytes(4).toString("hex")}`);

const MAIN = ConnectionName.make("main");
const PERSONAL = ConnectionName.make("personal");
const API_KEY = AuthTemplateSlug.make("apiKey");
const NONE = AuthTemplateSlug.make("none");

/** Minimal OpenAPI 3 spec with a single GET /ping operation. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Ping API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "Return a pong",
        tags: ["default"],
        responses: { "200": { description: "pong" } },
      },
    },
  },
});

/** Narrow an execution result to "completed", failing with the run's text. */
const completed = <R extends { status: string; text: string }>(
  execution: R,
): Extract<R, { status: "completed" }> => {
  if (execution.status !== "completed") {
    throw new Error(`execution did not complete (status=${execution.status}): ${execution.text}`);
  }
  return execution as Extract<R, { status: "completed" }>;
};

scenario(
  "Integrations · an OpenAPI spec round-trips the catalog: add, fetch, update, remove",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiSurface.client(api, identity);
    const slug = newSlug("srcapi");

    const added = yield* client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: pingSpec },
        slug,
        baseUrl: "http://127.0.0.1:59999", // never contacted during registration
      },
    });
    expect(added.slug, "the integration keeps the requested slug").toBe(slug);
    expect(added.toolCount, "the single operation was extracted as a tool").toBe(1);

    const listed = yield* client.integrations.list();
    expect(
      listed.map((i) => String(i.slug)),
      "the new integration is in the catalog",
    ).toContain(slug);

    const fetched = yield* client.openapi.getIntegration({ params: { slug } });
    expect(fetched, "the stored integration is fetchable through the plugin route").toMatchObject({
      slug,
      kind: "openapi",
    });

    yield* client.integrations.update({
      params: { slug },
      payload: { description: "Renamed API" },
    });
    const updated = yield* client.integrations.get({ params: { slug } });
    expect(updated?.description, "the description change round-trips").toBe("Renamed API");

    yield* client.integrations.remove({ params: { slug } });
    const after = yield* client.integrations.list();
    expect(
      after.map((i) => String(i.slug)),
      "the removed integration drops off the catalog",
    ).not.toContain(slug);
  }),
);

scenario(
  "Integrations · previewSpec reports summary metadata before anything is stored",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiSurface.client(api, identity);

    const preview = yield* client.openapi.previewSpec({ payload: { spec: pingSpec } });
    expect(preview.operationCount, "the preview counts the spec's operations").toBe(1);
    expect(Object.hasOwn(preview, "operations"), "the HTTP preview omits per-operation rows").toBe(
      false,
    );
  }),
);

scenario(
  "Integrations · a connected OpenAPI operation executes against the live upstream API",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const apiSurface = yield* Api;
      // A real upstream HTTP API on 127.0.0.1, closed by the scope's finalizer.
      const server = yield* serveOpenApiEchoTestServer();
      const identity = yield* target.newIdentity();
      const client = yield* apiSurface.client(api, identity);
      const slug = newSlug("srcapi");

      yield* client.openapi.addSpec({
        payload: {
          spec: { kind: "blob", value: server.specJson },
          slug,
          description: "Invocable upstream API",
          baseUrl: server.baseUrl,
        },
      });

      // A connection mints + persists the per-connection tools.
      yield* client.connections.create({
        payload: {
          owner: "org",
          name: MAIN,
          integration: slug,
          template: API_KEY,
          value: "static-token",
        },
      });

      const tools = yield* client.tools.list({ query: { integration: slug } });
      const address = `tools.${slug}.org.main.echo.echoMessage`;
      expect(
        tools.map((tool) => String(tool.address)),
        "the operation is stamped as a per-connection tool",
      ).toContain(address);

      const execution = completed(
        yield* client.executions.execute({
          payload: {
            code: [
              `const result = await ${address}({ message: "hello", suffix: "world" });`,
              "return result;",
            ].join("\n"),
          },
        }),
      );
      expect(execution.isError, "the execution succeeded").toBe(false);
      // Payload-first: `data` IS the upstream body; transport facts (status,
      // headers) ride in the optional `http` side channel.
      expect(execution.structured, "the tool returned the upstream's echo").toMatchObject({
        result: {
          ok: true,
          data: { message: "hello", suffix: "world", path: "/echo/hello" },
        },
      });

      const requests = yield* server.requests;
      expect(
        requests.map((request) => request.path),
        "the upstream API actually received the call",
      ).toContain("/echo/hello");
    }),
  ),
);

scenario(
  "Integrations · MCP addServer registers the catalog row without dialing the endpoint",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiSurface.client(api, identity);
    const slug = newSlug("srcmcp");

    // Discovery is deferred to connection time, so a dead endpoint still
    // registers successfully and is fetchable afterwards.
    const added = yield* client.mcp.addServer({
      payload: {
        transport: "remote",
        name: "Broken MCP",
        endpoint: "http://127.0.0.1:1/mcp",
        remoteTransport: "auto",
        slug,
      },
    });
    expect(added.slug, "the dead endpoint registered anyway").toBe(slug);

    const fetched = yield* client.mcp.getServer({ params: { slug } });
    expect(fetched, "the stored server keeps the submitted config").toMatchObject({
      slug,
      config: {
        transport: "remote",
        endpoint: "http://127.0.0.1:1/mcp",
        remoteTransport: "auto",
      },
    });
  }),
);

scenario(
  "Integrations · a connected MCP server's tool executes through the execution surface",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const apiSurface = yield* Api;
      const server = yield* serveMcpServer(() =>
        makeGreetingMcpServer({
          name: "e2e-mcp",
          toolDescription: "Echoes from the e2e MCP server",
          text: "mcp-ok",
        }),
      );
      const identity = yield* target.newIdentity();
      const client = yield* apiSurface.client(api, identity);
      const slug = newSlug("srcmcp");

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "E2E MCP",
          endpoint: server.endpoint,
          remoteTransport: "streamable-http",
          slug,
        },
      });

      yield* client.connections.create({
        payload: {
          owner: "org",
          name: MAIN,
          integration: slug,
          template: NONE,
          value: "unused",
        },
      });

      const tools = yield* client.tools.list({ query: { integration: slug } });
      const address = `tools.${slug}.org.main.simple_echo`;
      expect(
        tools.map((tool) => String(tool.address)),
        "the discovered MCP tool is stamped on the connection",
      ).toContain(address);

      const execution = completed(
        yield* client.executions.execute({
          payload: {
            code: [`const result = await ${address}({});`, "return result;"].join("\n"),
          },
        }),
      );
      expect(execution.isError, "the execution succeeded").toBe(false);
      expect(execution.structured, "the MCP tool's content came back").toMatchObject({
        result: { ok: true, data: { content: [{ type: "text", text: "mcp-ok" }] } },
      });

      const requests = yield* server.requests;
      expect(
        requests.length,
        "the live MCP server was dialed for discovery and again for the call",
      ).toBeGreaterThanOrEqual(2);
    }),
  ),
);

scenario(
  "Integrations · a connected GraphQL endpoint's query executes through the execution surface",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const apiSurface = yield* Api;
      const server = yield* serveGraphqlTestServer({
        schema: makeGreetingGraphqlSchema({ includeMutation: false }),
      });
      const identity = yield* target.newIdentity();
      const client = yield* apiSurface.client(api, identity);
      const slug = newSlug("srcgql");

      const added = yield* client.graphql.addIntegration({
        payload: { endpoint: server.endpoint, slug, name: "E2E GraphQL" },
      });
      expect(added.slug, "the integration keeps the requested slug").toBe(slug);

      yield* client.connections.create({
        payload: {
          owner: "org",
          name: MAIN,
          integration: slug,
          template: NONE,
          value: "unused",
        },
      });

      const tools = yield* client.tools.list({ query: { integration: slug } });
      const address = `tools.${slug}.org.main.query.hello`;
      expect(
        tools.map((tool) => String(tool.address)),
        "the introspected query is stamped as a tool",
      ).toContain(address);

      const execution = completed(
        yield* client.executions.execute({
          payload: {
            code: [`const result = await ${address}({ name: "Ada" });`, "return result;"].join(
              "\n",
            ),
          },
        }),
      );
      expect(execution.isError, "the execution succeeded").toBe(false);
      expect(execution.structured, "the resolver's greeting came back").toMatchObject({
        result: { ok: true, data: { hello: "Hello Ada" } },
      });

      const requests = yield* server.requests;
      expect(
        requests.map((request) => request.payload.query ?? ""),
        "the endpoint was introspected to build the tool catalog",
      ).toContainEqual(expect.stringContaining("__schema"));
      expect(
        requests.map((request) => request.payload.variables),
        "the invocation's arguments reached the upstream resolver",
      ).toContainEqual({ name: "Ada" });
    }),
  ),
);

scenario(
  "Connections · org-shared and personal connections coexist with distinct tool addresses",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiSurface.client(api, identity);
    const slug = newSlug("srcapi");

    yield* client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: pingSpec },
        slug,
        baseUrl: "http://127.0.0.1:59999",
      },
    });

    yield* client.connections.create({
      payload: {
        owner: "org",
        name: MAIN,
        integration: slug,
        template: API_KEY,
        value: "org-secret",
      },
    });
    yield* client.connections.create({
      payload: {
        owner: "user",
        name: PERSONAL,
        integration: slug,
        template: API_KEY,
        value: "personal-secret",
      },
    });

    // Each connection stamps its own address-keyed copy of the tool.
    const tools = yield* client.tools.list({ query: { integration: slug } });
    const addresses = tools.map((tool) => String(tool.address));
    expect(addresses, "the org connection has its own tool address").toContain(
      `tools.${slug}.org.main.default.ping`,
    );
    expect(addresses, "the personal connection has its own tool address").toContain(
      `tools.${slug}.user.personal.default.ping`,
    );

    // Owner filters separate the two credentials cleanly.
    const userConnections = yield* client.connections.list({
      query: { integration: slug, owner: "user" },
    });
    expect(
      userConnections.map((c) => `${c.owner}/${String(c.name)}`),
      "the user filter returns only the personal connection",
    ).toEqual(["user/personal"]);

    const orgConnections = yield* client.connections.list({
      query: { integration: slug, owner: "org" },
    });
    expect(
      orgConnections.map((c) => `${c.owner}/${String(c.name)}`),
      "the org filter returns only the shared connection",
    ).toEqual(["org/main"]);
  }),
);

// The Cloudflare OpenAPI spec is the biggest real spec we care about: 16MB,
// 2700+ operations. Pushing it through the real HTTP + storage path is the
// load-bearing check that a storage regression (per-row writes, N+1 reads)
// shows up as a slow/failing scenario instead of a prod incident — and the
// symmetric remove must land cleanly too.
const CLOUDFLARE_SPEC_PATH = fileURLToPath(
  new URL("../../packages/plugins/openapi/fixtures/cloudflare.json", import.meta.url),
);

scenario(
  "Integrations · the full 16MB Cloudflare spec (2,700+ operations) registers and removes cleanly",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiSurface.client(api, identity);
    const slug = newSlug("srccf");

    const added = yield* client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: readFileSync(CLOUDFLARE_SPEC_PATH, "utf-8") },
        slug,
        description: "Cloudflare API",
        baseUrl: "https://api.cloudflare.com/client/v4",
      },
    });
    expect(added.slug, "the giant spec registered").toBe(slug);
    expect(added.toolCount, "thousands of operations were extracted").toBeGreaterThan(1000);

    const listed = yield* client.integrations.list();
    expect(
      listed.map((i) => String(i.slug)),
      "the integration is in the catalog",
    ).toContain(slug);

    yield* client.integrations.remove({ params: { slug } });
    const after = yield* client.integrations.list();
    expect(
      after.map((i) => String(i.slug)),
      "the giant integration removes cleanly",
    ).not.toContain(slug);
  }),
);
