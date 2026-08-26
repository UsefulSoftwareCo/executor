// The per-integration search tools opt-in. A plain MCP endpoint serves only
// the core surface; a connection that says `?search_tools=true` also gets one
// minimally-described `search_<integration>` tool per connected integration,
// whose whole point is to carry the integration namespaces into the model's
// context as tool names. A call routes through the same flow as
// `tools.search({ namespace })` inside `execute`, so its results match what
// code-side enumeration returns. The proof is comparative: two sessions, same
// identity, same server, differing only in that query.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

const spec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Searchable API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/alpha": {
        get: {
          operationId: "alphaOp",
          summary: "First operation",
          responses: { "200": { description: "ok" } },
        },
      },
      "/bravo": {
        post: {
          operationId: "bravoOp",
          summary: "Second operation",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });

scenario(
  "Discovery · a session connected with search_tools=true serves one search tool per integration",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const { client: makeClient } = yield* Api;

    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const slug = unique("nssearch");

    yield* Effect.ensuring(
      Effect.gen(function* () {
        // The connection must exist before a session opens: the tool list is
        // built from the integration inventory at session creation.
        yield* client.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: spec("http://127.0.0.1:59999") },
            slug,
            baseUrl: "http://127.0.0.1:59999", // never contacted: discovery only
            authenticationTemplate: [
              {
                slug: "apiKey",
                type: "apiKey",
                headers: { "x-api-key": [{ type: "variable", name: "token" }] },
              },
            ],
          },
        });
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("apiKey"),
            value: "tok_nssearch",
          },
        });

        const searchTool = `search_${slug}`;

        // The default: a plain endpoint serves no per-integration search tools.
        const defaultSession = mcp.session(identity);
        const defaultTools = yield* defaultSession.listTools();
        expect(
          defaultTools.filter((name) => name.startsWith("search_")),
          "a plain session serves no search_<integration> tools",
        ).toEqual([]);

        // The opt-in: same identity, `?search_tools=true`.
        const optedIn = mcp.session(identity, { searchTools: true });
        const optedInTools = yield* optedIn.describeTools();
        const names = optedInTools.map((tool) => tool.name);
        expect(names, "the opted-in session serves the integration's search tool").toContain(
          searchTool,
        );
        // The core surface is untouched.
        expect(names, "execute still works on an opted-in session").toContain("execute");
        expect(names, "skills still works on an opted-in session").toContain("skills");
        // The NAME carries the namespace; the description is one shared line
        // that points back at the execute flow, kept tiny because a session
        // pays for it once per connected integration.
        const described = optedInTools.find((tool) => tool.name === searchTool);
        expect(described?.description, "the tool description points at execute").toContain(
          "execute",
        );
        expect(
          (described?.description ?? "").length,
          "the tool description stays lean",
        ).toBeLessThan(120);

        // A keyword call returns the matching tool, exactly as
        // `tools.search({ query, namespace })` inside execute would.
        const searched = yield* optedIn.call(searchTool, { query: "alpha" });
        expect(searched.ok, `the search came back: ${searched.text}`).toBe(true);
        expect(searched.text, "the keyword match is returned").toContain("alphaOp");
        expect(searched.text, "the non-match is not").not.toContain("bravoOp");

        // An empty call enumerates the whole namespace.
        const enumerated = yield* optedIn.call(searchTool, {});
        expect(enumerated.ok, `the enumeration came back: ${enumerated.text}`).toBe(true);
        expect(enumerated.text, "enumeration lists every operation").toContain("alphaOp");
        expect(enumerated.text, "enumeration lists every operation").toContain("bravoOp");
      }),
      Effect.gen(function* () {
        yield* client.connections
          .remove({
            params: {
              owner: "org",
              integration: IntegrationSlug.make(slug),
              name: ConnectionName.make("main"),
            },
          })
          .pipe(Effect.ignore);
        yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
      }),
    );
  }),
);
