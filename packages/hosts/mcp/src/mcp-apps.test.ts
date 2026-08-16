import { describe, expect, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";

import {
  EXTENSION_ID,
  getUiCapability,
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
} from "./mcp-apps";

const APP_URI = "ui://executor/test.html";

const withClient = async (
  configure: (server: McpServer) => void,
  run: (client: Client) => Promise<void>,
) => {
  const server = new McpServer(
    { name: "apps-helper-test", version: "1.0.0" },
    { capabilities: { resources: {}, tools: {} } },
  );
  configure(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "apps-helper-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test helper owns both linked transports and always closes them
  try {
    await run(client);
  } finally {
    await clientTransport.close();
    await serverTransport.close();
  }
};

describe("vendored MCP Apps v2 helpers", () => {
  it("mirrors nested resourceUri metadata to the legacy key and preserves visibility", async () => {
    await withClient(
      (server) => {
        registerAppTool(
          server,
          "nested-meta",
          {
            _meta: {
              ui: { resourceUri: APP_URI, visibility: ["model"] },
            },
          },
          async () => ({ content: [{ type: "text", text: "ok" }] }),
        );
      },
      async (client) => {
        const tool = (await client.listTools()).tools.find(({ name }) => name === "nested-meta");
        expect(tool?._meta).toEqual({
          ui: { resourceUri: APP_URI, visibility: ["model"] },
          [RESOURCE_URI_META_KEY]: APP_URI,
        });
      },
    );
  });

  it("mirrors the legacy resourceUri key to nested UI metadata", async () => {
    await withClient(
      (server) => {
        registerAppTool(
          server,
          "legacy-meta",
          { _meta: { [RESOURCE_URI_META_KEY]: APP_URI } },
          async () => ({ content: [{ type: "text", text: "ok" }] }),
        );
      },
      async (client) => {
        const tool = (await client.listTools()).tools.find(({ name }) => name === "legacy-meta");
        expect(tool?._meta).toEqual({
          [RESOURCE_URI_META_KEY]: APP_URI,
          ui: { resourceUri: APP_URI },
        });
      },
    );
  });

  it("defaults app resources to the MCP Apps MIME type", async () => {
    await withClient(
      (server) => {
        registerAppResource(server, "Test App", APP_URI, {}, async () => ({
          contents: [{ uri: APP_URI, text: "<html></html>" }],
        }));
      },
      async (client) => {
        const resource = (await client.listResources()).resources.find(
          ({ uri }) => uri === APP_URI,
        );
        expect(resource?.mimeType).toBe(RESOURCE_MIME_TYPE);
      },
    );
  });

  it("extracts the MCP Apps extension capability", () => {
    const capability = { mimeTypes: [RESOURCE_MIME_TYPE] };
    expect(
      getUiCapability({
        extensions: { [EXTENSION_ID]: capability },
      }),
    ).toBe(capability);
    expect(getUiCapability({})).toBeUndefined();
    expect(getUiCapability(undefined)).toBeUndefined();
  });
});
