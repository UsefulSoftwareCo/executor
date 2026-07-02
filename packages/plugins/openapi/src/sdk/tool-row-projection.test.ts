// ---------------------------------------------------------------------------
// Tool-row projection coverage. The invoke and list hot paths select away the
// heavy input_schema/output_schema JSON (TOOL_INVOCATION_COLUMNS) — a tool row
// is ~KBs of schemas, but routing/policy needs only the names. These tests pin
// the contract through a real dynamic integration:
//   - tools.list returns metadata without the schemas,
//   - invoke works end-to-end off the projected row,
//   - tools.schema (describe) still serves the full schemas.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpServerRequest } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import {
  createExecutor,
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { variable } from "@executor-js/sdk/http-auth";

import { openApiPlugin } from "./plugin";
import { serveOpenApiHttpApiTestServer, unwrapInvocation } from "../testing";

const testPlugins = (httpClientLayer = FetchHttpClient.layer) =>
  [openApiPlugin({ httpClientLayer }), memoryCredentialsPlugin()] as const;

const EchoHeaders = Schema.Struct({
  "x-api-key": Schema.optional(Schema.String),
});

const EchoGroup = HttpApiGroup.make("items").add(
  HttpApiEndpoint.get("echoHeaders", "/echo-headers", { success: EchoHeaders }),
);
const TestApi = HttpApi.make("testApi").add(EchoGroup);

const EchoGroupLive = HttpApiBuilder.group(TestApi, "items", (handlers) =>
  handlers.handle("echoHeaders", () =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      return EchoHeaders.make({ "x-api-key": req.headers["x-api-key"] });
    }),
  ),
);

const apiKeyTemplate = {
  slug: AuthTemplateSlug.make("apiKey"),
  type: "apiKey" as const,
  headers: { "x-api-key": [variable("token")] },
};

const setup = Effect.gen(function* () {
  const server = yield* serveOpenApiHttpApiTestServer({
    api: TestApi,
    handlersLayer: EchoGroupLive,
  });
  const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
  yield* executor.openapi.addSpec({
    spec: { kind: "blob", value: server.specJson },
    slug: "proj_api",
    baseUrl: server.baseUrl,
    authenticationTemplate: [apiKeyTemplate],
  });
  yield* executor.connections.create({
    owner: "org",
    name: ConnectionName.make("main"),
    integration: IntegrationSlug.make("proj_api"),
    template: AuthTemplateSlug.make("apiKey"),
    value: "secret-key-123",
  });
  return executor;
});

const TOOL_ADDRESS = ToolAddress.make("tools.proj_api.org.main.items.echoHeaders");

describe("tool-row projection on hot paths", () => {
  it.effect("tools.list returns metadata without loading the schema columns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* setup;
        const tools = yield* executor.tools.list({
          integration: IntegrationSlug.make("proj_api"),
        });
        const tool = tools.find((entry) => entry.address === TOOL_ADDRESS);
        expect(tool).toBeDefined();
        expect(tool!.description.length).toBeGreaterThan(0);
        // The list surface is metadata-only: the projected query never loads
        // input/output schema JSON, so the Tool carries none.
        expect(tool!.inputSchema).toBeUndefined();
        expect(tool!.outputSchema).toBeUndefined();
      }),
    ),
  );

  it.effect("invoke routes and executes off the projected row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* setup;
        const result = unwrapInvocation(yield* executor.execute(TOOL_ADDRESS, {})).data as {
          "x-api-key"?: string;
        };
        expect(result["x-api-key"]).toBe("secret-key-123");
      }),
    ),
  );

  it.effect("tools.schema still serves the full schemas", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* setup;
        const schema = yield* executor.tools.schema(TOOL_ADDRESS);
        expect(schema).not.toBeNull();
        expect(schema!.outputSchema).toBeDefined();
      }),
    ),
  );
});
