import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { mcpPlugin } from "./plugin";
import {
  TEST_IMAGE_MIME_TYPE,
  TEST_IMAGE_PNG_BASE64,
  makeImageMcpServer,
  serveMcpServer,
} from "../testing";

const INTEGRATION = IntegrationSlug.make("image_mcp");
const TEMPLATE = AuthTemplateSlug.make("none");

const imageBlock = {
  type: "image",
  data: TEST_IMAGE_PNG_BASE64,
  mimeType: TEST_IMAGE_MIME_TYPE,
};

describe("MCP image content", () => {
  it.effect("preserves upstream MCP image content through plugin invocation", () =>
    Effect.gen(function* () {
      const server = yield* serveMcpServer(makeImageMcpServer);
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
      );

      yield* executor.mcp.addServer({
        name: "Image MCP",
        endpoint: server.url,
        slug: String(INTEGRATION),
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEGRATION,
        template: TEMPLATE,
        value: "",
      });

      const imageOnly = yield* executor.execute(
        ToolAddress.make("tools.image_mcp.org.main.image_fixture"),
        {},
        { onElicitation: "accept-all" },
      );
      expect(imageOnly).toMatchObject({
        ok: true,
        data: {
          content: [imageBlock],
          structuredContent: {
            name: "mcp-image-fixture.png",
            mimeType: TEST_IMAGE_MIME_TYPE,
            byteLength: 70,
          },
        },
      });

      const mixed = yield* executor.execute(
        ToolAddress.make("tools.image_mcp.org.main.image_fixture_with_metadata"),
        {},
        { onElicitation: "accept-all" },
      );
      expect(mixed).toMatchObject({
        ok: true,
        data: {
          content: [
            {
              type: "text",
              text: "Deterministic image fixture: mcp-image-fixture.png (image/png, 70 bytes)",
            },
            imageBlock,
          ],
        },
      });
    }),
  );
});
