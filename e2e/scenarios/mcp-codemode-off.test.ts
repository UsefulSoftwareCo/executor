// Transparent connection mode (`?codemode=false`). By default an Executor MCP
// session runs in "code mode": one `execute` tool the model writes TypeScript
// against, discovering connections through `tools.search()` /
// `tools.describe.tool()` and calling them as `tools.<...>()` inside the
// sandbox. Some clients instead want every tool enumerated directly (lazy /
// on-demand tool loading), so the session accepts `?codemode=false` and dumps
// the whole catalog as individually-callable MCP tools. This mirrors the
// `?codemode=false` switch in Cloudflare's MCP server.
//
// The seam under test: the SAME connected identity, opened with the query
// param, advertises its tools by name instead of behind `execute`, and a
// by-name call routes straight to the tool invoker and returns the tool's real
// result. A default (code-mode) session of the same identity is the contrast:
// it still advertises only `execute`.
//
// Cross-target: runs on every host that threads the codeMode flag through to the
// MCP server (cloud's Durable Object, self-host's in-process server, Cloudflare's
// DO). The connection tools are seeded from an OpenAPI fixture whose baseUrl is
// never contacted, and the verifiable direct call uses a built-in core tool, so
// the scenario is fully hermetic.
import { randomBytes, randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

// A built-in core tool present on every target. In transparent mode it is
// callable directly by this wire name (a static core tool's address has no
// `tools.` prefix, so it survives `addressToPath` unchanged), and it returns
// real data (the policy listing) we can verify.
const CORE_TOOL = "executor.coreTools.policies.list";

// Minimal three-operation spec: three operations become three connection tools.
// The baseUrl is never contacted; we only need the tools to exist in the
// catalog so transparent mode has something to dump.
const ordersOpenApiSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Orders API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/orders/{orderId}": {
        get: {
          operationId: "getOrder",
          summary: "Fetch a single order",
          parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "An order." } },
        },
      },
      "/orders": {
        get: {
          operationId: "listOrders",
          summary: "List orders",
          responses: { "200": { description: "The orders." } },
        },
        post: {
          operationId: "createOrder",
          summary: "Create an order",
          responses: { "201": { description: "The created order." } },
        },
      },
    },
  });

// The engine advertises each tool under `addressToPath(address)`: a leading
// proxy-root `tools.` is stripped, everything else is left as-is. Deriving the
// expected name from the same catalog the engine reads keeps the assertion from
// drifting if the address format changes.
const wireName = (address: string): string =>
  address.startsWith("tools.") ? address.slice("tools.".length) : address;

const apiKeyTemplate = [
  {
    slug: "apiKey",
    type: "apiKey",
    headers: { "x-api-key": [{ type: "variable", name: "token" }] },
  },
] as const;

scenario(
  "MCP · ?codemode=false dumps every tool directly instead of `execute`",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const apiClient = yield* client(api, identity);

    // Unique slug per run keeps parallel/repeated runs out of each other's
    // catalog (selfhost shares the bootstrap-admin identity).
    const nonce = randomBytes(4).toString("hex");
    const slug = `codemode-orders-${nonce}`;
    const specBaseUrl = "http://127.0.0.1:59999"; // never contacted

    const cleanup = Effect.gen(function* () {
      yield* apiClient.connections
        .remove({
          params: {
            owner: "org",
            integration: IntegrationSlug.make(slug),
            name: ConnectionName.make("main"),
          },
        })
        .pipe(Effect.ignore);
      yield* apiClient.integrations
        .remove({ params: { slug: IntegrationSlug.make(slug) } })
        .pipe(Effect.ignore);
    });

    yield* Effect.ensuring(
      Effect.gen(function* () {
        // Seed an integration + connection so there are connection tools to dump.
        const added = yield* apiClient.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: ordersOpenApiSpec(specBaseUrl) },
            slug,
            baseUrl: specBaseUrl,
            authenticationTemplate: apiKeyTemplate,
          },
        });
        expect(added.toolCount, "the orders fixture's operations became tools").toBe(3);

        const providers = yield* apiClient.providers.list();
        yield* apiClient.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("apiKey"),
            from: { provider: providers[0]!, id: ProviderItemId.make(randomUUID()) },
          },
        });

        // Derive the exact wire names transparent mode must advertise from the
        // catalog itself, applying the same `tools.`-strip the engine does.
        const catalog = yield* apiClient.tools.list({
          query: { integration: IntegrationSlug.make(slug) },
        });
        const expectedConnectionTools = catalog.map((tool) => wireName(String(tool.address)));
        expect(
          expectedConnectionTools.length,
          "the three connection tools are in the catalog",
        ).toBe(3);

        // A policy with an unrelated pattern: it does NOT gate `policies.list`,
        // so the direct call below runs ungated. Its id only has to appear in
        // the listing to prove the tool actually executed and returned data.
        const policy = yield* apiClient.policies.create({
          payload: { owner: "org", pattern: `codemode.gate.${nonce}`, action: "block" },
        });

        yield* Effect.ensuring(
          Effect.gen(function* () {
            // 1) Transparent mode: the tool list IS the tools, not `execute`.
            const transparent = mcp.session(identity, { codeMode: false });
            const transparentTools = yield* transparent.listTools();

            expect(transparentTools, "code mode's `execute` is gone").not.toContain("execute");
            expect(
              transparentTools,
              "the code-mode meta-tool `search` is not advertised",
            ).not.toContain("search");
            expect(
              transparentTools,
              "the code-mode meta-tool `describe.tool` is not advertised",
            ).not.toContain("describe.tool");

            for (const name of expectedConnectionTools) {
              expect(transparentTools, `connection tool ${name} is advertised directly`).toContain(
                name,
              );
            }
            expect(transparentTools, "built-in core tools are dumped too").toContain(CORE_TOOL);

            // 2) A direct call by name runs the tool and returns its real result.
            const result = yield* transparent.call(CORE_TOOL, {});
            expect(result.ok, "the direct tool call completed without error").toBe(true);
            expect(
              result.text,
              "the listing the tool returned includes the policy we created",
            ).toContain(policy.id);

            // 3) Contrast: the same identity in default (code) mode still gets
            // the single `execute` tool and does NOT dump the connection tools.
            // The query param is the only thing that flips behavior.
            const codeModeSession = mcp.session(identity);
            const codeModeTools = yield* codeModeSession.listTools();
            expect(codeModeTools, "code mode still advertises `execute`").toContain("execute");
            expect(codeModeTools, "code mode does not dump the connection tools").not.toContain(
              expectedConnectionTools[0]!,
            );
          }),
          apiClient.policies
            .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
            .pipe(Effect.ignore),
        );
      }),
      cleanup,
    );
  }),
);
