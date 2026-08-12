import { Buffer } from "node:buffer";
import { once } from "node:events";
import * as http from "node:http";

import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Schema } from "effect";
import { createMcpHandler, McpServer as ModernMcpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { ElicitationResponse, type Elicit } from "@executor-js/sdk";

import { makeEchoMcpServer, serveMcpServer } from "../testing";
import { createMcpConnector, type McpConnector } from "./connection";
import { createMcpConnectionPool } from "./connection-pool";
import { discoverTools } from "./discover";
import { invokeMcpTool } from "./invoke";

const acceptAll: Elicit = () =>
  Effect.succeed(ElicitationResponse.make({ action: "accept", content: { approved: true } }));

type CapturedRequest = {
  readonly method: string | undefined;
  readonly protocolVersion: string | null;
  readonly sessionId: string | null;
};

type ModernTestServer = {
  readonly endpoint: string;
  readonly requests: () => readonly CapturedRequest[];
  readonly factoryCalls: () => number;
};

class ModernTestServerError extends Data.TaggedError("ModernTestServerError")<{
  readonly reason: string;
}> {}

const decodeRequestBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ method: Schema.optional(Schema.String) })),
);

const headersFromIncoming = (incoming: http.IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
};

const readBody = async (incoming: http.IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const listen = (server: http.Server): Effect.Effect<number, Error | ModernTestServerError> =>
  Effect.callback<number, Error | ModernTestServerError>((resume) => {
    const onError = (error: Error): void => resume(Effect.fail(error));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        resume(Effect.succeed(address.port));
      } else {
        resume(
          Effect.fail(
            new ModernTestServerError({ reason: "Modern MCP test server exposed no TCP port" }),
          ),
        );
      }
    });
  });

const closeNodeServer = (server: http.Server): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
    server.closeAllConnections?.();
  });

/**
 * A real HTTP endpoint backed by the v2 `@modelcontextprotocol/server`
 * handler. This intentionally avoids a handwritten JSON-RPC fake: the test
 * must fail if Executor's v2 client and the published v2 server SDK disagree
 * about discovery, metadata headers, tool schemas, or result envelopes.
 */
const serveModernMcpServer = Effect.acquireRelease(
  Effect.gen(function* () {
    const captured: CapturedRequest[] = [];
    let factoryCalls = 0;
    const handler = createMcpHandler(
      () => {
        factoryCalls += 1;
        const server = new ModernMcpServer({ name: "modern-echo", version: "1" });
        server.registerTool(
          "echo",
          {
            description: "Echoes a string",
            inputSchema: z.object({ value: z.string() }),
          },
          ({ value }) => ({ content: [{ type: "text", text: value }] }),
        );
        return server;
      },
      { legacy: "reject" },
    );

    const nodeServer = http.createServer((incoming, outgoing) => {
      const serve = async (): Promise<void> => {
        const headers = headersFromIncoming(incoming);
        const body = await readBody(incoming);
        const url = new URL(incoming.url ?? "/", `http://${headers.get("host")}`);
        if (url.pathname !== "/mcp") {
          outgoing.writeHead(404).end();
          return;
        }

        const parsed = body.byteLength > 0 ? decodeRequestBody(body.toString("utf8")) : undefined;
        captured.push({
          method: parsed?.method,
          protocolVersion: headers.get("mcp-protocol-version"),
          sessionId: headers.get("mcp-session-id"),
        });
        const responseClosed = new AbortController();
        outgoing.once("close", () => responseClosed.abort());
        const request = new Request(url, {
          method: incoming.method,
          headers,
          body: body.byteLength > 0 ? Uint8Array.from(body) : undefined,
          signal: responseClosed.signal,
        });
        const response = await handler.fetch(request);
        outgoing.statusCode = response.status;
        response.headers.forEach((value, name) => outgoing.setHeader(name, value));
        if (response.body === null) {
          outgoing.end();
          return;
        }
        const reader = response.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (!outgoing.write(Buffer.from(chunk.value))) await once(outgoing, "drain");
        }
        outgoing.end();
      };

      void serve().then(
        () => undefined,
        () => {
          if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "text/plain" });
          outgoing.end("Modern MCP test server failed");
        },
      );
    });
    const port = yield* listen(nodeServer);

    return {
      endpoint: `http://127.0.0.1:${port}/mcp`,
      requests: () => captured,
      factoryCalls: () => factoryCalls,
      close: Effect.promise(() => handler.close()).pipe(
        Effect.andThen(closeNodeServer(nodeServer)),
      ),
    };
  }),
  (server) => server.close.pipe(Effect.ignore),
).pipe(Effect.map(({ close: _close, ...server }) => server satisfies ModernTestServer));

const connectorFor = (endpoint: string): McpConnector =>
  createMcpConnector({
    transport: "remote",
    endpoint,
    remoteTransport: "streamable-http",
  });

const invokeEcho = (connector: McpConnector, value: string) =>
  invokeMcpTool({
    toolId: "echo",
    toolName: "echo",
    args: { value },
    transport: "streamable-http",
    connector,
    elicit: acceptAll,
  });

describe("MCP protocol-era integration", () => {
  it.effect("negotiates, discovers, and invokes a real legacy v1 SDK server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());
        const connector = connectorFor(server.endpoint);

        const connection = yield* connector;
        expect(connection.protocolEra()).toBe("legacy");
        yield* Effect.promise(() => connection.close());

        const manifest = yield* discoverTools(connector);
        expect(manifest.tools.map((tool) => tool.toolName)).toEqual(["echo"]);
        const result = yield* invokeEcho(connector, "legacy-ok");
        expect(result).toMatchObject({ content: [{ type: "text", text: "legacy-ok" }] });

        const requests = yield* server.requests;
        expect(requests.some((request) => request.sessionId === undefined)).toBe(true);
        expect(requests.some((request) => request.sessionId !== undefined)).toBe(true);
        expect(server.sessionCount()).toBeGreaterThanOrEqual(3);
      }),
    ),
  );

  it.effect("negotiates, discovers, and invokes a real stateless v2 SDK server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveModernMcpServer;
        const connector = connectorFor(server.endpoint);

        const connection = yield* connector;
        expect(connection.protocolEra()).toBe("modern");
        yield* Effect.promise(() => connection.close());

        const manifest = yield* discoverTools(connector);
        expect(manifest.tools.map((tool) => tool.toolName)).toEqual(["echo"]);
        const result = yield* invokeEcho(connector, "modern-ok");
        expect(result).toMatchObject({ content: [{ type: "text", text: "modern-ok" }] });

        expect(server.requests().map((request) => request.method)).toEqual([
          "server/discover",
          "subscriptions/listen",
          "server/discover",
          "subscriptions/listen",
          "tools/list",
          "server/discover",
          "subscriptions/listen",
          "tools/call",
        ]);
        expect(server.requests().every((request) => request.sessionId === null)).toBe(true);
        expect(server.requests().every((request) => request.protocolVersion === "2026-07-28")).toBe(
          true,
        );
        // The v2 server factory is intentionally per-request, including
        // discovery and subscription setup. There is no hidden wire session.
        expect(server.factoryCalls()).toBe(8);
      }),
    ),
  );

  it.effect("reuses the modern client safely without introducing a wire session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveModernMcpServer;
        const connector = connectorFor(server.endpoint);
        const pool = createMcpConnectionPool();
        const invoke = (value: string) =>
          invokeMcpTool({
            toolId: "echo",
            toolName: "echo",
            args: { value },
            transport: "streamable-http",
            connector,
            connectionPool: pool,
            connectionPoolKey: server.endpoint,
            elicit: acceptAll,
          });

        const first = yield* invoke("first");
        const second = yield* invoke("second");
        expect(first).toMatchObject({ content: [{ type: "text", text: "first" }] });
        expect(second).toMatchObject({ content: [{ type: "text", text: "second" }] });
        expect(server.requests().map((request) => request.method)).toEqual([
          "server/discover",
          "subscriptions/listen",
          "tools/call",
          "tools/call",
        ]);
        expect(server.requests().every((request) => request.sessionId === null)).toBe(true);
        yield* pool.close();
      }),
    ),
  );
});
