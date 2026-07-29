import { existsSync } from "node:fs";
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
import {
  ArtifactId,
  AuthTemplateSlug,
  ConnectionName,
  FormElicitation,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
  createExecutor,
  definePlugin,
  type Artifact,
  type ArtifactBindings,
  type CredentialProvider,
  type ToolDef,
} from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import {
  createExecutionEngine,
  type ExecutionEngine,
  type ExecutionResult,
} from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { chromium, type Browser, type Frame, type Page } from "playwright-core";
import { createServer as createViteServer } from "vite";
import type * as Cause from "effect/Cause";

import { createExecutorMcpServer } from "@executor-js/host-mcp/tool-server";

import { loadMcpAppsShellHtml } from "../shell-html";

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
  __sendGeneratedUi: (code: string, artifactId: string) => void;
  __setHostContext: (context: Record<string, unknown>) => void;
};

type AppsClientCapabilities = ClientCapabilities & {
  readonly extensions: Record<string, unknown>;
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// playwright-core ships no browser of its own, so point it at an installed
// Chrome. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` wins; otherwise try the
// conventional per-platform locations so this runs on a dev machine and in CI
// without configuration.
const defaultChromePaths = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
const chromeExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  defaultChromePaths.find((candidate) => existsSync(candidate)) ??
  "/usr/bin/google-chrome";
const formToolId = ToolAddress.make("tools.test.form.main.t");

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
// Two cursor shapes, because the proxy's `cursorKey` has to place a page param
// at a top-level field AND down a dotted path into a nested input object (the
// common `{ query: { … } }` OpenAPI shape).
const ListPageSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(
    Schema.Struct({
      limit: Schema.optional(Schema.Number),
      cursor: Schema.optional(Schema.String),
    }),
  ),
);
const ListNestedPageSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(
    Schema.Struct({
      query: Schema.optional(
        Schema.Struct({
          limit: Schema.optional(Schema.Number),
          since: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

/**
 * A three-page cursor-paginated upstream.
 *
 * `cursor === undefined` is page 1 — which is what makes the proxy's
 * "`initialPageParam: null` sends no cursor at all" convention observable: a
 * first request carrying `{"cursor":null}` would land here as a page-not-found
 * rather than page 1.
 */
const PAGE_SIZE = 2;
const PAGED_ITEMS = ["alpha", "beta", "gamma", "delta", "epsilon"] as const;

const pageOf = (cursor: string | undefined) => {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(offset) || offset < 0 || offset >= PAGED_ITEMS.length) {
    return { items: [], nextCursor: null };
  }
  const items = PAGED_ITEMS.slice(offset, offset + PAGE_SIZE);
  const next = offset + PAGE_SIZE;
  return { items, nextCursor: next < PAGED_ITEMS.length ? String(next) : null };
};
const UpdateAutoRenewSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(
    Schema.Struct({
      domain: Schema.String,
      body: Schema.Struct({ autoRenew: Schema.Boolean }),
    }),
  ),
);

// The fixture upstream: one `inventory` integration whose tools the generated
// UI calls through the shell's proxy. v2 addresses tools per connection
// (`tools.<integration>.<owner>.<connection>.<tool>`), so the harness seeds the
// integration and one org `main` connection below and the generated components
// call `tools.inventory.<tool>`.
const INVENTORY_SLUG = IntegrationSlug.make("inventory");
const INVENTORY_CONNECTION = ConnectionName.make("main");
const INVENTORY_TEMPLATE = AuthTemplateSlug.make("apiKey");

const inventoryMemoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("inventory-memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
    has: (id) => Effect.sync(() => store.has(String(id))),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((key) => ({
          id: ProviderItemId.make(key),
          name: key,
        })),
      ),
  };
};

const validateWith = (
  validator: ReturnType<typeof Schema.toStandardSchemaV1>,
  args: unknown,
): Effect.Effect<unknown, unknown> =>
  Effect.promise(() => Promise.resolve(validator["~standard"].validate(args))).pipe(
    Effect.flatMap((result) =>
      "value" in result ? Effect.succeed(result.value) : Effect.fail(result),
    ),
  );

const inventoryPlugin = (postRequests: string[]) => {
  let autoRenew = false;

  type InventorySpec = {
    readonly name: string;
    readonly description: string;
    readonly inputJsonSchema: unknown;
    readonly validator: ReturnType<typeof Schema.toStandardSchemaV1>;
    /** Mutating tools pause for approval — that's what exercises the shell's
     *  trusted-interaction modal. */
    readonly requiresApproval?: boolean;
    readonly handler: (args: never) => unknown;
  };

  const specs: readonly InventorySpec[] = [
    {
      name: "listItems",
      description: "List inventory items",
      inputJsonSchema: { type: "object", properties: {} },
      validator: EmptySchema,
      handler: () => [{ name: "Widget" }],
    },
    {
      name: "createItem",
      description: "Create an inventory item",
      inputJsonSchema: {
        type: "object",
        properties: {
          body: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
        required: ["body"],
      },
      validator: CreateItemSchema,
      requiresApproval: true,
      handler: (args: { readonly body: { readonly name: string } }) => {
        postRequests.push(JSON.stringify({ name: args.body.name }));
        return { name: args.body.name, created: true };
      },
    },
    {
      name: "getDomain",
      description: "Get domain settings",
      inputJsonSchema: {
        type: "object",
        properties: { domain: { type: "string" } },
        required: ["domain"],
      },
      validator: DomainSchema,
      handler: (args: { readonly domain: string }) => ({ domain: args.domain, renew: autoRenew }),
    },
    {
      name: "listPaged",
      description: "List items one page at a time, top-level cursor",
      inputJsonSchema: {
        type: "object",
        properties: { limit: { type: "integer" }, cursor: { type: "string" } },
      },
      validator: ListPageSchema,
      handler: (args: { readonly cursor?: string }) => pageOf(args.cursor),
    },
    {
      name: "listPagedNested",
      description: "List items one page at a time, cursor nested under query",
      inputJsonSchema: {
        type: "object",
        properties: {
          query: {
            type: "object",
            properties: { limit: { type: "integer" }, since: { type: "string" } },
          },
        },
      },
      validator: ListNestedPageSchema,
      handler: (args: { readonly query?: { readonly since?: string } }) =>
        pageOf(args.query?.since),
    },
    {
      name: "updateDomainAutoRenew",
      description: "Update domain auto-renew",
      inputJsonSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          body: {
            type: "object",
            properties: { autoRenew: { type: "boolean" } },
            required: ["autoRenew"],
          },
        },
        required: ["domain", "body"],
      },
      validator: UpdateAutoRenewSchema,
      requiresApproval: true,
      handler: (args: {
        readonly domain: string;
        readonly body: { readonly autoRenew: boolean };
      }) => {
        autoRenew = args.body.autoRenew;
        postRequests.push(JSON.stringify({ autoRenew }));
        return { domain: args.domain, renew: autoRenew };
      },
    },
  ];

  const byName = new Map(specs.map((spec) => [spec.name, spec] as const));

  return definePlugin(() => ({
    id: "inventory-test" as const,
    credentialProviders: [inventoryMemoryProvider()],
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({
        tools: specs.map(
          (spec): ToolDef => ({
            name: ToolName.make(spec.name),
            description: spec.description,
            inputSchema: spec.inputJsonSchema,
            ...(spec.requiresApproval ? { annotations: { requiresApproval: true } } : {}),
          }),
        ),
      }),
    invokeTool: ({ toolRow, args }) => {
      const spec = byName.get(toolRow.name);
      if (!spec) return Effect.succeed(undefined);
      return validateWith(spec.validator, args).pipe(
        Effect.map((decoded) => spec.handler(decoded as never)),
      );
    },
    extension: (ctx) => ({
      seed: () =>
        ctx.core.integrations.register({
          slug: INVENTORY_SLUG,
          description: "Inventory",
          config: {},
        }),
    }),
  }))();
};

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
  const { data, error, isLoading } = useQuery(
    tools.inventory.listItems.queryOptions({})
  );
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

/** Two accounts of one integration, told apart by role. Both roles are bound to
 *  the harness's single connection, so both reads succeed — what is under test
 *  is that the role survives the whole path (proxy -> cache key -> wire ->
 *  server) rather than which upstream answers. */
const generatedRoleTaggedCode = `
function App() {
  const primary = useQuery(tools.inventory("inventory").listItems.queryOptions({}));
  const secondary = useQuery(tools.inventory("alt").listItems.queryOptions({}));
  const nameOf = (q) => {
    const rows = q.data?.ok ? q.data.data : q.data;
    return rows?.[0]?.name ?? "";
  };
  return (
    <Card>
      <CardContent>
        <div id="primary">{primary.isLoading ? "loading" : nameOf(primary)}</div>
        <div id="secondary">{secondary.isLoading ? "loading" : nameOf(secondary)}</div>
      </CardContent>
    </Card>
  );
}
`;

const generatedApprovalCode = `
function App() {
  const [status, setStatus] = useState("idle");
  const createItem = useMutation(
    tools.inventory.createItem.mutationOptions({
      onSuccess: (result) => {
        const created = result?.ok ? result.data : result;
        setStatus(created.name + ":" + created.created);
      },
      onError: (error) => setStatus(error.message),
    })
  );
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

// Two approval-gated tools in one artifact, which is what makes "don't ask
// again" observable: a grant remembered for one address must not answer the
// other.
const generatedTwoToolApprovalCode = `
function App() {
  const [createStatus, setCreateStatus] = useState("idle");
  const [renewStatus, setRenewStatus] = useState("idle");
  const createItem = useMutation(
    tools.inventory.createItem.mutationOptions({
      onSuccess: (result) => {
        const created = result?.ok ? result.data : result;
        setCreateStatus(created.name);
      },
      onError: (error) => setCreateStatus(error.message),
    })
  );
  const updateAutoRenew = useMutation(
    tools.inventory.updateDomainAutoRenew.mutationOptions({
      onSuccess: (result) => {
        const updated = result?.ok ? result.data : result;
        setRenewStatus(String(updated.renew));
      },
      onError: (error) => setRenewStatus(error.message),
    })
  );

  return (
    <Card>
      <CardContent>
        <Button id="create-first" onClick={() => createItem.mutate({ body: { name: "First Widget" } })}>
          Create first
        </Button>
        <Button id="create-second" onClick={() => createItem.mutate({ body: { name: "Second Widget" } })}>
          Create second
        </Button>
        {/* Writes the value the fixture already holds, so this test proves the
            second address still asks without disturbing the shared upstream
            state a later test reads. */}
        <Button
          id="renew"
          onClick={() => updateAutoRenew.mutate({ domain: "openexecutor.com", body: { autoRenew: false } })}
        >
          Renew
        </Button>
        <div id="create-status">{createStatus}</div>
        <div id="renew-status">{renewStatus}</div>
      </CardContent>
    </Card>
  );
}
`;

const generatedAutoMutationCode = `
function App() {
  const [status, setStatus] = useState("idle");
  const createItem = useMutation(
    tools.inventory.createItem.mutationOptions({
      onSuccess: (result) => {
        const created = result?.ok ? result.data : result;
        setStatus(created.name + ":" + created.created);
      },
      onError: (error) => setStatus(error.message),
    })
  );

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
  const requestDetails = useMutation(
    tools.profile.submit.mutationOptions({
      onSuccess: (result) => {
        setStatus(JSON.stringify(result));
      },
      onError: (error) => setStatus(error.message),
    })
  );

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
  const domainQuery = useQuery(tools.inventory.getDomain.queryOptions(domainArgs));
  const updateAutoRenew = useMutation(
    tools.inventory.updateDomainAutoRenew.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: tools.inventory.getDomain.queryKey(domainArgs),
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

// The declarative answer to "fetch every page" — the thing a model used to
// reach `run()` for. No queryKey, no queryFn, no loop: the proxy mints the key
// and merges each page param into the tool input at `cursorKey`.
const generatedInfiniteQueryCode = `
function App() {
  const paged = useInfiniteQuery(
    tools.inventory.listPaged.infiniteQueryOptions(
      { limit: 2 },
      { getNextPageParam: (lastPage) => (lastPage?.ok ? lastPage.data : lastPage)?.nextCursor ?? undefined }
    )
  );

  const items = (paged.data?.pages ?? []).flatMap(
    (page) => ((page?.ok ? page.data : page)?.items ?? [])
  );

  return (
    <Card>
      <CardContent>
        <div id="paged-items">{items.join(",")}</div>
        <div id="paged-count">{String(paged.data?.pages?.length ?? 0)}</div>
        <div id="paged-has-next">{String(paged.hasNextPage)}</div>
        <Button id="paged-more" onClick={() => paged.fetchNextPage()}>More</Button>
      </CardContent>
    </Card>
  );
}
`;

// Same contract, cursor written down a dotted path into a nested input.
const generatedNestedInfiniteQueryCode = `
function App() {
  const paged = useInfiniteQuery(
    tools.inventory.listPagedNested.infiniteQueryOptions(
      { query: { limit: 2 } },
      {
        cursorKey: "query.since",
        getNextPageParam: (lastPage) => (lastPage?.ok ? lastPage.data : lastPage)?.nextCursor ?? undefined,
      }
    )
  );

  const items = (paged.data?.pages ?? []).flatMap(
    (page) => ((page?.ok ? page.data : page)?.items ?? [])
  );

  return (
    <Card>
      <CardContent>
        <div id="nested-items">{items.join(",")}</div>
        <Button id="nested-more" onClick={() => paged.fetchNextPage()}>More</Button>
      </CardContent>
    </Card>
  );
}
`;

/**
 * The layout the `artifact-style` skill teaches, written exactly as a model is
 * told to write it: a bounded flex column, a header that stays, and one region
 * that scrolls.
 *
 * 120 rows is well past any viewport this harness gives it, so "does it scroll
 * or does it grow" is not ambiguous. The header carries an id so the test can
 * prove it did not move while the rows did.
 */
const generatedAppLayoutCode = `
function App() {
  const rows = Array.from({ length: 120 }, (_, i) => ({ id: i, name: "project-" + i }));
  return (
    <div className="flex h-full flex-col gap-4">
      <div id="layout-header" className="shrink-0">
        <h2 className="text-lg font-semibold tracking-tight">Projects</h2>
      </div>
      <div id="layout-scroll" className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
        <table className="w-full table-fixed">
          <thead id="layout-thead" className="sticky top-0 z-10 bg-background">
            <tr className="border-b border-border">
              <th className="px-4 py-2 text-left text-xs font-medium">Name</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.id} id={"layout-row-" + row.id}>
                <td className="truncate px-4 py-2 text-sm">{row.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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

      // Carries the artifact id beside the code, exactly as the MCP host's
      // create-artifact / show-artifact results do — that is how the shell
      // learns which artifact's bindings resolve its tool calls.
      window.__sendGeneratedUi = (code, artifactId) => {
        sendToApp({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            content: [{ type: "text", text: "" }],
            structuredContent: { code, artifactId },
          },
        });
      };

      // The host changing its mind after the handshake — how the console
      // announces a display mode and a measured viewport once it has laid out.
      // A real host sends only the CHANGED fields, so this does too.
      window.__setHostContext = (context) => {
        sendToApp({
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: context,
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
  execution: { id, elicitationContext: { address: formToolId, args: {}, request } },
});

/**
 * These tests drive the shell directly over postMessage rather than through
 * `create-artifact`, so persistence is out of scope here — but the ui tools only
 * register when an artifacts port is present, and `execute-action` is what the
 * shell actually calls. A trivial in-memory port is enough to bring them up.
 *
 * Every artifact this port mints is pre-bound to the harness's one `inventory`
 * connection, under both the implicit role (`inventory`) and an explicit `alt`
 * role. That is what lets a generated component here address the short form
 * `tools.inventory.listItems` and the role form `tools.inventory("alt").…`, and
 * still reach `tools.inventory.*` on the executor — the same rewrite a
 * real artifact gets from its stored bindings.
 */
/** The artifact every harness component renders as. Pre-seeded so a test can
 *  hand its id to `execute-action` exactly as the host does. */
const HARNESS_ARTIFACT_ID = "art_1";

const HARNESS_BINDINGS: ArtifactBindings = {
  inventory: {
    integration: IntegrationSlug.make(INVENTORY_SLUG),
    owner: "org",
    connection: ConnectionName.make(INVENTORY_CONNECTION),
  },
  alt: {
    integration: IntegrationSlug.make(INVENTORY_SLUG),
    owner: "org",
    connection: ConnectionName.make(INVENTORY_CONNECTION),
  },
  // Used by the elicitation fixtures, which run against a stub engine that
  // answers any address rather than the real inventory executor.
  profile: {
    integration: IntegrationSlug.make("profile"),
    owner: "org",
    connection: ConnectionName.make("main"),
  },
};

const makeInMemoryArtifacts = () => {
  const rows = new Map<string, Artifact>();
  let seq = 0;
  // Pre-seeded, because these tests push code into the shell directly rather
  // than through `create-artifact`. The row exists so `execute-action` has
  // bindings to resolve against, the way it would for any real artifact.
  rows.set(HARNESS_ARTIFACT_ID, {
    id: ArtifactId.make(HARNESS_ARTIFACT_ID),
    owner: "user",
    title: "Harness",
    description: null,
    code: "",
    bindings: HARNESS_BINDINGS,
    preview: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  return {
    list: (): Effect.Effect<readonly Artifact[]> => Effect.sync(() => [...rows.values()]),
    get: (id: string): Effect.Effect<Artifact, Error> =>
      Effect.suspend(() => {
        const row = rows.get(id);
        return row ? Effect.succeed(row) : Effect.fail(new Error(`no artifact ${id}`));
      }),
    save: (input: {
      readonly title: string;
      readonly description?: string | null;
      readonly code: string;
      readonly bindings?: ArtifactBindings | null;
      readonly preview?: string | null;
    }): Effect.Effect<Artifact> =>
      Effect.sync(() => {
        seq += 1;
        const artifact = {
          id: ArtifactId.make(`art_${seq}`),
          owner: "user" as const,
          title: input.title,
          description: input.description ?? null,
          code: input.code,
          bindings: input.bindings ?? HARNESS_BINDINGS,
          preview:
            input.preview === undefined || input.preview === null
              ? null
              : ({ kind: "layout", markup: input.preview } as const),
          createdAt: new Date(seq * 1000),
          updatedAt: new Date(seq * 1000),
        };
        rows.set(artifact.id, artifact);
        return artifact;
      }),
  };
};

const startMcpHarnessForEngine = async <E extends Cause.YieldableError>(
  engine: ExecutionEngine<E>,
): Promise<McpHarness> => {
  const mcpServer = await Effect.runPromise(
    createExecutorMcpServer({
      engine,
      loadAppShellHtml: loadMcpAppsShellHtml,
      artifacts: makeInMemoryArtifacts(),
    }),
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
    Effect.gen(function* () {
      const built = yield* createExecutor(
        makeTestConfig({ plugins: [inventoryPlugin(openApi.postRequests)] }),
      );
      // Tools only exist per connection, so register the integration and open
      // one org `main` connection — that is what makes
      // `tools.inventory.*` resolvable from generated code.
      yield* built["inventory-test"].seed();
      yield* built.connections.create({
        owner: "org",
        name: INVENTORY_CONNECTION,
        integration: INVENTORY_SLUG,
        template: INVENTORY_TEMPLATE,
        value: "token",
      });
      return built;
    }),
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
    pausedExecutionCount: () => Effect.succeed(0),
    hasPausedExecutions: () => Effect.succeed(false),
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
    ([value, artifactId]) =>
      (window as unknown as BrowserHostWindow).__sendGeneratedUi(value!, artifactId!),
    [code, HARNESS_ARTIFACT_ID] as const,
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
              code: "return await tools.inventory.listItems({})",
              artifactId: HARNESS_ARTIFACT_ID,
            },
          }),
        ]),
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  // An artifact that uses two accounts of one integration tags each call site
  // with a role. The role has to survive four hops — the inner proxy's `apply`
  // trap, the TanStack cache key, the postMessage bridge, and the
  // `execute-action` grammar — and be what the server resolves the connection
  // from. If any hop dropped it, both reads would collapse onto one binding and
  // the two calls would be indistinguishable on the wire.
  it("carries an integration role from the proxy through to execute-action", async () => {
    if (!browser || !hostServer) throw new Error("Browser harness did not start.");
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedRoleTaggedCode);

      // Both roles resolved to a real connection and returned real rows.
      await innerFrame.waitForFunction(
        () =>
          document.querySelector("#primary")?.textContent !== "loading" &&
          document.querySelector("#secondary")?.textContent !== "loading",
        undefined,
        { timeout: 10_000 },
      );
      const primary = await innerFrame.locator("#primary").textContent();
      expect(primary).not.toBe("");
      expect(await innerFrame.locator("#secondary").textContent()).toBe(primary);

      // Two separate calls, each naming its own role — not one shared query.
      const roleCalls = (await getHostState(page)).toolCalls
        .map((call) => (call.arguments as { code?: string } | undefined)?.code)
        .filter((code): code is string => Boolean(code?.includes("listItems")));
      expect(roleCalls).toEqual(
        expect.arrayContaining([
          'return await tools.inventory("inventory").listItems({})',
          'return await tools.inventory("alt").listItems({})',
        ]),
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  // The design system only exists for the model if the classes it writes turn
  // into CSS. They did not: the frame received the shell's COMPILED stylesheet,
  // which by construction contains only utilities executor's own components use,
  // so anything else silently no-opped — `text-2xl` computed to 16px and
  // `md:grid-cols-4` stayed one column. The frame now carries the theme as
  // source plus a compiler. This renders classes that appear nowhere in the
  // shell's own sources and asserts the COMPUTED result, because "the class is
  // in the DOM" was always true even when it did nothing.
  it("compiles utility classes the model invents, against executor's tokens", async () => {
    if (!browser || !hostServer) throw new Error("Browser harness did not start.");
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const innerFrame = await renderGeneratedUi(
        page,
        shellFrame,
        `function App() {
           return (
             <div id="probe">
               <div id="size" className="text-2xl">24</div>
               <div id="grid" className="grid grid-cols-1 md:grid-cols-4 gap-3">
                 <span>a</span><span>b</span><span>c</span><span>d</span>
               </div>
               <div id="arbitrary" className="tracking-[0.08em] text-[11px]">label</div>
               <div id="token" className="text-muted-foreground">muted</div>
             </div>
           );
         }`,
      );
      await innerFrame.locator("#probe").waitFor({ timeout: 10_000 });

      const computed = await innerFrame.evaluate(() => {
        const styleOf = (id: string) => getComputedStyle(document.getElementById(id)!);
        return {
          fontSize: styleOf("size").fontSize,
          gridColumns: styleOf("grid").gridTemplateColumns.split(" ").length,
          letterSpacing: styleOf("arbitrary").letterSpacing,
          labelSize: styleOf("arbitrary").fontSize,
          mutedColor: styleOf("token").color,
          bodyFont: getComputedStyle(document.body).fontFamily,
          bodyNumeric: getComputedStyle(document.body).fontVariantNumeric,
        };
      });

      // A built-in scale step, a responsive variant, and an arbitrary value —
      // three different paths through the compiler, none of them in the shell.
      expect(computed.fontSize, "text-2xl resolves to its real size").toBe("24px");
      expect(computed.gridColumns, "md:grid-cols-4 produces four columns").toBe(4);
      expect(computed.labelSize, "an arbitrary text size compiles").toBe("11px");
      expect(computed.letterSpacing, "an arbitrary tracking compiles").not.toBe("normal");

      // Compiled against EXECUTOR's theme, not Tailwind's defaults: the muted
      // token is the design system's gray, and the type is Geist.
      expect(computed.mutedColor, "muted-foreground is executor's gray").toBe("rgb(102, 102, 102)");
      expect(computed.bodyFont, "the frame is set in Geist").toContain("Geist");
      expect(computed.bodyNumeric, "numbers are tabular by default").toContain("tabular-nums");
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

      // A tool-call request from the wrong window, and one from the right
      // window with the wrong token. Neither may reach the bridge.
      await shellFrame.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Generated UI"]');
        const srcDoc = iframe?.getAttribute("srcdoc") ?? "";
        const token = /<meta name="executor-render-token" content="([^"]+)">/.exec(srcDoc)?.[1];
        if (!iframe?.contentWindow || !token) {
          throw new Error("Generated UI iframe is missing a token.");
        }

        const payload = {
          type: "executor.toolCall",
          path: ["inventory", "listItems"],
          args: [{}],
        };
        window.dispatchEvent(
          new MessageEvent("message", {
            source: window,
            data: { ...payload, requestId: 1, token },
          }),
        );
        window.dispatchEvent(
          new MessageEvent("message", {
            source: iframe.contentWindow,
            data: { ...payload, requestId: 2, token: "wrong" },
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
            data: {
              type: "executor.toolCall",
              requestId: 3,
              token,
              path: ["inventory", "listItems"],
              args: [{}],
            },
          }),
        );
      });

      await page.waitForFunction(
        () => (window as unknown as BrowserHostWindow).__mcpHostState.toolCalls.length === 1,
      );
      // Even the accepted message becomes the one proxy grammar, never raw code
      // — the outer frame builds the source, the inner frame only names a tool.
      expect((await getHostState(page)).toolCalls[0]).toEqual(
        expect.objectContaining({
          name: "execute-action",
          arguments: {
            code: "return await tools.inventory.listItems({})",
            artifactId: HARNESS_ARTIFACT_ID,
          },
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

  // One refusal control, not two. `buildElicit` and `enforceApproval` in
  // `@executor-js/sdk` raise `ElicitationDeclinedError` for ANY non-accept
  // action, so "decline" and "cancel" are the same outcome at the gate and the
  // modal offers only Cancel.
  it("resumes a canceled approval without performing the mutation", async () => {
    if (!browser || !hostServer || !openApiServer) {
      throw new Error("Browser harness did not start.");
    }

    const { page, shellFrame } = await openHarness(browser, hostServer.url);
    const initialPostCount = openApiServer.postRequests.length;

    try {
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedApprovalCode);
      await innerFrame.locator("#ask").click({ timeout: 10_000 });
      await shellFrame.locator("text=Approve action").waitFor({ timeout: 10_000 });

      expect(await shellFrame.getByRole("button", { name: "Decline" }).count()).toBe(0);
      await shellFrame
        .locator('[data-testid="trusted-interaction-cancel"]')
        .click({ timeout: 10_000 });
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
            action: "cancel",
            content: "{}",
          },
        }),
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("tells the user what they are confirming rather than where the modal came from", async () => {
    if (!browser || !hostServer) throw new Error("Browser harness did not start.");
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedApprovalCode);
      await innerFrame.locator("#ask").click({ timeout: 10_000 });

      const card = shellFrame.locator('[data-testid="trusted-interaction-card"]');
      await card.waitFor({ timeout: 10_000 });
      const cardText = await card.innerText();

      expect(cardText).toContain("Approve action");
      expect(cardText).toContain("You've triggered a destructive action in the UI, please confirm");
      expect(cardText).not.toContain("This approval is handled by the Executor shell.");
      // The concrete request preview stays — copy changed, evidence did not.
      expect(cardText).toContain("createItem");
    } finally {
      await page.close();
    }
  }, 30_000);

  it("stops asking for a tool the user approved for good, and only that tool", async () => {
    if (!browser || !hostServer || !openApiServer) {
      throw new Error("Browser harness did not start.");
    }
    const { page, shellFrame } = await openHarness(browser, hostServer.url);
    const modal = shellFrame.locator('[data-testid="trusted-interaction-modal"]');

    try {
      // Remembered grants persist per console origin, so start from a known
      // empty state rather than inheriting one from an earlier run.
      await shellFrame.evaluate(() => globalThis.localStorage.clear());

      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedTwoToolApprovalCode);
      const initialPostCount = openApiServer.postRequests.length;

      await innerFrame.locator("#create-first").click({ timeout: 10_000 });
      await modal.waitFor({ timeout: 10_000 });
      await shellFrame
        .locator('[data-testid="trusted-interaction-approve-menu"]')
        .click({ timeout: 10_000 });
      await shellFrame
        .locator('[data-testid="trusted-interaction-approve-always"]')
        .click({ timeout: 10_000 });
      await innerFrame.waitForFunction(
        () => document.querySelector("#create-status")?.textContent === "First Widget",
        undefined,
        { timeout: 10_000 },
      );

      // Same tool again: answered from the grant, so no modal ever mounts.
      await innerFrame.locator("#create-second").click({ timeout: 10_000 });
      await innerFrame.waitForFunction(
        () => document.querySelector("#create-status")?.textContent === "Second Widget",
        undefined,
        { timeout: 10_000 },
      );
      expect(await modal.count()).toBe(0);
      expect(openApiServer.postRequests.slice(initialPostCount)).toEqual([
        JSON.stringify({ name: "First Widget" }),
        JSON.stringify({ name: "Second Widget" }),
      ]);

      // A different address on the same artifact is a different action.
      await innerFrame.locator("#renew").click({ timeout: 10_000 });
      await modal.waitFor({ timeout: 10_000 });
      await shellFrame
        .locator('[data-testid="trusted-interaction-approve"]')
        .click({ timeout: 10_000 });
      await innerFrame.waitForFunction(
        () => document.querySelector("#renew-status")?.textContent === "false",
        undefined,
        { timeout: 10_000 },
      );

      const hostState = await getHostState(page);
      expect(
        hostState.resumeCalls.map((call) => (call.arguments as { action?: string }).action),
      ).toEqual(["accept", "accept", "accept"]);
    } finally {
      await shellFrame.evaluate(() => globalThis.localStorage.clear()).catch(() => undefined);
      await page.close();
    }
  }, 60_000);

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
              code: 'return await tools.inventory.createItem({"body":{"name":"Mount Widget"}})',
              artifactId: HARNESS_ARTIFACT_ID,
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
              code: 'return await tools.inventory.getDomain({"domain":"openexecutor.com"})',
              artifactId: HARNESS_ARTIFACT_ID,
            },
          }),
          expect.objectContaining({
            name: "execute-action",
            arguments: {
              code: 'return await tools.inventory.updateDomainAutoRenew({"domain":"openexecutor.com","body":{"autoRenew":true}})',
              artifactId: HARNESS_ARTIFACT_ID,
            },
          }),
        ]),
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  it("pages through a multi-page upstream declaratively with useInfiniteQuery", async () => {
    if (!browser || !hostServer) throw new Error("Browser harness did not start.");
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedInfiniteQueryCode);

      // Page 1 only — an infinite query fetches exactly one page up front. The
      // whole point is that "get everything" is the user's/component's choice,
      // not an opaque 40-iteration loop hidden inside a queryFn.
      await innerFrame.waitForFunction(
        () => document.querySelector("#paged-items")?.textContent === "alpha,beta",
        undefined,
        { timeout: 10_000 },
      );
      expect(await innerFrame.locator("#paged-has-next").textContent()).toBe("true");

      await innerFrame.locator("#paged-more").click({ timeout: 10_000 });
      await innerFrame.waitForFunction(
        () => document.querySelector("#paged-items")?.textContent === "alpha,beta,gamma,delta",
        undefined,
        { timeout: 10_000 },
      );

      await innerFrame.locator("#paged-more").click({ timeout: 10_000 });
      await innerFrame.waitForFunction(
        () =>
          document.querySelector("#paged-items")?.textContent === "alpha,beta,gamma,delta,epsilon",
        undefined,
        { timeout: 10_000 },
      );
      // `getNextPageParam` returned undefined for the last page, so paging stops.
      await innerFrame.waitForFunction(
        () => document.querySelector("#paged-has-next")?.textContent === "false",
        undefined,
        { timeout: 10_000 },
      );
      expect(await innerFrame.locator("#paged-count").textContent()).toBe("3");

      // Every page went over the wire as an ordinary single tool call — the
      // cursor merged into the tool INPUT, not spliced into code. The first
      // request carries no cursor at all (`initialPageParam: null`).
      const hostState = await getHostState(page);
      const pagedCalls = hostState.toolCalls
        .map((call) => (call.arguments as { code?: string } | undefined)?.code)
        .filter((code): code is string => Boolean(code?.includes("listPaged(")));
      expect(pagedCalls).toEqual([
        'return await tools.inventory.listPaged({"limit":2})',
        'return await tools.inventory.listPaged({"limit":2,"cursor":"2"})',
        'return await tools.inventory.listPaged({"limit":2,"cursor":"4"})',
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("places an infinite-query cursor down a dotted path into a nested input", async () => {
    if (!browser || !hostServer) throw new Error("Browser harness did not start.");
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const innerFrame = await renderGeneratedUi(
        page,
        shellFrame,
        generatedNestedInfiniteQueryCode,
      );
      await innerFrame.waitForFunction(
        () => document.querySelector("#nested-items")?.textContent === "alpha,beta",
        undefined,
        { timeout: 10_000 },
      );

      await innerFrame.locator("#nested-more").click({ timeout: 10_000 });
      await innerFrame.waitForFunction(
        () => document.querySelector("#nested-items")?.textContent === "alpha,beta,gamma,delta",
        undefined,
        { timeout: 10_000 },
      );

      const hostState = await getHostState(page);
      const nestedCalls = hostState.toolCalls
        .map((call) => (call.arguments as { code?: string } | undefined)?.code)
        .filter((code): code is string => Boolean(code?.includes("listPagedNested(")));
      // The merge is a deep write that preserves the sibling `limit`, rather
      // than replacing the nested object.
      expect(nestedCalls).toEqual([
        'return await tools.inventory.listPagedNested({"query":{"limit":2}})',
        'return await tools.inventory.listPagedNested({"query":{"limit":2,"since":"2"}})',
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("refuses arbitrary code posted straight at execute-action", async () => {
    if (!browser || !hostServer) throw new Error("Browser harness did not start.");
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      // The shell offers no way to write this — but the app channel is reachable
      // from anything that can speak the bridge, so the SERVER is what has to
      // refuse it. Posted through the host's own tools/call path, exactly as a
      // hostile frame would.
      await renderGeneratedUi(page, shellFrame, generatedStaticCode);

      const rejected = await page.evaluate(async () => {
        const response = await fetch("/tools/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "execute-action",
            arguments: {
              code: "let all = []; for (let i = 0; i < 40; i++) { all.push(await tools.inventory.listItems({})) } return all",
            },
          }),
        });
        return (await response.json()) as {
          isError?: boolean;
          content?: Array<{ text?: string }>;
        };
      });

      expect(rejected.isError).toBe(true);
      expect(rejected.content?.[0]?.text).toContain("single tool call");
      expect(rejected.content?.[0]?.text).toContain("infiniteQueryOptions");
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

  // "Don't ask again" is consent to skip the prompt, not consent to invent the
  // answer. This schema's `name`, `priority` and `tags` are required with no
  // defaults, so there is nothing to resume with and the modal must come back.
  it("still asks when a remembered tool needs values the user never gave", async () => {
    if (!browser || !shellServer) {
      throw new Error("Browser harness did not start.");
    }

    const schemaMcpHarness = await startSchemaElicitationMcpHarness();
    const schemaHostServer = await startHostServer(shellServer.url, schemaMcpHarness);
    const { page, shellFrame } = await openHarness(browser, schemaHostServer.url);
    const modal = shellFrame.locator('[data-testid="trusted-interaction-modal"]');

    try {
      await shellFrame.evaluate(() => globalThis.localStorage.clear());
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedSchemaApprovalCode);

      await innerFrame.locator("#ask-schema").click({ timeout: 10_000 });
      await modal.waitFor({ timeout: 10_000 });
      await shellFrame.getByLabel("Display name").fill("Rhea");
      await shellFrame.getByLabel("Priority").selectOption("high");
      await shellFrame.getByLabel("Beta").click();
      await shellFrame
        .locator('[data-testid="trusted-interaction-approve-menu"]')
        .click({ timeout: 10_000 });
      await shellFrame
        .locator('[data-testid="trusted-interaction-approve-always"]')
        .click({ timeout: 10_000 });
      await modal.waitFor({ state: "detached", timeout: 10_000 });

      await innerFrame.locator("#ask-schema").click({ timeout: 10_000 });
      await modal.waitFor({ timeout: 10_000 });
      // The remembered grant did not answer for the user, and nothing resumed
      // behind their back.
      const hostState = await getHostState(page);
      expect(hostState.resumeCalls).toHaveLength(1);
    } finally {
      await shellFrame.evaluate(() => globalThis.localStorage.clear()).catch(() => undefined);
      await page.close();
      await schemaHostServer.close();
      await schemaMcpHarness.close();
    }
  }, 60_000);

  /**
   * The regression guard for the whole point of fill mode.
   *
   * What broke before it existed: an artifact's `h-full` resolved against an
   * unbounded chain, so `flex-1 min-h-0 overflow-auto` was just a div that grew.
   * The table pushed its own header off the top of the screen and the user
   * scrolled a document when they wanted an app.
   *
   * So this asserts the three things that have to be true together, since any
   * one of them alone can hold while the layout is still broken:
   *
   *   1. the scroll region is genuinely bounded and overflowing
   *      (`scrollHeight > clientHeight`) — not merely tall;
   *   2. it actually scrolls when scrolled;
   *   3. the artifact's header does NOT move while it does.
   */
  it("gives a bounded viewport to an artifact laid out as an app", async () => {
    if (!browser || !hostServer) {
      throw new Error("Browser harness did not start.");
    }
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      // The console's negotiation, verbatim: the spec's `fullscreen` mode plus a
      // FIXED container height. Both are required — a mode with no height is not
      // a viewport, and the shell deliberately stays inline for it.
      await page.evaluate(() => {
        (window as unknown as BrowserHostWindow).__setHostContext({
          displayMode: "fullscreen",
          availableDisplayModes: ["inline", "fullscreen"],
          containerDimensions: { height: 900 },
        });
      });
      await shellFrame.waitForFunction(() =>
        document.documentElement.classList.contains("artifact-fill"),
      );

      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedAppLayoutCode);
      await innerFrame.locator("#layout-row-119").waitFor({ timeout: 10_000 });
      // The class has to reach the INNER document too — it is the last link in
      // the height chain, and the artifact's own `h-full` resolves there.
      await innerFrame.waitForFunction(() =>
        document.documentElement.classList.contains("artifact-fill"),
      );

      const before = await innerFrame.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>("#layout-scroll");
        const header = document.querySelector<HTMLElement>("#layout-header");
        const thead = document.querySelector<HTMLElement>("#layout-thead");
        const firstRow = document.querySelector<HTMLElement>("#layout-row-0");
        if (!scroller || !header || !thead || !firstRow) {
          throw new Error("Missing layout elements.");
        }
        return {
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          headerTop: header.getBoundingClientRect().top,
          theadTop: thead.getBoundingClientRect().top,
          firstRowTop: firstRow.getBoundingClientRect().top,
          bodyScrollHeight: document.body.scrollHeight,
          bodyClientHeight: document.body.clientHeight,
        };
      });

      // Bounded: the region is shorter than its content, which is what makes it
      // a scroll box rather than a tall div.
      expect(before.clientHeight).toBeGreaterThan(0);
      expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
      // And the DOCUMENT is not the thing that overflows — the artifact absorbed
      // its own content instead of pushing the frame out.
      expect(before.bodyScrollHeight).toBeLessThanOrEqual(before.bodyClientHeight + 1);

      const after = await innerFrame.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>("#layout-scroll");
        const header = document.querySelector<HTMLElement>("#layout-header");
        const thead = document.querySelector<HTMLElement>("#layout-thead");
        const firstRow = document.querySelector<HTMLElement>("#layout-row-0");
        if (!scroller || !header || !thead || !firstRow) {
          throw new Error("Missing layout elements.");
        }
        scroller.scrollTop = 400;
        return {
          scrollTop: scroller.scrollTop,
          headerTop: header.getBoundingClientRect().top,
          theadTop: thead.getBoundingClientRect().top,
          firstRowTop: firstRow.getBoundingClientRect().top,
        };
      });

      // It really scrolled: the rows moved up by the amount scrolled.
      expect(after.scrollTop).toBeGreaterThan(0);
      expect(before.firstRowTop - after.firstRowTop).toBeCloseTo(after.scrollTop, 0);
      // The artifact's own header stayed exactly where it was — this is the
      // "Projects" title and its search box that used to scroll away.
      expect(after.headerTop).toBeCloseTo(before.headerTop, 0);
      // And the sticky table header stayed with it rather than travelling up
      // with the rows. Compared against its own starting position rather than
      // the container's edge, since `sticky` pins to the padding box (inside the
      // 1px border), not the border box.
      expect(after.theadTop).toBeCloseTo(before.theadTop, 0);
    } finally {
      await page.close();
    }
  }, 60_000);

  /**
   * The other half of the contract, and the one that protects every chat host:
   * with no fill context the shell must behave exactly as it always has — report
   * its content height and let the host grow the frame. A regression here would
   * clip artifacts inside Claude, where there is no bounded viewport to fill.
   */
  it("still grows to content for a host that offers no viewport", async () => {
    if (!browser || !hostServer) {
      throw new Error("Browser harness did not start.");
    }
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedAppLayoutCode);
      await innerFrame.locator("#layout-row-119").waitFor({ timeout: 10_000 });

      const fillApplied = await shellFrame.evaluate(() =>
        document.documentElement.classList.contains("artifact-fill"),
      );
      expect(fillApplied).toBe(false);

      // The inner document grows past the frame it was given and reports that
      // height outward; the scroll region has no bound to scroll inside, which
      // is correct — in a thread the transcript is what scrolls.
      const metrics = await innerFrame.evaluate(() => ({
        bodyScrollHeight: document.body.scrollHeight,
        rootHeight: document.getElementById("root")?.getBoundingClientRect().height ?? 0,
      }));
      expect(metrics.bodyScrollHeight).toBeGreaterThan(1000);
      expect(metrics.rootHeight).toBeGreaterThan(1000);
    } finally {
      await page.close();
    }
  }, 60_000);

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
