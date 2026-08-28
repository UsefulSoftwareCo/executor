import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { mcpPlugin } from "./plugin";

const FILE_ID = "F012ABC3456";
const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const seenRpcMethods: string[] = [];

const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.String,
});
const decodeJsonRpcRequest = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcRequest));

const jsonRpcResponse = (request: typeof JsonRpcRequest.Type, result: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id: request.id ?? null, result });

const slackFallbackHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const webRequest = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
      const url = new URL(webRequest.url);

      if (url.hostname === "slack.com" && url.pathname === "/api/files.info") {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            ok: true,
            file: {
              id: FILE_ID,
              name: "external-screenshot.png",
              mimetype: "image/png",
              size: IMAGE_BYTES.byteLength,
              url_private_download: `https://files.slack.com/files-pri/T000-${FILE_ID}/download/external-screenshot.png`,
            },
          }),
        );
      }

      if (url.hostname === "files.slack.com") {
        return HttpClientResponse.fromWeb(
          request,
          new Response(IMAGE_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
        );
      }

      if (url.hostname !== "mcp.slack.com") {
        return HttpClientResponse.fromWeb(
          request,
          new Response("unexpected host", { status: 500 }),
        );
      }
      if (webRequest.method === "GET") {
        return HttpClientResponse.fromWeb(request, new Response("SSE disabled", { status: 405 }));
      }

      const rpc = Option.getOrUndefined(
        decodeJsonRpcRequest(yield* Effect.promise(() => webRequest.text())),
      );
      if (rpc === undefined) {
        return HttpClientResponse.fromWeb(
          request,
          new Response("invalid JSON-RPC", { status: 400 }),
        );
      }
      seenRpcMethods.push(rpc.method);
      if (rpc.method === "initialize") {
        return HttpClientResponse.fromWeb(
          request,
          jsonRpcResponse(rpc, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "Slack", version: "1.0.0" },
          }),
        );
      }
      if (rpc.method === "notifications/initialized") {
        return HttpClientResponse.fromWeb(request, new Response("", { status: 202 }));
      }
      if (rpc.method === "tools/list") {
        return HttpClientResponse.fromWeb(
          request,
          jsonRpcResponse(rpc, {
            tools: [
              {
                name: "slack_read_file",
                inputSchema: {
                  type: "object",
                  properties: { file_id: { type: "string" } },
                  required: ["file_id"],
                },
              },
            ],
          }),
        );
      }
      if (rpc.method === "tools/call") {
        return HttpClientResponse.fromWeb(
          request,
          jsonRpcResponse(rpc, {
            isError: true,
            content: [{ type: "text", text: "execution_failed: file_not_found" }],
          }),
        );
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response("unexpected method", { status: 400 }),
      );
    }),
  ),
);

describe("Slack Connect file fallback", () => {
  it.effect("recovers the image through the caller-visible MCP tool", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...makeTestConfig({
            plugins: [
              memoryCredentialsPlugin(),
              mcpPlugin({ httpClientLayer: slackFallbackHttpClientLayer }),
            ] as const,
          }),
          httpClientLayer: slackFallbackHttpClientLayer,
        };
        const executor = yield* Effect.acquireRelease(createExecutor(config), (executor) =>
          Effect.gen(function* () {
            yield* executor.close().pipe(Effect.ignore);
            yield* Effect.promise(() => config.testDb.close()).pipe(Effect.ignore);
          }),
        );

        yield* executor.mcp.addServer({
          name: "Slack",
          endpoint: "https://mcp.slack.com/mcp",
          slug: "slack_connect_fixture",
          remoteTransport: "streamable-http",
          auth: { kind: "oauth2" },
        });
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("slack_connect_fixture"),
          template: AuthTemplateSlug.make("oauth2"),
          value: "xoxp-test-token",
        });

        const toolAddresses = (yield* executor.tools.list()).map((tool) => String(tool.address));
        expect(seenRpcMethods).toContain("tools/list");
        expect(toolAddresses).toContain("tools.slack_connect_fixture.org.main.slack_read_file");

        const result = yield* executor.execute(
          ToolAddress.make("tools.slack_connect_fixture.org.main.slack_read_file"),
          { file_id: FILE_ID },
          { onElicitation: "accept-all" },
        );

        expect(result).toMatchObject({
          ok: true,
          data: {
            content: [
              { type: "text", text: expect.stringContaining(FILE_ID) },
              { type: "image", mimeType: "image/png" },
            ],
          },
        });
      }),
    ),
  );
});
