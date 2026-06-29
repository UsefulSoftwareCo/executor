// Cloud-only: auth failure propagation through the full execution stack —
// HTTP API → execution engine → sandbox code → OpenAPI tool invocation. When a
// connection's credential value cannot resolve (a `from` reference to a vault
// item that was never stored), invoking one of its tools must surface a
// structured, model-visible `connection_value_missing` auth failure — not an
// opaque internal tool error — so an agent can tell the user to re-connect.
import { randomBytes } from "node:crypto";

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
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

/** Minimal OpenAPI spec with a single GET /ping. The base URL is never
 *  reached: credential resolution fails before any HTTP call is made. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Ping API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", summary: "Ping", responses: { "200": { description: "pong" } } },
    },
  },
});

scenario(
  "Executions · a tool call with an unresolvable credential fails with connection_value_missing",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);

    // Identifier-safe slug: it becomes a property path in the sandbox code.
    const slug = IntegrationSlug.make(`authscn${randomBytes(4).toString("hex")}`);
    yield* client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: pingSpec },
        slug,
        baseUrl: "https://api.example.test",
        authenticationTemplate: [
          {
            slug: "apiKey",
            type: "apiKey",
            headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
          },
        ],
      },
    });

    // A connection whose value cannot resolve: a `from` reference into the
    // real credential provider, pointing at an item that was never stored.
    const providers = yield* client.providers.list();
    expect(providers.length, "a credential provider is registered").toBeGreaterThan(0);
    yield* client.connections.create({
      payload: {
        owner: "org",
        name: ConnectionName.make("main"),
        integration: slug,
        template: AuthTemplateSlug.make("apiKey"),
        from: { provider: providers[0]!, id: ProviderItemId.make(`${slug}-never-stored`) },
      },
    });

    // The tool is in the catalog; its address is the sandbox call path.
    const tools = yield* client.tools.list({ query: {} });
    const tool = tools.find((entry) => String(entry.integration) === String(slug));
    expect(tool?.address, "the integration's tool is in the catalog").toBeDefined();

    const execution = yield* client.executions.execute({
      payload: {
        code: [`const result = await ${tool!.address}({});`, "return result;"].join("\n"),
      },
    });

    expect(execution.status, "the execution itself completes").toBe("completed");
    if (execution.status !== "completed") return; // unreachable — narrowing only
    expect(execution.isError, "an auth failure is a model-visible result, not a tool error").toBe(
      false,
    );
    expect(
      JSON.stringify(execution.structured).toLowerCase(),
      "no opaque internal tool error reaches the model",
    ).not.toContain("internal tool error");
    expect(
      execution.structured,
      "the model sees a structured authentication failure it can act on",
    ).toMatchObject({
      status: "completed",
      result: {
        ok: false,
        error: {
          code: "connection_value_missing",
          details: { category: "authentication" },
        },
      },
    });
  }),
);
