import { Context, Data, Effect, Layer, Ref, Scope } from "effect";
import * as http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { OAuthTestServer } from "@executor-js/sdk/testing";
import z from "zod";

export type McpTestServer = {
  readonly url: string;
  readonly endpoint: string;
  /** Number of MCP sessions created (each connect = 1 session) */
  readonly sessionCount: () => number;
  readonly requests: Effect.Effect<readonly McpTestRequest[]>;
  readonly clearRequests: Effect.Effect<void>;
};

export type McpTestRequest = {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly sessionId: string | undefined;
};

export type McpTestServerOptions = {
  readonly path?: string;
  readonly auth?: {
    readonly validateAuthorization: (authorization: string | undefined) => Effect.Effect<boolean>;
    readonly authorizationServerUrls?: readonly string[];
    readonly scopes?: readonly string[];
    readonly wwwAuthenticate?: string;
  };
};

export class McpTestServerError extends Data.TaggedError("McpTestServerError")<{
  readonly cause: unknown;
}> {}

const writeJson = (
  response: http.ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {},
) => {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
};

const writeText = (response: http.ServerResponse, status: number, body: string) => {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
};

const isMcpPath = (url: string, path: string): boolean => {
  const parsed = new URL(url, "http://executor.test");
  return parsed.pathname === path;
};

const protectedResourcePath = "/.well-known/oauth-protected-resource";

export const serveMcpServer = (factory: () => McpServer, options: McpTestServerOptions = {}) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const transports = new Map<string, StreamableHTTPServerTransport>();
      const requests = yield* Ref.make<readonly McpTestRequest[]>([]);
      const path = options.path ?? "/";
      let sessions = 0;

      const handleMcpRequest = (
        request: http.IncomingMessage,
        response: http.ServerResponse,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const requestUrl = request.url ?? "/";
          const sessionId = Array.isArray(request.headers["mcp-session-id"])
            ? request.headers["mcp-session-id"][0]
            : request.headers["mcp-session-id"];
          const authorization = Array.isArray(request.headers.authorization)
            ? request.headers.authorization[0]
            : request.headers.authorization;
          const origin = request.headers.host
            ? `http://${request.headers.host}`
            : "http://127.0.0.1";

          yield* Ref.update(requests, (all) => [
            ...all,
            {
              method: request.method ?? "GET",
              url: requestUrl,
              authorization,
              sessionId,
            },
          ]);

          if (
            options.auth?.authorizationServerUrls &&
            requestUrl.startsWith(protectedResourcePath)
          ) {
            const resourcePath = requestUrl.slice(protectedResourcePath.length);
            writeJson(response, 200, {
              resource: `${origin}${resourcePath}`,
              authorization_servers: options.auth.authorizationServerUrls,
              bearer_methods_supported: ["header"],
              scopes_supported: options.auth.scopes ?? ["read"],
            });
            return;
          }

          if (!isMcpPath(requestUrl, path)) {
            writeJson(response, 404, { error: "not_found" });
            return;
          }

          if (options.auth) {
            const accepted = yield* options.auth.validateAuthorization(authorization);
            if (!accepted) {
              writeJson(
                response,
                401,
                { error: "invalid_token" },
                {
                  "www-authenticate":
                    options.auth.wwwAuthenticate ??
                    `Bearer resource_metadata="${origin}${protectedResourcePath}${path}", error="invalid_token"`,
                },
              );
              return;
            }
          }

          const existingTransport = sessionId ? transports.get(sessionId) : undefined;
          if (sessionId && !existingTransport) {
            writeText(response, 404, "Session not found");
            return;
          }

          if (existingTransport) {
            yield* Effect.tryPromise({
              try: () => existingTransport.handleRequest(request, response),
              catch: (cause) => new McpTestServerError({ cause }),
            });
            return;
          }

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, transport);
            },
          });
          sessions += 1;

          const mcpServer = factory();
          yield* Effect.tryPromise({
            try: () => mcpServer.connect(transport),
            catch: (cause) => new McpTestServerError({ cause }),
          });
          yield* Effect.tryPromise({
            try: () => transport.handleRequest(request, response),
            catch: (cause) => new McpTestServerError({ cause }),
          });
        }).pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              if (!response.headersSent) {
                writeJson(response, 500, { error: "mcp_test_server_failed" });
              } else if (!response.writableEnded) {
                response.end();
              }
            }),
          ),
        );

      const nodeServer = http.createServer((request, response) => {
        void Effect.runPromise(handleMcpRequest(request, response));
      });

      const port = yield* Effect.callback<number, McpTestServerError>((resume) => {
        const onError = (cause: Error) => {
          nodeServer.off("error", onError);
          resume(Effect.fail(new McpTestServerError({ cause })));
        };
        nodeServer.once("error", onError);
        nodeServer.listen(0, () => {
          nodeServer.off("error", onError);
          const address = nodeServer.address();
          if (typeof address === "object" && address) {
            resume(Effect.succeed(address.port));
            return;
          }
          resume(Effect.fail(new McpTestServerError({ cause: address })));
        });
      });

      const baseUrl = `http://127.0.0.1:${port}`;
      const endpoint = path === "/" ? baseUrl : new URL(path, baseUrl).toString();
      return {
        url: endpoint,
        endpoint,
        sessionCount: () => sessions,
        requests: Ref.get(requests),
        clearRequests: Ref.set(requests, []),
        close: Effect.gen(function* () {
          for (const transport of transports.values()) {
            yield* Effect.tryPromise({
              try: () => transport.close(),
              catch: (cause) => new McpTestServerError({ cause }),
            }).pipe(Effect.ignore);
          }
          yield* Effect.sync(() => {
            nodeServer.close();
            nodeServer.closeAllConnections?.();
          });
        }),
      };
    }),
    (server) => server.close,
  ).pipe(Effect.map(({ close: _close, ...server }) => server));

export const serveMcpServerWithOAuth = (
  factory: () => McpServer,
  options: Omit<McpTestServerOptions, "auth"> & {
    readonly scopes?: readonly string[];
    readonly wwwAuthenticate?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const oauth = yield* OAuthTestServer;
    return yield* serveMcpServer(factory, {
      path: options.path,
      auth: {
        validateAuthorization: oauth.acceptsAuthorizationHeader,
        authorizationServerUrls: [oauth.issuerUrl],
        scopes: options.scopes ?? ["read"],
        wwwAuthenticate: options.wwwAuthenticate,
      },
    });
  });

export class McpTestServerLayer extends Context.Service<McpTestServerLayer, McpTestServer>()(
  "@executor-js/plugin-mcp/testing/McpTestServer",
) {
  static readonly layer = (
    factory: () => McpServer,
    options?: McpTestServerOptions,
  ): Layer.Layer<McpTestServerLayer, McpTestServerError, Scope.Scope> =>
    Layer.effect(McpTestServerLayer, serveMcpServer(factory, options));

  static readonly layerWithOAuth = (
    factory: () => McpServer,
    options?: Omit<McpTestServerOptions, "auth"> & {
      readonly scopes?: readonly string[];
      readonly wwwAuthenticate?: string;
    },
  ): Layer.Layer<McpTestServerLayer, McpTestServerError, Scope.Scope | OAuthTestServer> =>
    Layer.effect(McpTestServerLayer, serveMcpServerWithOAuth(factory, options));
}

export const makeGreetingMcpServer = (
  options: {
    readonly name?: string;
    readonly version?: string;
    readonly toolName?: string;
    readonly toolDescription?: string;
    readonly text?: string;
  } = {},
) => {
  const server = new McpServer(
    {
      name: options.name ?? "executor-test-mcp",
      version: options.version ?? "1.0.0",
    },
    { capabilities: {} },
  );

  server.registerTool(
    options.toolName ?? "simple_echo",
    {
      description: options.toolDescription ?? "Echoes from the executor MCP test server",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: options.text ?? "mcp-ok" }],
    }),
  );

  return server;
};

export const TEST_IMAGE_MIME_TYPE = "image/png";
export const TEST_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8N1wwAAAABJRU5ErkJggg==";

const testImageMetadata = () => ({
  name: "mcp-image-fixture.png",
  mimeType: TEST_IMAGE_MIME_TYPE,
  byteLength: Buffer.from(TEST_IMAGE_PNG_BASE64, "base64").byteLength,
});

export const makeImageMcpServer = () => {
  const server = new McpServer(
    { name: "image-test-server", version: "1.0.0" },
    { capabilities: {} },
  );

  server.registerTool(
    "image_fixture",
    {
      description: "Returns a deterministic PNG as MCP image content",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "image" as const,
          data: TEST_IMAGE_PNG_BASE64,
          mimeType: TEST_IMAGE_MIME_TYPE,
        },
      ],
      structuredContent: testImageMetadata(),
    }),
  );

  server.registerTool(
    "image_fixture_with_metadata",
    {
      description: "Returns text metadata followed by MCP image content",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: "Deterministic image fixture: mcp-image-fixture.png (image/png, 70 bytes)",
        },
        {
          type: "image" as const,
          data: TEST_IMAGE_PNG_BASE64,
          mimeType: TEST_IMAGE_MIME_TYPE,
        },
      ],
      structuredContent: testImageMetadata(),
    }),
  );

  return server;
};

export const makeEchoMcpServer = (
  options: {
    readonly name?: string;
    readonly version?: string;
    readonly toolName?: string;
    readonly toolDescription?: string;
    readonly inputName?: "name" | "value" | "marker";
    readonly text?: (value: string) => string;
  } = {},
) => {
  const inputName = options.inputName ?? "value";
  const server = new McpServer(
    {
      name: options.name ?? "executor-echo-mcp",
      version: options.version ?? "1.0.0",
    },
    { capabilities: {} },
  );

  server.registerTool(
    options.toolName ?? "echo",
    {
      description: options.toolDescription ?? "Echoes a string value",
      inputSchema: { [inputName]: z.string() },
    },
    async (input) => ({
      content: [
        {
          type: "text" as const,
          text: options.text ? options.text(input[inputName]) : input[inputName],
        },
      ],
    }),
  );

  return server;
};

export const makeElicitationMcpServer = () => {
  const server = new McpServer(
    { name: "elicitation-test-server", version: "1.0.0" },
    { capabilities: {} },
  );

  server.registerTool(
    "gated_echo",
    {
      description: "Asks for approval before echoing a value",
      inputSchema: { value: z.string() },
    },
    async ({ value }: { value: string }) => {
      const response = await server.server.elicitInput({
        mode: "form",
        message: `Approve echo for "${value}"?`,
        requestedSchema: {
          type: "object",
          properties: {
            approved: { type: "boolean", title: "Approve" },
          },
          required: ["approved"],
        },
      });

      if (response.action !== "accept" || !response.content || response.content.approved !== true) {
        return {
          content: [{ type: "text" as const, text: `denied:${value}` }],
        };
      }

      return {
        content: [{ type: "text" as const, text: `approved:${value}` }],
      };
    },
  );

  server.registerTool(
    "simple_echo",
    {
      description: "Echoes a value without elicitation",
      inputSchema: { value: z.string() },
    },
    async ({ value }: { value: string }) => ({
      content: [{ type: "text" as const, text: value }],
    }),
  );

  server.registerTool(
    "structured_echo",
    {
      description: "Returns text plus structured data",
      inputSchema: { value: z.string() },
      outputSchema: {
        value: z.string(),
        upper: z.string(),
      },
    },
    async ({ value }: { value: string }) => ({
      content: [{ type: "text" as const, text: value }],
      structuredContent: { value, upper: value.toUpperCase() },
      _meta: { trace: "kept" },
    }),
  );

  return server;
};

export const makeAnnotationsMcpServer = () => {
  const server = new McpServer(
    { name: "annotations-test-server", version: "1.0.0" },
    { capabilities: {} },
  );

  server.registerTool(
    "delete",
    {
      description: "A destructive tool",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    async () => ({ content: [] }),
  );

  server.registerTool(
    "delete_titled",
    {
      description: "A destructive tool with a title annotation",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true, title: "Delete dataset" },
    },
    async () => ({ content: [] }),
  );

  server.registerTool(
    "list",
    {
      description: "A read-only tool",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [] }),
  );

  server.registerTool(
    "ping",
    { description: "An unannotated tool", inputSchema: {} },
    async () => ({ content: [] }),
  );

  return server;
};
