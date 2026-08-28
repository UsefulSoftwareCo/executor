import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const serveRecordingUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string;
      readonly requests: () => readonly string[];
      readonly close: () => void;
    }>((resume) => {
      const recorded: string[] = [];
      const server = createServer((request, response) => {
        recorded.push(request.url ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "2", name: "Gadget" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
            requests: () => [...recorded],
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

const itemsSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Items API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/items/{itemId}": {
        get: {
          operationId: "getItem",
          summary: "Fetch one item",
          parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "the item" } },
        },
      },
    },
  });

const invokeByAddressCode = (address: string, args: unknown) => `
const segments = ${JSON.stringify(address)}.split(".").slice(1);
let node = tools;
for (const segment of segments) node = node[segment];
const result = await node(${JSON.stringify(args)});
return JSON.stringify(result);
`;

type ToolEnvelope = {
  readonly ok: boolean;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
};

scenario(
  "OpenAPI: unknown tool arguments fail locally before any upstream request",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveRecordingUpstream();
      const slug = `openapi_unknown_args_${randomBytes(4).toString("hex")}`;

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: itemsSpec(upstream.url) },
              slug,
              baseUrl: upstream.url,
              authenticationTemplate: [
                {
                  slug: "apiKey",
                  type: "apiKey",
                  headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
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
              value: "tok_unknown_args",
            },
          });

          const tools = yield* client.tools.list({ query: {} });
          const address = tools
            .filter((tool) => String(tool.integration) === slug)
            .map((tool) => String(tool.address))
            .find((candidate) => candidate.endsWith("getItem"));
          expect(address, "the getItem operation is available").toBeDefined();

          const executed = yield* client.executions.execute({
            payload: {
              code: invokeByAddressCode(address!, { itemId: "2", doesNotExist: "nope" }),
              autoApprove: true,
            },
          });
          expect(executed.status, "the sandbox returns the tool failure as a value").toBe(
            "completed",
          );
          const outcome = JSON.parse(executed.text) as ToolEnvelope;
          expect(outcome.ok, "the unknown argument fails the tool call").toBe(false);
          expect(outcome.error?.code, "the failure is classified as invalid arguments").toBe(
            "invalid_tool_arguments",
          );
          expect(
            outcome.error?.message,
            "the failure names the argument the caller must remove",
          ).toContain("doesNotExist");
          expect(
            upstream.requests(),
            "argument validation stops the call before upstream dispatch",
          ).toEqual([]);
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
  ),
);
