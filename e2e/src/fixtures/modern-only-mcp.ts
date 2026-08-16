import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";

import { Effect, Scope } from "effect";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

/** Network address of a scoped modern-only MCP fixture. */
export type ModernOnlyMcpFixture = {
  readonly url: string;
};

const requestHeaders = (source: IncomingHttpHeaders): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
};

const requestBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

const makeServer = (): McpServer => {
  const server = new McpServer({ name: "executor-modern-only-e2e", version: "1.0.0" });
  server.registerTool(
    "modern_ping",
    { description: "Answers from a modern-only MCP server" },
    async () => ({ content: [{ type: "text", text: "pong-modern" }] }),
  );
  server.registerTool(
    "modern_identity",
    { description: "Names the fixture's protocol posture" },
    async () => ({ content: [{ type: "text", text: "modern-only" }] }),
  );
  return server;
};

/**
 * Serve a real v2 MCP handler that rejects every legacy-classified request.
 * The fixture follows the e2e suite's scoped, ephemeral localhost convention.
 */
export const serveModernOnlyMcp = (): Effect.Effect<ModernOnlyMcpFixture, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<ModernOnlyMcpFixture & { readonly close: () => Promise<void> }>((resume) => {
      const handler = createMcpHandler(makeServer, { legacy: "reject" });
      const server = createServer((incoming, outgoing) => {
        void requestBody(incoming).then(async (body) => {
          const host = incoming.headers.host ?? "127.0.0.1";
          const request = new Request(new URL(incoming.url ?? "/", `http://${host}`), {
            method: incoming.method,
            headers: requestHeaders(incoming.headers),
            ...(incoming.method === "GET" || incoming.method === "HEAD" ? {} : { body }),
          });
          const response = await handler.fetch(request);
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}/mcp`,
            close: async () => {
              server.close();
              server.closeAllConnections();
              await handler.close();
            },
          }),
        );
      });
    }),
    (fixture) => Effect.promise(fixture.close).pipe(Effect.ignore),
  );
