import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { FormElicitation, ToolId, createExecutor, definePlugin, tool } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import {
  createExecutionEngine,
  type ExecutionEngine,
  type ExecutionResult,
} from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { dynamicUiPlugin } from "@executor-js/plugin-dynamic-ui";
import { chromium, type Browser, type Frame, type Page } from "playwright-core";
import { createServer as createViteServer } from "vite";
import type * as Cause from "effect/Cause";

import { createExecutorMcpServer } from "@executor-js/host-mcp";

type ShellServer = {
  readonly url: string;
  readonly close: () => Promise<void>;
};

type HostServer = ShellServer;

type OpenApiServer = {
  readonly specUrl: string;
  readonly postRequests: string[];
  readonly close: () => Promise<void>;
};

type McpHarness = {
  readonly callTool: (params: HostToolCall) => Promise<unknown>;
  readonly close: () => Promise<void>;
};

type HostToolCall = {
  readonly name?: string;
  readonly arguments?: Record<string, unknown>;
};

type HostState = {
  readonly initialized: boolean;
  readonly toolCalls: HostToolCall[];
  readonly resumeCalls: HostToolCall[];
};

type BrowserHostWindow = Window & {
  __mcpHostState: HostState;
  __sendGeneratedUi: (code: string) => void;
};

type AppsClientCapabilities = ClientCapabilities & {
  readonly extensions: Record<string, unknown>;
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const chromeExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/google-chrome";
const formToolId = ToolId.make("test.form");

const EmptySchema = Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(Schema.Struct({})));
const CreateItemSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(
    Schema.Struct({
      body: Schema.Struct({ name: Schema.String }),
    }),
  ),
);
const DomainSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({ domain: Schema.String })),
);
const UpdateAutoRenewSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(
    Schema.Struct({
      domain: Schema.String,
      body: Schema.Struct({ autoRenew: Schema.Boolean }),
    }),
  ),
);

const inventoryPlugin = (postRequests: string[]) =>
  definePlugin(() => ({
    id: "inventory-test" as const,
    storage: () => ({}),
    staticSources: () => {
      let autoRenew = false;
      return [
        {
          id: "inventory.items",
          kind: "in-memory",
          name: "Inventory Items",
          tools: [
            tool({
              name: "listItems",
              description: "List inventory items",
              inputSchema: EmptySchema,
              execute: () => Effect.succeed([{ name: "Widget" }]),
            }),
            tool({
              name: "createItem",
              description: "Create an inventory item",
              annotations: { requiresApproval: true } as const,
              inputSchema: CreateItemSchema,
              execute: (args) =>
                Effect.sync(() => {
                  postRequests.push(JSON.stringify({ name: args.body.name }));
                  return { name: args.body.name, created: true };
                }),
            }),
          ],
        },
        {
          id: "inventory.domains",
          kind: "in-memory",
          name: "Inventory Domains",
          tools: [
            tool({
              name: "getDomain",
              description: "Get domain settings",
              inputSchema: DomainSchema,
              execute: (args) => Effect.succeed({ domain: args.domain, renew: autoRenew }),
            }),
            tool({
              name: "updateDomainAutoRenew",
              description: "Update domain auto-renew",
              annotations: { requiresApproval: true } as const,
              inputSchema: UpdateAutoRenewSchema,
              execute: (args) =>
                Effect.sync(() => {
                  autoRenew = args.body.autoRenew;
                  postRequests.push(JSON.stringify({ autoRenew }));
                  return { domain: args.domain, renew: autoRenew };
                }),
            }),
          ],
        },
      ];
    },
  }))();

const appsWithoutElicitationCapabilities: AppsClientCapabilities = {
  extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
};

const networkPrimitives = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Worker",
  "SharedWorker",
] as const;

const generatedDataCode = `
const primitiveNames = ${JSON.stringify(networkPrimitives)};
const blockedMessages = primitiveNames.map((name) => {
  try {
    globalThis[name]("https://example.com/should-not-load");
    return name + ":allowed";
  } catch (err) {
    return name + ":" + (err instanceof Error ? err.message : String(err));
  }
});

function App() {
  const { data, error, isLoading } = useQuery(() => tools.inventory.items.listItems({}));
  const items = data?.ok ? data.data : data;
  return (
    <Card>
      <CardContent>
        <div id="status">{isLoading ? "loading" : error ? error.message : items?.[0]?.name}</div>
        <pre id="blocked">{blockedMessages.join("\\n")}</pre>
      </CardContent>
    </Card>
  );
}
`;

const generatedStaticCode = `
function App() {
  return (
    <Card>
      <CardContent>
        <div id="ready">ready</div>
      </CardContent>
    </Card>
  );
}
`;

const generatedApprovalCode = `
function App() {
  const [status, setStatus] = useState("idle");
  const createItem = useMutation((input) => tools.inventory.items.createItem(input), {
    onSuccess: (result) => {
      const created = result?.ok ? result.data : result;
      setStatus(created.name + ":" + created.created);
    },
    onError: (error) => setStatus(error.message),
  });
  const ask = async () => {
    setStatus("pending");
    await createItem.mutateAsync({ body: { name: "Approved Widget" } });
  };

  return (
    <Card>
      <CardContent>
        <Button id="ask" onClick={ask}>Ask</Button>
        <div id="mutation-pending">{String(createItem.isPending)}</div>
        <div id="approval-status">{status}</div>
      </CardContent>
    </Card>
  );
}
`;

const generatedAutoMutationCode = `
function App() {
  const [status, setStatus] = useState("idle");
  const createItem = useMutation((input) => tools.inventory.items.createItem(input), {
    onSuccess: (result) => {
      const created = result?.ok ? result.data : result;
      setStatus(created.name + ":" + created.created);
    },
    onError: (error) => setStatus(error.message),
  });

  useEffect(() => {
    createItem.mutate({ body: { name: "Mount Widget" } });
  }, []);

  return (
    <Card>
      <CardContent>
        <div id="auto-mutation-status">{status}</div>
      </CardContent>
    </Card>
  );
}
`;

const generatedEscapeAttemptCode = `
const escapeResults = [];

try {
  escapeResults.push("popup:" + String(window.open("https://example.com/popup") === null));
} catch (err) {
  escapeResults.push("popup:" + (err instanceof Error ? err.name : String(err)));
}

try {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "https://example.com/form";
  form.target = "_blank";
  document.body.appendChild(form);
  form.submit();
  escapeResults.push("form:submitted");
} catch (err) {
  escapeResults.push("form:" + (err instanceof Error ? err.name : String(err)));
}

try {
  const frame = document.createElement("iframe");
  frame.src = "https://example.com/frame";
  document.body.appendChild(frame);
  escapeResults.push("iframe:" + String(frame.contentWindow === null));
} catch (err) {
  escapeResults.push("iframe:" + (err instanceof Error ? err.name : String(err)));
}

function App() {
  return (
    <Card>
      <CardContent>
        <pre id="escape-results">{escapeResults.join("\\n")}</pre>
      </CardContent>
    </Card>
  );
}
`;

const generatedSchemaApprovalCode = `
function App() {
  const [status, setStatus] = useState("idle");
  const requestDetails = useMutation((input) => tools.profile.submit(input), {
    onSuccess: (result) => {
      setStatus(JSON.stringify(result));
    },
    onError: (error) => setStatus(error.message),
  });

  return (
    <Card>
      <CardContent>
        <Button id="ask-schema" onClick={() => requestDetails.mutate({})}>Ask for details</Button>
        <div id="schema-status">{status}</div>
      </CardContent>
    </Card>
  );
}
`;

const generatedTanstackQueryCode = `
function App() {
  const queryClient = useQueryClient();
  const domainArgs = { domain: "openexecutor.com" };
  const domainQuery = useQuery(tools.inventory.domains.getDomain.queryOptions(domainArgs));
  const updateAutoRenew = useMutation(
    tools.inventory.domains.updateDomainAutoRenew.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: tools.inventory.domains.getDomain.queryKey(domainArgs),
        });
      },
    })
  );

  const domain = domainQuery.data?.ok ? domainQuery.data.data : domainQuery.data;
  const autoRenew = domain?.renew ?? false;

  return (
    <Card>
      <CardContent>
        <div id="auto-renew-state">
          {domainQuery.isLoading ? "loading" : String(autoRenew)}
        </div>
        <div id="auto-renew-pending">{String(updateAutoRenew.isPending)}</div>
        <div id="auto-renew-success">
          {updateAutoRenew.isSuccess
            ? "Auto-renew " + (autoRenew ? "enabled" : "disabled") + " successfully"
            : ""}
        </div>
        <Button
          id="auto-renew-toggle"
          disabled={domainQuery.isLoading || updateAutoRenew.isPending}
          onClick={() =>
            updateAutoRenew.mutate({
              domain: "openexecutor.com",
              body: { autoRenew: !autoRenew },
            })
          }
        >
          Toggle
        </Button>
      </CardContent>
    </Card>
  );
}
`;

const createHostHtml = (shellUrl: string) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>MCP Apps Browser Harness</title>
  </head>
  <body>
    <iframe
      id="app"
      src="${shellUrl}/mcp-app.html"
      style="width: 1000px; height: 900px; border: 0"
    ></iframe>
    <script>
      const appFrame = document.getElementById("app");
      const state = {
        initialized: false,
        toolCalls: [],
        resumeCalls: [],
      };
      window.__mcpHostState = state;

      const sendToApp = (message) => {
        appFrame.contentWindow.postMessage(message, "*");
      };

      const respond = (source, id, result) => {
        source.postMessage({ jsonrpc: "2.0", id, result }, "*");
      };

      window.__sendGeneratedUi = (code) => {
        sendToApp({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            content: [{ type: "text", text: "" }],
            structuredContent: { code },
          },
        });
      };

      window.addEventListener("message", (event) => {
        if (event.source !== appFrame.contentWindow) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;

        if (message.method === "ui/initialize" && message.id !== undefined) {
          respond(event.source, message.id, {
            protocolVersion: message.params?.protocolVersion ?? "2026-01-26",
            hostInfo: { name: "Browser Harness", version: "1.0.0" },
            hostCapabilities: {
              openLinks: {},
              serverTools: { listChanged: true },
            },
            hostContext: {
              theme: "light",
              displayMode: "inline",
              platform: "web",
            },
          });
          return;
        }

        if (message.method === "ui/notifications/initialized") {
          state.initialized = true;
          return;
        }

        if (message.method === "tools/call" && message.id !== undefined) {
          const params = message.params ?? {};
          state.toolCalls.push(params);

          if (params.name === "execute-action-resume") {
            state.resumeCalls.push(params);
          }

          fetch("/tools/call", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(params),
          })
            .then((response) => response.json())
            .then((result) => respond(event.source, message.id, result))
            .catch((err) =>
              event.source.postMessage(
                {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
                },
                "*",
              ),
            );
        }
      });
    </script>
  </body>
</html>`;

const startShellServer = async (): Promise<ShellServer> => {
  const server = await createViteServer({
    configFile: resolve(packageRoot, "vite.config.shell.ts"),
    clearScreen: false,
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
    },
  });

  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) {
    throw new Error("Vite did not report a local shell URL.");
  }

  return {
    url: url.replace(/\/$/, ""),
    close: () => server.close(),
  };
};

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });

const startOpenApiServer = (): Promise<OpenApiServer> =>
  new Promise((resolveServer, rejectServer) => {
    let baseUrl = "";
    let domainAutoRenew = false;
    let nextDomainGetDelayMs = 0;
    const postRequests: string[] = [];

    const server: Server = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/openapi.json") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            openapi: "3.0.0",
            info: { title: "Inventory", version: "1.0.0" },
            servers: [{ url: baseUrl }],
            paths: {
              "/items": {
                get: {
                  operationId: "listItems",
                  responses: {
                    "200": {
                      description: "Inventory items",
                      content: {
                        "application/json": {
                          schema: {
                            type: "array",
                            items: { $ref: "#/components/schemas/Item" },
                          },
                        },
                      },
                    },
                  },
                },
                post: {
                  operationId: "createItem",
                  requestBody: {
                    required: true,
                    content: {
                      "application/json": {
                        schema: { $ref: "#/components/schemas/CreateItem" },
                      },
                    },
                  },
                  responses: {
                    "200": {
                      description: "Created item",
                      content: {
                        "application/json": {
                          schema: { $ref: "#/components/schemas/CreatedItem" },
                        },
                      },
                    },
                  },
                },
              },
              "/domains/{domain}": {
                get: {
                  operationId: "getDomain",
                  parameters: [
                    {
                      name: "domain",
                      in: "path",
                      required: true,
                      schema: { type: "string" },
                    },
                  ],
                  responses: {
                    "200": {
                      description: "Domain",
                      content: {
                        "application/json": {
                          schema: { $ref: "#/components/schemas/Domain" },
                        },
                      },
                    },
                  },
                },
              },
              "/domains/{domain}/auto-renew": {
                post: {
                  operationId: "updateDomainAutoRenew",
                  parameters: [
                    {
                      name: "domain",
                      in: "path",
                      required: true,
                      schema: { type: "string" },
                    },
                  ],
                  requestBody: {
                    required: true,
                    content: {
                      "application/json": {
                        schema: { $ref: "#/components/schemas/AutoRenewInput" },
                      },
                    },
                  },
                  responses: {
                    "200": {
                      description: "Updated domain",
                      content: {
                        "application/json": {
                          schema: { $ref: "#/components/schemas/Domain" },
                        },
                      },
                    },
                  },
                },
              },
            },
            components: {
              schemas: {
                AutoRenewInput: {
                  type: "object",
                  required: ["autoRenew"],
                  properties: {
                    autoRenew: { type: "boolean" },
                  },
                },
                Domain: {
                  type: "object",
                  required: ["domain", "renew"],
                  properties: {
                    domain: { type: "string" },
                    renew: { type: "boolean" },
                  },
                },
                Item: {
                  type: "object",
                  required: ["id", "name"],
                  properties: {
                    id: { type: "integer" },
                    name: { type: "string" },
                  },
                },
                CreateItem: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string" },
                  },
                },
                CreatedItem: {
                  type: "object",
                  required: ["id", "name", "created"],
                  properties: {
                    id: { type: "integer" },
                    name: { type: "string" },
                    created: { type: "boolean" },
                  },
                },
              },
            },
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/items") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify([{ id: 1, name: "Seed Widget" }]));
        return;
      }

      if (request.method === "GET" && request.url?.startsWith("/domains/")) {
        const domain = decodeURIComponent(request.url.slice("/domains/".length));
        if (!domain.includes("/")) {
          const delayMs = nextDomainGetDelayMs;
          nextDomainGetDelayMs = 0;
          if (delayMs > 0) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
          }
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ domain, renew: domainAutoRenew }));
          return;
        }
      }

      if (request.method === "POST" && request.url === "/items") {
        const body = await readBody(request);
        postRequests.push(body);
        const parsed = JSON.parse(body) as { name?: unknown };
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: 2,
            name: typeof parsed.name === "string" ? parsed.name : "Unnamed",
            created: true,
          }),
        );
        return;
      }

      if (
        request.method === "POST" &&
        request.url?.startsWith("/domains/") &&
        request.url.endsWith("/auto-renew")
      ) {
        const body = await readBody(request);
        postRequests.push(body);
        const parsed = JSON.parse(body) as { autoRenew?: unknown };
        domainAutoRenew = parsed.autoRenew === true;
        nextDomainGetDelayMs = 300;
        const domainPath = request.url.slice(
          "/domains/".length,
          request.url.length - "/auto-renew".length,
        );
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            domain: decodeURIComponent(domainPath),
            renew: domainAutoRenew,
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end("not found");
    });

    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectServer);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectServer(new Error("Failed to resolve OpenAPI server address."));
        return;
      }

      const { port } = address as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolveServer({
        specUrl: `${baseUrl}/openapi.json`,
        postRequests,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });

const makePausedResult = (
  id: string,
  request: ReturnType<typeof FormElicitation.make>,
): ExecutionResult => ({
  status: "paused",
  execution: { id, elicitationContext: { toolId: formToolId, args: {}, request } },
});

const startMcpHarnessForEngine = async <E extends Cause.YieldableError>(
  engine: ExecutionEngine<E>,
): Promise<McpHarness> => {
  const mcpServer = await Effect.runPromise(
    createExecutorMcpServer({ engine, plugins: [dynamicUiPlugin()] }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "browser-harness", version: "1.0.0" },
    { capabilities: appsWithoutElicitationCapabilities },
  );

  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    callTool: async (params) => {
      if (!params.name) {
        throw new Error("Missing MCP tool name.");
      }
      return client.callTool({
        name: params.name,
        arguments: params.arguments ?? {},
      });
    },
    close: async () => {
      await clientTransport.close();
      await serverTransport.close();
    },
  };
};

const startMcpHarness = async (openApi: OpenApiServer): Promise<McpHarness> => {
  const executor = await Effect.runPromise(
    createExecutor(makeTestConfig({ plugins: [inventoryPlugin(openApi.postRequests)] })),
  );

  const engine = createExecutionEngine({
    executor,
    codeExecutor: makeQuickJsExecutor({
      timeoutMs: 5_000,
      memoryLimitBytes: 32 * 1024 * 1024,
    }),
  });

  return startMcpHarnessForEngine(engine);
};

const startSchemaElicitationMcpHarness = (): Promise<McpHarness> =>
  startMcpHarnessForEngine({
    getDescription: Effect.succeed("schema elicitation test executor"),
    execute: () => Effect.succeed({ result: null }),
    executeWithPause: () =>
      Effect.succeed(
        makePausedResult(
          "schema_exec",
          FormElicitation.make({
            message: "Provide approval details",
            requestedSchema: {
              type: "object",
              required: ["name", "count", "priority", "tags"],
              properties: {
                name: {
                  type: "string",
                  title: "Display name",
                  minLength: 2,
                  description: "Human-readable name to submit.",
                },
                count: {
                  type: "integer",
                  title: "Count",
                  minimum: 1,
                  default: 2,
                },
                priority: {
                  type: "string",
                  title: "Priority",
                  enum: ["low", "high"],
                  enumNames: ["Low", "High"],
                },
                notify: {
                  type: "boolean",
                  title: "Notify",
                  default: false,
                },
                tags: {
                  type: "array",
                  title: "Tags",
                  minItems: 1,
                  items: {
                    enum: ["alpha", "beta"],
                    enumNames: ["Alpha", "Beta"],
                  },
                },
              },
            },
          }),
        ),
      ),
    getPausedExecution: () => Effect.succeed(null),
    resume: (_executionId, response) =>
      Effect.succeed({
        status: "completed",
        result: { result: response.content ?? {} },
      }),
  });

const startHostServer = (shellUrl: string, mcp: McpHarness): Promise<HostServer> =>
  new Promise((resolveServer, rejectServer) => {
    const html = createHostHtml(shellUrl);
    const server: Server = createServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/tools/call") {
        try {
          const body = await readBody(request);
          const params = JSON.parse(body) as HostToolCall;
          const result = await mcp.callTool(params);
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(result));
        } catch (err) {
          response.statusCode = 500;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              content: [
                {
                  type: "text",
                  text: err instanceof Error ? err.message : String(err),
                },
              ],
              isError: true,
            }),
          );
        }
        return;
      }

      if (request.method !== "GET" || request.url !== "/") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }

      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(html);
    });

    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectServer);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectServer(new Error("Failed to resolve host server address."));
        return;
      }

      const { port } = address as AddressInfo;
      resolveServer({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });

const waitForValue = async <T>(
  page: Page,
  read: () => T | undefined,
  label: string,
): Promise<T> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const waitForShellFrame = (page: Page): Promise<Frame> =>
  waitForValue(
    page,
    () => page.frames().find((frame) => frame.url().includes("/mcp-app.html")),
    "MCP app shell iframe",
  );

const waitForInnerFrame = async (page: Page, shellFrame: Frame): Promise<Frame> => {
  const locator = shellFrame.locator('iframe[title="Generated UI"]');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const handle = await locator.elementHandle();
    const frame = await handle?.contentFrame();
    await handle?.dispose();
    if (frame) return frame;
    await page.waitForTimeout(50);
  }
  throw new Error("Timed out waiting for generated UI iframe.");
};

const waitForHostInitialized = (page: Page) =>
  page.waitForFunction(() =>
    Boolean((window as unknown as BrowserHostWindow).__mcpHostState.initialized),
  );

const getHostState = (page: Page): Promise<HostState> =>
  page.evaluate(() => (window as unknown as BrowserHostWindow).__mcpHostState);

const openHarness = async (browser: Browser, hostUrl: string) => {
  const page = await browser.newPage();
  await page.goto(hostUrl, { waitUntil: "domcontentloaded" });
  const shellFrame = await waitForShellFrame(page);
  await waitForHostInitialized(page);
  await shellFrame.locator('[data-testid="shell-loading-state"]').waitFor({ timeout: 10_000 });
  return { page, shellFrame };
};

const renderGeneratedUi = async (page: Page, shellFrame: Frame, code: string): Promise<Frame> => {
  await page.evaluate(
    (value) => (window as unknown as BrowserHostWindow).__sendGeneratedUi(value),
    code,
  );
  await shellFrame.locator('iframe[title="Generated UI"]').waitFor({ timeout: 10_000 });
  return waitForInnerFrame(page, shellFrame);
};

describe("MCP app generated UI browser isolation", () => {
  let openApiServer: OpenApiServer | undefined;
  let mcpHarness: McpHarness | undefined;
  let shellServer: ShellServer | undefined;
  let hostServer: HostServer | undefined;
  let browser: Browser | undefined;

  beforeAll(async () => {
    openApiServer = await startOpenApiServer();
    mcpHarness = await startMcpHarness(openApiServer);
    shellServer = await startShellServer();
    hostServer = await startHostServer(shellServer.url, mcpHarness);
    browser = await chromium.launch({
      executablePath: chromeExecutablePath,
      headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
      slowMo: process.env.PLAYWRIGHT_SLOWMO ? Number(process.env.PLAYWRIGHT_SLOWMO) : undefined,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await hostServer?.close();
    await shellServer?.close();
    await mcpHarness?.close();
    await openApiServer?.close();
  }, 30_000);

  it("runs generated UI in a sandboxed browser iframe and proxies live tool calls", async () => {
    if (!browser || !hostServer) throw new Error("Browser harness did not start.");
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedDataCode);
      await innerFrame.waitForFunction(
        () => document.querySelector("#status")?.textContent === "Widget",
        undefined,
        { timeout: 10_000 },
      );

      const rendererAttributes = await shellFrame
        .locator('iframe[title="Generated UI"]')
        .evaluate((element) => ({
          sandbox: element.getAttribute("sandbox"),
          srcDoc: element.getAttribute("srcdoc") ?? "",
        }));

      expect(rendererAttributes.sandbox).toBe("allow-scripts");
      expect(rendererAttributes.srcDoc).toContain('meta name="executor-render-token"');
      expect(rendererAttributes.srcDoc).toContain("default-src 'none'");
      expect(rendererAttributes.srcDoc).toContain("connect-src 'none'");
      expect(rendererAttributes.srcDoc).toContain("form-action 'none'");
      expect(rendererAttributes.srcDoc).toContain("frame-src 'none'");
      expect(rendererAttributes.srcDoc).toContain("worker-src 'none'");

      const parentAccess = await innerFrame.evaluate(() => {
        try {
          void window.parent.document.body;
          return "allowed";
        } catch (err) {
          return err instanceof DOMException ? err.name : String(err);
        }
      });
      expect(parentAccess).toBe("SecurityError");

      const blockedText = (await innerFrame.locator("#blocked").textContent()) ?? "";
      for (const name of networkPrimitives) {
        expect(blockedText).toContain(
          `${name} is disabled in generated UI. Use tools.* via useQuery/useMutation.`,
        );
      }

      const hostState = await getHostState(page);
      expect(hostState.toolCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "execute-action",
            arguments: {
              code: "return await tools.inventory.items.listItems({})",
            },
          }),
        ]),
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  it("blocks popup, form, and nested-frame escape attempts from generated UI", async () => {
    if (!browser || !hostServer) throw new Error("Browser harness did not start.");
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedEscapeAttemptCode);
      await innerFrame.locator("#escape-results").waitFor({ timeout: 10_000 });

      const escapeText = (await innerFrame.locator("#escape-results").textContent()) ?? "";
      expect(escapeText).toContain("popup:true");
      expect(escapeText).toContain("form:");
      expect(escapeText).toContain("iframe:");

      const pages = browser.contexts().flatMap((context) => context.pages());
      expect(pages).toHaveLength(1);

      const hostState = await getHostState(page);
      expect(hostState.toolCalls).toHaveLength(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("rejects spoofed renderer messages unless the iframe window and token match", async () => {
    if (!browser || !hostServer) throw new Error("Browser harness did not start.");
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedStaticCode);
      await innerFrame.locator("#ready").waitFor({ timeout: 10_000 });

      await shellFrame.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Generated UI"]');
        const srcDoc = iframe?.getAttribute("srcdoc") ?? "";
        const token = /<meta name="executor-render-token" content="([^"]+)">/.exec(srcDoc)?.[1];
        if (!iframe?.contentWindow || !token) {
          throw new Error("Generated UI iframe is missing a token.");
        }

        window.dispatchEvent(
          new MessageEvent("message", {
            source: window,
            data: { type: "executor.run", requestId: 1, token, code: "return 42" },
          }),
        );
        window.dispatchEvent(
          new MessageEvent("message", {
            source: iframe.contentWindow,
            data: { type: "executor.run", requestId: 2, token: "wrong", code: "return 42" },
          }),
        );
      });

      await page.waitForTimeout(100);
      expect((await getHostState(page)).toolCalls).toHaveLength(0);

      await shellFrame.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Generated UI"]');
        const srcDoc = iframe?.getAttribute("srcdoc") ?? "";
        const token = /<meta name="executor-render-token" content="([^"]+)">/.exec(srcDoc)?.[1];
        if (!iframe?.contentWindow || !token) {
          throw new Error("Generated UI iframe is missing a token.");
        }

        window.dispatchEvent(
          new MessageEvent("message", {
            source: iframe.contentWindow,
            data: { type: "executor.run", requestId: 3, token, code: "return 42" },
          }),
        );
      });

      await page.waitForFunction(
        () => (window as unknown as BrowserHostWindow).__mcpHostState.toolCalls.length === 1,
      );
      expect((await getHostState(page)).toolCalls[0]).toEqual(
        expect.objectContaining({
          name: "execute-action",
          arguments: { code: "return 42" },
        }),
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  it("handles elicitations in the trusted shell instead of the generated iframe", async () => {
    if (!browser || !hostServer || !openApiServer) {
      throw new Error("Browser harness did not start.");
    }
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedApprovalCode);
      await innerFrame.locator("#ask").waitFor({ timeout: 10_000 });
      await innerFrame.locator("#ask").click({ timeout: 10_000 });

      await shellFrame.locator("text=Approve action").waitFor({ timeout: 10_000 });
      expect(await innerFrame.locator("text=Approve action").count()).toBe(0);
      expect(await shellFrame.locator('[data-testid="trusted-interaction-fields"]').count()).toBe(
        0,
      );
      expect(await shellFrame.locator("text=Response content").count()).toBe(0);
      expect(openApiServer.postRequests).toHaveLength(0);

      await shellFrame.getByRole("button", { name: "Approve" }).click({ timeout: 10_000 });
      await innerFrame.waitForFunction(
        () => document.querySelector("#approval-status")?.textContent === "Approved Widget:true",
        undefined,
        { timeout: 10_000 },
      );
      expect(openApiServer.postRequests).toEqual([JSON.stringify({ name: "Approved Widget" })]);

      const hostState = await getHostState(page);
      expect(hostState.resumeCalls).toEqual([
        expect.objectContaining({
          name: "execute-action-resume",
          arguments: {
            executionId: expect.any(String),
            action: "accept",
            content: "{}",
          },
        }),
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("resumes declined and canceled approvals without performing the mutation", async () => {
    if (!browser || !hostServer || !openApiServer) {
      throw new Error("Browser harness did not start.");
    }

    for (const action of ["Decline", "Cancel"] as const) {
      const { page, shellFrame } = await openHarness(browser, hostServer.url);
      const initialPostCount = openApiServer.postRequests.length;

      try {
        const innerFrame = await renderGeneratedUi(page, shellFrame, generatedApprovalCode);
        await innerFrame.locator("#ask").click({ timeout: 10_000 });
        await shellFrame.locator("text=Approve action").waitFor({ timeout: 10_000 });

        await shellFrame.getByRole("button", { name: action }).click({ timeout: 10_000 });
        await page.waitForFunction(
          () => (window as unknown as BrowserHostWindow).__mcpHostState.resumeCalls.length === 1,
          undefined,
          { timeout: 10_000 },
        );

        expect(openApiServer.postRequests).toHaveLength(initialPostCount);
        const hostState = await getHostState(page);
        expect(hostState.resumeCalls).toEqual([
          expect.objectContaining({
            name: "execute-action-resume",
            arguments: {
              executionId: expect.any(String),
              action: action === "Decline" ? "decline" : "cancel",
              content: "{}",
            },
          }),
        ]);
      } finally {
        await page.close();
      }
    }
  }, 30_000);

  it("blocks generated UI mutations that run on mount until trusted approval", async () => {
    if (!browser || !hostServer || !openApiServer) {
      throw new Error("Browser harness did not start.");
    }
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const initialPostCount = openApiServer.postRequests.length;
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedAutoMutationCode);
      await innerFrame.locator("#auto-mutation-status").waitFor({ timeout: 10_000 });
      await shellFrame.locator("text=Approve action").waitFor({ timeout: 10_000 });

      expect(openApiServer.postRequests).toHaveLength(initialPostCount);
      const hostStateBeforeApproval = await getHostState(page);
      expect(hostStateBeforeApproval.toolCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "execute-action",
            arguments: {
              code: 'return await tools.inventory.items.createItem({"body":{"name":"Mount Widget"}})',
            },
          }),
        ]),
      );

      await shellFrame.getByRole("button", { name: "Approve" }).click({ timeout: 10_000 });
      await innerFrame.waitForFunction(
        () => document.querySelector("#auto-mutation-status")?.textContent === "Mount Widget:true",
        undefined,
        { timeout: 10_000 },
      );
      expect(openApiServer.postRequests).toHaveLength(initialPostCount + 1);
      expect(openApiServer.postRequests.at(-1)).toBe(JSON.stringify({ name: "Mount Widget" }));
    } finally {
      await page.close();
    }
  }, 30_000);

  it("updates live query state after an approved TanStack Query mutation", async () => {
    if (!browser || !hostServer || !openApiServer) {
      throw new Error("Browser harness did not start.");
    }
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const initialPostCount = openApiServer.postRequests.length;
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedTanstackQueryCode);
      await innerFrame.waitForFunction(
        () => document.querySelector("#auto-renew-state")?.textContent === "false",
        undefined,
        { timeout: 10_000 },
      );

      await innerFrame.locator("#auto-renew-toggle").click({ timeout: 10_000 });
      await shellFrame.locator("text=Approve action").waitFor({ timeout: 10_000 });
      expect(openApiServer.postRequests).toHaveLength(initialPostCount);

      await shellFrame.getByRole("button", { name: "Approve" }).click({ timeout: 10_000 });

      await innerFrame.waitForFunction(
        () => document.querySelector("#auto-renew-state")?.textContent === "true",
        undefined,
        { timeout: 10_000 },
      );
      await innerFrame.waitForFunction(
        () =>
          document.querySelector("#auto-renew-success")?.textContent ===
          "Auto-renew enabled successfully",
        undefined,
        { timeout: 10_000 },
      );

      expect(openApiServer.postRequests).toHaveLength(initialPostCount + 1);
      expect(openApiServer.postRequests.at(-1)).toBe(JSON.stringify({ autoRenew: true }));

      const hostState = await getHostState(page);
      expect(hostState.toolCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "execute-action",
            arguments: {
              code: 'return await tools.inventory.domains.getDomain({"domain":"openexecutor.com"})',
            },
          }),
          expect.objectContaining({
            name: "execute-action",
            arguments: {
              code: 'return await tools.inventory.domains.updateDomainAutoRenew({"domain":"openexecutor.com","body":{"autoRenew":true}})',
            },
          }),
        ]),
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  it("renders form elicitations as typed approval fields", async () => {
    if (!browser || !shellServer) {
      throw new Error("Browser harness did not start.");
    }

    const schemaMcpHarness = await startSchemaElicitationMcpHarness();
    const schemaHostServer = await startHostServer(shellServer.url, schemaMcpHarness);
    const { page, shellFrame } = await openHarness(browser, schemaHostServer.url);

    try {
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedSchemaApprovalCode);
      await innerFrame.locator("#ask-schema").click({ timeout: 10_000 });
      await shellFrame.locator("text=Provide approval details").waitFor({ timeout: 10_000 });

      await shellFrame.getByLabel("Display name").fill("Rhea");
      await shellFrame.getByLabel("Count").fill("3");
      await shellFrame.getByLabel("Priority").selectOption("high");
      await shellFrame.getByLabel("Notify").click();
      await shellFrame.getByLabel("Beta").click();
      await shellFrame.getByRole("button", { name: "Approve" }).click({ timeout: 10_000 });

      await innerFrame.waitForFunction(
        () =>
          document.querySelector("#schema-status")?.textContent ===
          JSON.stringify({
            name: "Rhea",
            count: 3,
            priority: "high",
            notify: true,
            tags: ["beta"],
          }),
        undefined,
        { timeout: 10_000 },
      );

      const hostState = await getHostState(page);
      expect(hostState.resumeCalls).toEqual([
        expect.objectContaining({
          name: "execute-action-resume",
          arguments: {
            executionId: "schema_exec",
            action: "accept",
            content: JSON.stringify({
              name: "Rhea",
              count: 3,
              priority: "high",
              notify: true,
              tags: ["beta"],
            }),
          },
        }),
      ]);
    } finally {
      await page.close();
      await schemaHostServer.close();
      await schemaMcpHarness.close();
    }
  }, 30_000);

  it("keeps trusted approval controls visible in a short host iframe", async () => {
    if (!browser || !hostServer) {
      throw new Error("Browser harness did not start.");
    }
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      await page.evaluate(() => {
        const appFrame = document.getElementById("app") as HTMLIFrameElement | null;
        if (!appFrame) throw new Error("Missing app iframe.");
        appFrame.style.height = "180px";
      });
      await shellFrame.waitForFunction(() => document.documentElement.clientHeight <= 180);

      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedApprovalCode);
      await innerFrame.locator("#ask").click({ timeout: 10_000 });
      await shellFrame.locator("text=Approve action").waitFor({ timeout: 10_000 });

      const metrics = await shellFrame
        .locator('[data-testid="trusted-interaction-modal"]')
        .evaluate((modal) => {
          const card = modal.querySelector<HTMLElement>('[data-testid="trusted-interaction-card"]');
          const body = modal.querySelector<HTMLElement>('[data-testid="trusted-interaction-body"]');
          const footer = modal.querySelector<HTMLElement>(
            '[data-testid="trusted-interaction-footer"]',
          );
          if (!card || !body || !footer) throw new Error("Missing trusted modal element.");

          const cardRect = card.getBoundingClientRect();
          const footerRect = footer.getBoundingClientRect();
          return {
            bodyOverflowY: getComputedStyle(body).overflowY,
            cardBottom: cardRect.bottom,
            cardTop: cardRect.top,
            footerBottom: footerRect.bottom,
            footerTop: footerRect.top,
            viewportHeight: document.documentElement.clientHeight,
          };
        });

      expect(metrics.bodyOverflowY).toBe("auto");
      expect(metrics.cardTop).toBeGreaterThanOrEqual(0);
      expect(metrics.cardBottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
      expect(metrics.footerTop).toBeGreaterThanOrEqual(0);
      expect(metrics.footerBottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
    } finally {
      await page.close();
    }
  }, 30_000);
});
