import { describe, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type * as Cause from "effect/Cause";

import {
  ArtifactId,
  FormElicitation,
  type Artifact,
  type ArtifactBindings,
  type ArtifactSummary,
} from "@executor-js/sdk";
import type { ExecutionEngine, ExecutionResult } from "@executor-js/execution";

import type { BindableConnection } from "./artifact-bindings";
import { MCP_APPS_SHELL_RESOURCE_URI, artifactUrlFor } from "./create-artifact";
import { createExecutorMcpServer, type ExecutorMcpServerConfig } from "./tool-server";

/** The caller's connection inventory, as `create-artifact` sees it when it
 *  binds an artifact's integration roles. */
const connectionsPort = (available: readonly BindableConnection[]) => ({
  list: (): Effect.Effect<readonly BindableConnection[]> => Effect.succeed(available),
});

const conn = (integration: string, owner: "user" | "org", name: string): BindableConnection => ({
  integration,
  owner,
  name,
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class TestArtifactError extends Data.TaggedError("TestArtifactError")<{
  readonly message: string;
}> {}

const makeStubEngine = <E extends Cause.YieldableError = never>(overrides: {
  executeWithPause?: ExecutionEngine<E>["executeWithPause"];
  resume?: ExecutionEngine<E>["resume"];
}): ExecutionEngine<E> => ({
  execute: () => Effect.succeed({ result: "default" }),
  executeWithPause:
    overrides.executeWithPause ??
    (() => Effect.succeed({ status: "completed", result: { result: "default" } })),
  resume: overrides.resume ?? (() => Effect.succeed(null)),
  isExecutionSettled: undefined,
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("test executor"),
});

/**
 * An in-memory stand-in for `executor.artifacts` with the same observable
 * behavior the real owner-scoped store has: save mints an id (or overwrites in
 * place), get fails when nothing matches, list is newest-first without code.
 */
const makeArtifactStore = () => {
  const rows = new Map<string, Artifact>();
  let seq = 0;
  const calls: Array<{
    title: string;
    description: string | null;
    code: string;
    bindings: ArtifactBindings | null;
  }> = [];
  return {
    calls,
    rows,
    port: {
      list: (): Effect.Effect<readonly ArtifactSummary[]> =>
        Effect.sync(() =>
          [...rows.values()]
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
            .map(({ code: _code, bindings: _bindings, ...summary }) => summary),
        ),
      get: (id: string): Effect.Effect<Artifact, TestArtifactError> =>
        Effect.suspend(() => {
          const row = rows.get(id);
          return row
            ? Effect.succeed(row)
            : Effect.fail(new TestArtifactError({ message: `no artifact ${id}` }));
        }),
      save: (input: {
        readonly id?: string;
        readonly title: string;
        readonly description?: string | null;
        readonly code: string;
        readonly bindings?: ArtifactBindings | null;
      }): Effect.Effect<Artifact, TestArtifactError> =>
        Effect.suspend(() => {
          calls.push({
            title: input.title,
            description: input.description ?? null,
            code: input.code,
            bindings: input.bindings ?? null,
          });
          const existing = input.id === undefined ? undefined : rows.get(input.id);
          if (input.id !== undefined && !existing) {
            return Effect.fail(new TestArtifactError({ message: `no artifact ${input.id}` }));
          }
          seq += 1;
          const artifact: Artifact = {
            id: ArtifactId.make(existing?.id ?? `art_${seq}`),
            owner: "user",
            title: input.title,
            description: input.description ?? null,
            code: input.code,
            bindings: input.bindings ?? null,
            createdAt: existing?.createdAt ?? new Date(seq * 1000),
            updatedAt: new Date(seq * 1000),
          };
          rows.set(artifact.id, artifact);
          return Effect.succeed(artifact);
        }),
    },
  };
};

const withClient = async <E extends Cause.YieldableError>(
  engine: ExecutionEngine<E>,
  capabilities: ClientCapabilities,
  fn: (client: Client) => Promise<void>,
  config?: Partial<ExecutorMcpServerConfig<E>>,
) => {
  const mcpServer = await Effect.runPromise(
    createExecutorMcpServer({
      engine,
      loadAppShellHtml: () => Promise.resolve(SHELL_HTML),
      ...config,
    } as ExecutorMcpServerConfig<E>),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities });
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test helper must close MCP transports after async client assertions
  try {
    await fn(client);
  } finally {
    await clientTransport.close();
    await serverTransport.close();
  }
};

const SHELL_HTML = "<!doctype html><html><body><div id='root'></div></body></html>";

// What a client that renders MCP Apps advertises at `initialize`. The SDK's
// `ClientCapabilities` has no `extensions` field yet (pending SEP-1724), which
// is exactly why ext-apps ships `getUiCapability` to read it.
// oxlint-disable-next-line executor/no-double-cast -- boundary: MCP SDK ClientCapabilities predates the ext-apps `extensions` field
const APPS_CAPS = {
  extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
} as unknown as ClientCapabilities;

const NO_APPS_CAPS: ClientCapabilities = {};

const structuredOf = (result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> =>
  (result.structuredContent ?? {}) as Record<string, unknown>;

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as Array<{ type: string; text: string }>)[0].text;

const toolNames = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((tool) => tool.name);

const COUNTER_CODE = "function App() { return <div>hi</div>; }";
const UPDATED_CODE = "function App() { return <div>hi again</div>; }";

const makePausedResult = (id: string, message: string): ExecutionResult => ({
  status: "paused",
  execution: {
    id,
    elicitationContext: {
      request: FormElicitation.make({ message, requestedSchema: {} }),
    },
  } as ExecutionResult extends { status: "paused"; execution: infer P } ? P : never,
});

// ---------------------------------------------------------------------------
// Capability-gated visibility
// ---------------------------------------------------------------------------

describe("MCP host — artifact tool visibility", () => {
  it("hides the app-only tools from clients that cannot render MCP Apps", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      NO_APPS_CAPS,
      async (client) => {
        const names = await toolNames(client);
        // The model-facing three are always advertised — they degrade to a
        // deep link rather than disappearing.
        expect(names).toContain("create-artifact");
        expect(names).toContain("list-artifacts");
        expect(names).toContain("show-artifact");
        // `execute-action` is only callable from inside a rendered app.
        expect(names).not.toContain("execute-action");
        expect(names).not.toContain("execute-action-resume");
      },
      { artifacts: store.port },
    );
  });

  it("exposes the app-only tools to clients that advertise the shell mime type", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const names = await toolNames(client);
        expect(names).toContain("create-artifact");
        expect(names).toContain("execute-action");
        expect(names).toContain("execute-action-resume");
      },
      { artifacts: store.port },
    );
  });

  it("registers no ui tools at all when no shell loader is configured", async () => {
    const store = makeArtifactStore();
    const mcpServer = await Effect.runPromise(
      createExecutorMcpServer({
        engine: makeStubEngine({}),
        artifacts: store.port,
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("execute");
    expect(names).not.toContain("create-artifact");
    expect(names).not.toContain("list-artifacts");
    await clientTransport.close();
    await serverTransport.close();
  });

  it("serves the shell as an MCP-Apps resource with a zero-domain CSP", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const read = await client.readResource({
          uri: MCP_APPS_SHELL_RESOURCE_URI,
        });
        const [content] = read.contents;
        expect(content.mimeType).toBe(RESOURCE_MIME_TYPE);
        // Served as text, never as a blob.
        expect("text" in content).toBe(true);
        expect("text" in content ? content.text : "").toBe(SHELL_HTML);
        // The shell may open no network connection of its own; everything
        // routes back over the MCP bridge.
        expect(content._meta).toMatchObject({
          ui: { csp: { connectDomains: [], resourceDomains: [] } },
        });
      },
      { artifacts: store.port },
    );
  });
});

// ---------------------------------------------------------------------------
// create-artifact delivery
// ---------------------------------------------------------------------------

describe("MCP host — create-artifact", () => {
  it("returns the code inline and persists it when the client renders apps", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: COUNTER_CODE,
            title: "Active users dashboard",
            description: "Daily active users over time",
          },
        });
        expect(structuredOf(result)).toEqual({
          code: COUNTER_CODE,
          artifactId: "art_1",
        });
        expect(result.isError).toBeFalsy();
        expect(store.calls).toEqual([
          {
            title: "Active users dashboard",
            description: "Daily active users over time",
            code: COUNTER_CODE,
            // Code that calls no integration is still BOUND, to nothing.
            bindings: {},
          },
        ]);
      },
      {
        artifacts: store.port,
        artifactUrl: artifactUrlFor("https://executor.test"),
      },
    );
  });

  it("returns a deep link and still persists when the client cannot render apps", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      NO_APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: { code: COUNTER_CODE, title: "Active users dashboard" },
        });
        expect(structuredOf(result)).toEqual({
          status: "fallback_url",
          url: "https://executor.test/artifacts/art_1",
          artifactId: "art_1",
        });
        // The model needs to be told to hand the URL over.
        expect(textOf(result)).toContain("https://executor.test/artifacts/art_1");
        // Persistence is what makes the fallback possible at all.
        expect(store.calls).toHaveLength(1);
        expect(store.rows.get("art_1")?.code).toBe(COUNTER_CODE);
      },
      {
        artifacts: store.port,
        artifactUrl: artifactUrlFor("https://executor.test"),
      },
    );
  });

  it("carries the org slug into the deep link on an org-scoped host", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      NO_APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: { code: COUNTER_CODE, title: "Active users dashboard" },
        });
        expect(structuredOf(result)).toEqual({
          status: "fallback_url",
          url: "https://executor.test/acme/artifacts/art_1",
          artifactId: "art_1",
        });
        expect(textOf(result)).toContain("https://executor.test/acme/artifacts/art_1");
      },
      {
        artifacts: store.port,
        artifactUrl: artifactUrlFor("https://executor.test", "acme"),
      },
    );
  });

  it("still persists and reports the id when no web UI is configured", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      NO_APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: { code: COUNTER_CODE, title: "Orphan dashboard" },
        });
        expect(structuredOf(result)).toEqual({
          status: "fallback_unavailable",
          reason: "mcp_apps_unsupported",
          artifactId: "art_1",
        });
        expect(store.rows.get("art_1")?.title).toBe("Orphan dashboard");
      },
      { artifacts: store.port },
    );
  });

  it("rejects redeclared provided globals before the code reaches the iframe", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const destructured = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: "const { useState } = React; function App(){ return null; }",
            title: "Bad",
          },
        });
        expect(destructured.isError).toBe(true);
        expect(textOf(destructured)).toContain("Do not destructure React");

        const shadowed = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: "const Card = 1; function App(){ return null; }",
            title: "Bad",
          },
        });
        expect(shadowed.isError).toBe(true);
        expect(textOf(shadowed)).toContain('Provided global "Card"');

        // Nothing rejected is ever persisted.
        expect(store.calls).toHaveLength(0);
      },
      { artifacts: store.port },
    );
  });

  // `run(code)` is gone from the shell scope entirely, so code calling it would
  // die inside the iframe with a bare ReferenceError. Rejecting it here is how
  // the model learns the declarative replacement instead.
  it("rejects code that reaches for the removed run() escape hatch", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const rejected = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: [
              "function App(){",
              "  const q = useQuery({",
              "    queryKey: ['domains'],",
              "    queryFn: () => run('let all = []; for (let i=0;i<40;i++){ all.push(await tools.a.b({})) } return all'),",
              "  });",
              "  return null;",
              "}",
            ].join("\n"),
            title: "Paginated",
          },
        });
        expect(rejected.isError).toBe(true);
        expect(textOf(rejected)).toContain("`run(code)` no longer exists");
        expect(textOf(rejected)).toContain("infiniteQueryOptions");
        expect(store.calls).toHaveLength(0);
      },
      { artifacts: store.port },
    );
  });

  it("allows a component's own helper named run, and property access on run", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const accepted = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: [
              "function App(){",
              "  const run = (id) => id;",
              "  const label = workflow.run({ id: 1 });",
              "  return <div>{run(label)}</div>;",
              "}",
            ].join("\n"),
            title: "Local run",
          },
        });
        expect(accepted.isError).toBeFalsy();
        expect(store.calls).toHaveLength(1);
      },
      { artifacts: store.port },
    );
  });

  // The shape a model reaches for when it never fetched the skill: cursor
  // pagination hand-rolled as a hook per page, capped by a constant.
  it("rejects the chained-useQuery pagination loop and names infiniteQueryOptions", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const rejected = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: [
              "const MAX_PAGES = 8;",
              "function App(){",
              "  const pages = [];",
              "  let cursor = null;",
              "  for (let i = 0; i < MAX_PAGES; i++) {",
              "    const page = useQuery(",
              "      tools.vercel.getDomains.queryOptions({ limit: 100, since: cursor }),",
              "      { enabled: i === 0 || cursor != null },",
              "    );",
              "    cursor = page.data?.pagination?.next ?? null;",
              "    pages.push(page);",
              "  }",
              "  return <div>{pages.length}</div>;",
              "}",
            ].join("\n"),
            title: "Domains",
          },
        });
        expect(rejected.isError).toBe(true);
        expect(textOf(rejected)).toContain("`useQuery` is called inside a loop body");
        expect(textOf(rejected)).toContain("infiniteQueryOptions");
        expect(store.calls).toHaveLength(0);
      },
      { artifacts: store.port },
    );
  });

  it("rejects a hook in a loop even when the loop body nests further blocks", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const rejected = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: [
              "function App(){",
              "  const flags = [];",
              "  while (flags.length < 3) {",
              "    if (flags.length % 2 === 0) {",
              "      const [on, setOn] = useState(false);",
              "      flags.push(on);",
              "    }",
              "  }",
              "  return null;",
              "}",
            ].join("\n"),
            title: "Flags",
          },
        });
        expect(rejected.isError).toBe(true);
        expect(textOf(rejected)).toContain("`useState` is called inside a loop body");
        // Not a pagination problem — no point pointing at infiniteQueryOptions.
        expect(textOf(rejected)).toContain("Move the hook out of the loop");
        expect(store.calls).toHaveLength(0);
      },
      { artifacts: store.port },
    );
  });

  // The check must never punish a loop that merely precedes a hook.
  it("allows hooks that follow a closed loop, and loops that call no hooks", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const accepted = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: [
              "function App(){",
              "  const buckets = [];",
              "  for (let i = 0; i < 12; i++) {",
              "    buckets.push({ month: i, label: `M${i}` });",
              "  }",
              "  const rows = useQuery(tools.vercel.getDomains.queryOptions({ limit: 100 }));",
              "  const [selected, setSelected] = useState(null);",
              "  const totals = useMemo(() => {",
              "    let sum = 0;",
              "    for (const row of rows.data ?? []) sum += row.count;",
              "    return sum;",
              "  }, [rows.data]);",
              "  return <div>{totals}{buckets.length}{selected}</div>;",
              "}",
            ].join("\n"),
            title: "Buckets",
          },
        });
        expect(accepted.isError).toBeFalsy();
        expect(store.calls).toHaveLength(1);
      },
      {
        artifacts: store.port,
        connections: connectionsPort([conn("vercel", "user", "personalVercel")]),
      },
    );
  });

  it("does not mistake loop keywords or hook names inside strings and JSX text", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const accepted = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: [
              "function App(){",
              "  const rows = useQuery(tools.vercel.getDomains.queryOptions({ limit: 50 }));",
              '  const hint = "for (const x of xs) { useQuery(x) }";',
              "  return (",
              "    <div>",
              "      <p>Nothing to do while we wait for {rows.data?.length} domains</p>",
              "      <code>{hint}</code>",
              "    </div>",
              "  );",
              "}",
            ].join("\n"),
            title: "Hints",
          },
        });
        expect(accepted.isError).toBeFalsy();
        expect(store.calls).toHaveLength(1);
      },
      {
        artifacts: store.port,
        connections: connectionsPort([conn("vercel", "user", "personalVercel")]),
      },
    );
  });

  it("allows display constants that the dropped data heuristic used to reject", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        // The donor branch rejected this on the variable name alone. Legit
        // chart configuration is not a hardcoded live-data snapshot.
        const result = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: "const series = [{ key: 'a', color: '#111' }, { key: 'b', color: '#222' }]; function App(){ return null; }",
            title: "Chart",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(store.calls).toHaveLength(1);
      },
      { artifacts: store.port },
    );
  });

  // A chart primitive outside its provider is the create that used to succeed
  // and then die on the page with `useChart must be used within a
  // <ChartContainer />`. See `PROVIDER_PAIRINGS` in `create-artifact.ts`.

  it("rejects a chart tooltip that is never wrapped in a ChartContainer", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: "function App(){ return <BarChart data={[]}><ChartTooltip content={<ChartTooltipContent />} /><Bar dataKey='n' /></BarChart>; }",
            title: "Broken chart",
          },
        });
        expect(result.isError).toBe(true);
        const text = textOf(result);
        expect(text).toContain("ChartTooltip");
        expect(text).toContain("ChartContainer");
        expect(store.calls).toEqual([]);
      },
      { artifacts: store.port },
    );
  });

  it("accepts the same chart once a ChartContainer wraps it", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: "function App(){ return <ChartContainer config={{ n: { label: 'N' } }} className='h-[240px] w-full'><BarChart data={[]}><ChartTooltip content={<ChartTooltipContent />} /><Bar dataKey='n' /></BarChart></ChartContainer>; }",
            title: "Working chart",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(store.calls).toHaveLength(1);
      },
      { artifacts: store.port },
    );
  });

  it("does not count a ChartContainer that only appears in a comment or a string", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: "// TODO: add a ChartContainer\nfunction App(){ return <ChartLegend content={<ChartLegendContent />} />; }",
            title: "Still broken",
          },
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("ChartContainer");
      },
      { artifacts: store.port },
    );
  });

  it("leaves a chart-free artifact alone, including one that merely mentions charts in prose", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: "function App(){ return <Card><CardContent>No ChartTooltipContent here, just prose.</CardContent></Card>; }",
            title: "Prose only",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(store.calls).toHaveLength(1);
      },
      { artifacts: store.port },
    );
  });

  // The smoke render: the host renders the component once before saving it, and
  // a first-render throw is refused with the real error. The renderer is
  // injected (see the `smokeRenderArtifact` config seam), so these tests supply
  // a stub and assert the WIRING — the real renderer's own behavior is covered
  // by `smoke-render.test.tsx` in `@executor-js/mcp-apps-shell`.

  it("refuses a create whose component throws on first render, quoting the error", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: { code: COUNTER_CODE, title: "Broken" },
        });
        expect(result.isError).toBe(true);
        const text = textOf(result);
        expect(text).toContain("useChart must be used within a <ChartContainer />");
        // The component stack is what turns the message into a fix.
        expect(text).toContain("ChartTooltipContent");
        // And the hint that names the state it rendered in.
        expect(text).toContain("pending");
        expect(store.calls).toEqual([]);
      },
      {
        artifacts: store.port,
        smokeRenderArtifact: () =>
          Promise.resolve({
            status: "failed" as const,
            message: "useChart must be used within a <ChartContainer />",
            componentStack: "\n    at ChartTooltipContent\n    at BarChart\n    at App",
          }),
      },
    );
  });

  it("saves when the smoke render succeeds", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: { code: COUNTER_CODE, title: "Fine" },
        });
        expect(result.isError).toBeFalsy();
        expect(store.calls).toHaveLength(1);
      },
      {
        artifacts: store.port,
        smokeRenderArtifact: () => Promise.resolve({ status: "ok" as const }),
      },
    );
  });

  it("smoke-renders an update too, so a tweak cannot break a working artifact", async () => {
    const store = makeArtifactStore();
    let failing = false;
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        await client.callTool({
          name: "create-artifact",
          arguments: { code: COUNTER_CODE, title: "Working" },
        });
        failing = true;
        const updated = await client.callTool({
          name: "create-artifact",
          arguments: { code: UPDATED_CODE, artifactId: "art_1" },
        });
        expect(updated.isError).toBe(true);
        // The stored row still holds the version that rendered.
        expect(store.rows.get("art_1")?.code).toBe(COUNTER_CODE);
      },
      {
        artifacts: store.port,
        smokeRenderArtifact: () =>
          Promise.resolve(
            failing ? { status: "failed" as const, message: "boom" } : { status: "ok" as const },
          ),
      },
    );
  });

  it("FAILS OPEN: a broken smoke renderer never blocks a valid create", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: { code: COUNTER_CODE, title: "Saved anyway" },
        });
        // The renderer itself is broken — a missing module, an environment gap
        // on some host. That is our defect, not the model's, and refusing a
        // perfectly good artifact over it would be the worse failure.
        expect(result.isError).toBeFalsy();
        expect(store.calls).toHaveLength(1);
      },
      {
        artifacts: store.port,
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: the seam is a plain Promise API, and this must fail the way a real failed dynamic import does
        smokeRenderArtifact: () => Promise.reject(new Error("Cannot find module ./smoke-render")),
      },
    );
  });

  it("saves without a smoke render at all when no renderer is configured", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: { code: COUNTER_CODE, title: "No renderer here" },
        });
        expect(result.isError).toBeFalsy();
        expect(store.calls).toHaveLength(1);
      },
      { artifacts: store.port },
    );
  });

  it("does not require a TooltipProvider, which the shell already supplies", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: "function App(){ return <Tooltip><TooltipTrigger>?</TooltipTrigger><TooltipContent>Help</TooltipContent></Tooltip>; }",
            title: "Tooltip",
          },
        });
        expect(result.isError).toBeFalsy();
      },
      { artifacts: store.port },
    );
  });
});

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

describe("MCP host — artifact retrieval", () => {
  it("round-trips: create-artifact saves, list-artifacts finds it, show-artifact returns the code", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        await client.callTool({
          name: "create-artifact",
          arguments: {
            code: COUNTER_CODE,
            title: "Active users dashboard",
            description: "DAU over time",
          },
        });

        const listed = await client.callTool({
          name: "list-artifacts",
          arguments: {},
        });
        expect(structuredOf(listed)).toMatchObject({
          artifacts: [
            {
              id: "art_1",
              title: "Active users dashboard",
              description: "DAU over time",
            },
          ],
        });
        // The text form is what a model without structured-output support reads.
        expect(textOf(listed)).toContain("Active users dashboard");

        const shown = await client.callTool({
          name: "show-artifact",
          arguments: { id: "art_1" },
        });
        expect(structuredOf(shown)).toEqual({
          code: COUNTER_CODE,
          artifactId: "art_1",
        });
      },
      { artifacts: store.port },
    );
  });

  it("delivers a saved artifact as a deep link to clients without apps support", async () => {
    const store = makeArtifactStore();
    await Effect.runPromise(
      store.port.save({
        title: "Saved earlier",
        description: null,
        code: COUNTER_CODE,
      }),
    );
    await withClient(
      makeStubEngine({}),
      NO_APPS_CAPS,
      async (client) => {
        const shown = await client.callTool({
          name: "show-artifact",
          arguments: { id: "art_1" },
        });
        expect(structuredOf(shown)).toEqual({
          status: "fallback_url",
          url: "https://executor.test/artifacts/art_1",
          artifactId: "art_1",
        });
      },
      {
        artifacts: store.port,
        artifactUrl: artifactUrlFor("https://executor.test"),
      },
    );
  });

  it("reports a miss as an error result rather than failing the tool call", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const shown = await client.callTool({
          name: "show-artifact",
          arguments: { id: "art_nope" },
        });
        expect(shown.isError).toBe(true);
        expect(structuredOf(shown)).toMatchObject({
          error: "artifact_not_found",
          id: "art_nope",
        });
        // The model is told how to recover.
        expect(textOf(shown)).toContain("list-artifacts");
      },
      { artifacts: store.port },
    );
  });

  it("lists nothing, without erroring, before anything is saved", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const listed = await client.callTool({
          name: "list-artifacts",
          arguments: {},
        });
        expect(listed.isError).toBeFalsy();
        expect(structuredOf(listed)).toEqual({ artifacts: [] });
        expect(textOf(listed)).toContain("No saved artifacts");
      },
      { artifacts: store.port },
    );
  });
});

// ---------------------------------------------------------------------------
// create-artifact — update in place
// ---------------------------------------------------------------------------
//
// The contract: a model tweaking an artifact calls the SAME tool with the
// artifact's id, and the stored row is replaced rather than a second artifact
// minted. The catalog stays three tools wide and the user's link keeps working.

describe("MCP host — create-artifact update in place", () => {
  it("replaces the code and title of an existing artifact instead of minting a copy", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const created = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: COUNTER_CODE,
            title: "Draft",
            description: "First pass",
          },
        });
        const artifactId = structuredOf(created).artifactId;
        expect(artifactId).toBe("art_1");

        const updated = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: UPDATED_CODE,
            title: "Active users dashboard",
            artifactId,
          },
        });
        expect(updated.isError).toBeFalsy();
        // Same id back, so the model (and the user's link) keeps addressing one
        // artifact.
        expect(structuredOf(updated)).toEqual({
          code: UPDATED_CODE,
          artifactId: "art_1",
        });

        const listed = await client.callTool({
          name: "list-artifacts",
          arguments: {},
        });
        expect(structuredOf(listed)).toMatchObject({
          artifacts: [
            {
              id: "art_1",
              title: "Active users dashboard",
              // An update that says nothing about the description keeps it.
              description: "First pass",
            },
          ],
        });
        // One artifact, not two.
        expect((structuredOf(listed).artifacts as readonly unknown[]).length).toBe(1);

        const shown = await client.callTool({
          name: "show-artifact",
          arguments: { id: "art_1" },
        });
        expect(structuredOf(shown)).toEqual({
          code: UPDATED_CODE,
          artifactId: "art_1",
        });
      },
      { artifacts: store.port },
    );
  });

  it("keeps the stored title when an update only changes the code", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        await client.callTool({
          name: "create-artifact",
          arguments: {
            code: COUNTER_CODE,
            title: "Domains",
            description: "Every domain",
          },
        });
        const updated = await client.callTool({
          name: "create-artifact",
          arguments: { code: UPDATED_CODE, artifactId: "art_1" },
        });
        expect(updated.isError).toBeFalsy();
        expect(store.rows.get("art_1")).toMatchObject({
          title: "Domains",
          description: "Every domain",
          code: UPDATED_CODE,
        });
      },
      { artifacts: store.port },
    );
  });

  it("requires a title when creating, since there is nothing to inherit", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: { code: COUNTER_CODE },
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("title is required");
        expect(store.calls).toEqual([]);
      },
      { artifacts: store.port },
    );
  });

  it("still validates the code on an update, and leaves the stored row untouched", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        await client.callTool({
          name: "create-artifact",
          arguments: { code: COUNTER_CODE, title: "Draft" },
        });
        const rejected = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: "function App(){ const Card = 1; return <div/>; }",
            artifactId: "art_1",
          },
        });
        expect(rejected.isError).toBe(true);
        expect(textOf(rejected)).toContain("cannot be redeclared");
        expect(store.rows.get("art_1")?.code).toBe(COUNTER_CODE);
        expect(store.calls.length).toBe(1);
      },
      { artifacts: store.port },
    );
  });

  it("refuses an artifact id that is not the caller's, without saying whether it exists", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: UPDATED_CODE,
            title: "Mine now",
            artifactId: "art_someone_else",
          },
        });
        expect(result.isError).toBe(true);
        // The same answer `execute-action` gives, so create-artifact cannot be
        // used to probe which ids exist.
        expect(structuredOf(result)).toMatchObject({
          error: "artifact_unavailable",
        });
        expect(store.calls).toEqual([]);
      },
      { artifacts: store.port },
    );
  });

  it("re-resolves bindings from the new code when an update adds an integration", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        await client.callTool({
          name: "create-artifact",
          arguments: { code: COUNTER_CODE, title: "Static" },
        });
        expect(store.calls[0]?.bindings).toEqual({});

        const updated = await client.callTool({
          name: "create-artifact",
          arguments: { code: VERCEL_ARTIFACT, artifactId: "art_1" },
        });
        expect(updated.isError).toBeFalsy();
        // The role the NEW code introduces is inferred and persisted; the old
        // (empty) binding set is not carried forward.
        expect(store.calls[1]?.bindings).toEqual({
          vercel: {
            integration: "vercel",
            owner: "user",
            connection: "personalVercel",
          },
        });
      },
      {
        artifacts: store.port,
        connections: connectionsPort([conn("vercel", "user", "personalVercel")]),
      },
    );
  });

  it("honours an explicit connections map on an update", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        await client.callTool({
          name: "create-artifact",
          arguments: { code: COUNTER_CODE, title: "Static" },
        });
        const updated = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: VERCEL_ARTIFACT,
            artifactId: "art_1",
            connections: { vercel: "vercel.org.teamVercel" },
          },
        });
        expect(updated.isError).toBeFalsy();
        expect(store.calls[1]?.bindings).toEqual({
          vercel: {
            integration: "vercel",
            owner: "org",
            connection: "teamVercel",
          },
        });
      },
      {
        artifacts: store.port,
        connections: connectionsPort([
          conn("vercel", "user", "personalVercel"),
          conn("vercel", "org", "teamVercel"),
        ]),
      },
    );
  });

  it("hands back the same deep link on an update, since the id is unchanged", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      NO_APPS_CAPS,
      async (client) => {
        await client.callTool({
          name: "create-artifact",
          arguments: { code: COUNTER_CODE, title: "Draft" },
        });
        const updated = await client.callTool({
          name: "create-artifact",
          arguments: { code: UPDATED_CODE, artifactId: "art_1" },
        });
        expect(structuredOf(updated)).toEqual({
          status: "fallback_url",
          url: "https://executor.test/artifacts/art_1",
          artifactId: "art_1",
        });
      },
      {
        artifacts: store.port,
        artifactUrl: artifactUrlFor("https://executor.test"),
      },
    );
  });
});

// ---------------------------------------------------------------------------
// create-artifact — connection binding
// ---------------------------------------------------------------------------
//
// The contract: artifact code names an integration, the server binds it to one
// of the author's connections at save time, and the resolved binding is what
// the artifact runs as later.

const VERCEL_ARTIFACT =
  "function App(){ const q = useQuery(tools.vercel.domains.getDomains.queryOptions({ limit: 100 })); return <div/>; }";

describe("MCP host — create-artifact binding", () => {
  it("binds an integration silently when the author has exactly one connection", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: { code: VERCEL_ARTIFACT, title: "Domains" },
        });
        expect(result.isError).toBeFalsy();
        expect(store.calls[0]?.bindings).toEqual({
          vercel: {
            integration: "vercel",
            owner: "user",
            connection: "personalVercel",
          },
        });
      },
      {
        artifacts: store.port,
        connections: connectionsPort([conn("vercel", "user", "personalVercel")]),
      },
    );
  });

  it("refuses an ambiguous integration and names the candidates", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: { code: VERCEL_ARTIFACT, title: "Domains" },
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("vercel.user.personalVercel");
        expect(textOf(result)).toContain("vercel.org.workspaceVercel");
        // Nothing was saved: an artifact that cannot bind cannot run.
        expect(store.calls).toEqual([]);
      },
      {
        artifacts: store.port,
        connections: connectionsPort([
          conn("vercel", "user", "personalVercel"),
          conn("vercel", "org", "workspaceVercel"),
        ]),
      },
    );
  });

  it("takes the supplied connections map over inference", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: VERCEL_ARTIFACT,
            title: "Domains",
            connections: { vercel: "vercel.org.workspaceVercel" },
          },
        });
        expect(result.isError).toBeFalsy();
        expect(store.calls[0]?.bindings).toEqual({
          vercel: {
            integration: "vercel",
            owner: "org",
            connection: "workspaceVercel",
          },
        });
      },
      {
        artifacts: store.port,
        connections: connectionsPort([
          conn("vercel", "user", "personalVercel"),
          conn("vercel", "org", "workspaceVercel"),
        ]),
      },
    );
  });

  it("binds two roles of one integration to different connections", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: `function App(){
              useQuery(tools.linear("prod").issues.list.queryOptions({}));
              useQuery(tools.linear("staging").issues.list.queryOptions({}));
              return <div/>;
            }`,
            title: "Issues",
            connections: {
              prod: "linear.org.linearProd",
              staging: "linear.user.myLinear",
            },
          },
        });
        expect(result.isError).toBeFalsy();
        expect(store.calls[0]?.bindings).toEqual({
          prod: {
            integration: "linear",
            owner: "org",
            connection: "linearProd",
          },
          staging: {
            integration: "linear",
            owner: "user",
            connection: "myLinear",
          },
        });
      },
      {
        artifacts: store.port,
        connections: connectionsPort([
          conn("linear", "org", "linearProd"),
          conn("linear", "user", "myLinear"),
        ]),
      },
    );
  });

  it("refuses a connections key naming a role the code never uses", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: VERCEL_ARTIFACT,
            title: "Domains",
            connections: { linear: "linear.org.linearProd" },
          },
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('role "linear"');
      },
      {
        artifacts: store.port,
        connections: connectionsPort([
          conn("vercel", "user", "personalVercel"),
          conn("linear", "org", "linearProd"),
        ]),
      },
    );
  });

  // The mistake a model that only read the `execute` skill will make: writing
  // discovery's five-segment address into artifact source.
  it("refuses artifact code that pins a connection into the path", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: "function App(){ useQuery(tools.vercel.user.personalVercel.domains.getDomains.queryOptions({})); return <div/>; }",
            title: "Domains",
          },
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("tools.vercel.<tool>(args)");
        expect(store.calls).toEqual([]);
      },
      {
        artifacts: store.port,
        connections: connectionsPort([conn("vercel", "user", "personalVercel")]),
      },
    );
  });
});

// ---------------------------------------------------------------------------
// execute-action — binding resolution
// ---------------------------------------------------------------------------

describe("MCP host — execute-action binding resolution", () => {
  /** Saves a bound artifact, then runs one call from it and reports both the
   *  tool result and whatever code actually reached the engine. */
  const runBoundAction = async (input: {
    readonly code: string;
    readonly available: readonly BindableConnection[];
    readonly connections?: Record<string, string>;
    readonly action: Record<string, unknown>;
    readonly artifactIdOverride?: string;
  }) => {
    const store = makeArtifactStore();
    const executed: string[] = [];
    const engine = makeStubEngine({
      executeWithPause: (code: string) =>
        Effect.sync(() => {
          executed.push(code);
          return { status: "completed", result: { result: "ok" } };
        }),
    });

    let result: Awaited<ReturnType<Client["callTool"]>> | undefined;
    await withClient(
      engine,
      APPS_CAPS,
      async (client) => {
        const created = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: input.code,
            title: "Bound",
            ...(input.connections === undefined ? {} : { connections: input.connections }),
          },
        });
        expect(created.isError, textOf(created)).toBeFalsy();
        const artifactId = input.artifactIdOverride ?? String(structuredOf(created).artifactId);
        result = await client.callTool({
          name: "execute-action",
          arguments: { ...input.action, artifactId },
        });
      },
      { artifacts: store.port, connections: connectionsPort(input.available) },
    );
    return { result: result!, executed };
  };

  it("expands a short path through the artifact's binding", async () => {
    const { result, executed } = await runBoundAction({
      code: VERCEL_ARTIFACT,
      available: [conn("vercel", "user", "personalVercel")],
      action: {
        code: 'return await tools.vercel.domains.getDomains({"limit":100})',
      },
    });
    expect(result.isError).toBeFalsy();
    expect(executed).toEqual([
      'return await tools.vercel.user.personalVercel.domains.getDomains({"limit":100})',
    ]);
  });

  it("routes each role to its own connection", async () => {
    const roleCode = `function App(){
      useQuery(tools.linear("prod").issues.list.queryOptions({}));
      useQuery(tools.linear("staging").issues.list.queryOptions({}));
      return <div/>;
    }`;
    const available = [conn("linear", "org", "linearProd"), conn("linear", "user", "myLinear")];
    const connections = {
      prod: "linear.org.linearProd",
      staging: "linear.user.myLinear",
    };

    const prod = await runBoundAction({
      code: roleCode,
      available,
      connections,
      action: { code: 'return await tools.linear("prod").issues.list({})' },
    });
    expect(prod.executed).toEqual(["return await tools.linear.org.linearProd.issues.list({})"]);

    const staging = await runBoundAction({
      code: roleCode,
      available,
      connections,
      action: { code: 'return await tools.linear("staging").issues.list({})' },
    });
    expect(staging.executed).toEqual(["return await tools.linear.user.myLinear.issues.list({})"]);
  });

  it("fails with binding_unresolved and candidates when a role is not bound", async () => {
    const { result, executed } = await runBoundAction({
      code: VERCEL_ARTIFACT,
      available: [conn("vercel", "user", "personalVercel"), conn("linear", "org", "linearProd")],
      action: { code: "return await tools.linear.issues.list({})" },
    });
    expect(result.isError).toBe(true);
    expect(structuredOf(result)).toMatchObject({
      error: "binding_unresolved",
      role: "linear",
      integration: "linear",
      candidates: ["linear.org.linearProd"],
    });
    expect(textOf(result)).toContain("linear.org.linearProd");
    // Nothing unresolvable ever reaches the engine.
    expect(executed).toEqual([]);
  });

  it("refuses an artifact id that is not the caller's", async () => {
    const { result, executed } = await runBoundAction({
      code: VERCEL_ARTIFACT,
      available: [conn("vercel", "user", "personalVercel")],
      action: {
        code: 'return await tools.vercel.domains.getDomains({"limit":100})',
      },
      artifactIdOverride: "art_someone_else",
    });
    expect(result.isError).toBe(true);
    expect(structuredOf(result)).toMatchObject({
      error: "artifact_unavailable",
    });
    expect(executed).toEqual([]);
  });

  // An iframe cannot recover the old freedom by writing a full address itself:
  // a bound artifact resolves every call through its bindings, and a
  // five-segment path names a role it has none for.
  it("refuses a full address smuggled from a bound artifact", async () => {
    const { result, executed } = await runBoundAction({
      code: VERCEL_ARTIFACT,
      available: [conn("vercel", "user", "personalVercel"), conn("stripe", "org", "acme")],
      action: { code: "return await tools.stripe.org.acme.charges.list({})" },
    });
    expect(result.isError).toBe(true);
    expect(structuredOf(result)).toMatchObject({ error: "binding_unresolved" });
    expect(executed).toEqual([]);
  });

  // Grandfathering: artifacts saved before this contract have `bindings: null`
  // and full addresses in their stored source. They keep working.
  it("executes a pre-binding artifact's full address as written", async () => {
    const store = makeArtifactStore();
    const executed: string[] = [];
    const engine = makeStubEngine({
      executeWithPause: (code: string) =>
        Effect.sync(() => {
          executed.push(code);
          return { status: "completed", result: { result: "ok" } };
        }),
    });

    await withClient(
      engine,
      APPS_CAPS,
      async (client) => {
        // Written straight into the store, the way a row saved before the
        // bindings column existed looks after the migration.
        const legacy: Artifact = {
          id: ArtifactId.make("art_legacy"),
          owner: "user",
          title: "Legacy",
          description: null,
          code: "function App(){ useQuery(tools.inventory.org.main.listItems.queryOptions({})); return <div/>; }",
          bindings: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
        store.rows.set(legacy.id, legacy);

        const result = await client.callTool({
          name: "execute-action",
          arguments: {
            code: "return await tools.inventory.org.main.listItems({})",
            artifactId: "art_legacy",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(executed).toEqual(["return await tools.inventory.org.main.listItems({})"]);
      },
      { artifacts: store.port, connections: connectionsPort([]) },
    );
  });
});

// ---------------------------------------------------------------------------
// execute-action — shell-owned approval
// ---------------------------------------------------------------------------

describe("MCP host — execute-action", () => {
  // The pin that matters: the shell renders the approval modal itself, in its
  // trusted outer frame. A browser approval URL would be unusable from inside a
  // widget, so `execute-action` must return the resolvable pause payload even
  // when the session's elicitation mode is `browser`.
  it("pauses for shell-owned approval instead of a browser approval URL", async () => {
    const store = makeArtifactStore();
    const engine = makeStubEngine({
      executeWithPause: () => Effect.succeed(makePausedResult("exec_app", "Approve UI action?")),
      resume: (executionId, response) =>
        Effect.succeed(
          executionId === "exec_app"
            ? {
                status: "completed",
                result: { result: `action:${response.action}` },
              }
            : null,
        ),
    });

    await withClient(
      engine,
      APPS_CAPS,
      async (client) => {
        const created = await client.callTool({
          name: "create-artifact",
          arguments: {
            code: "function App(){ useMutation(tools.github.issues.create.mutationOptions({})); return <div/>; }",
            title: "Issues",
          },
        });
        const paused = await client.callTool({
          name: "execute-action",
          arguments: {
            code: "return await tools.github.issues.create({})",
            artifactId: String(structuredOf(created).artifactId),
          },
        });
        expect(paused.structuredContent).toMatchObject({
          status: "waiting_for_interaction",
          executionId: "exec_app",
          interaction: { message: "Approve UI action?" },
        });
        expect(textOf(paused)).not.toContain("executor.test/resume");

        const resumed = await client.callTool({
          name: "execute-action-resume",
          arguments: {
            executionId: "exec_app",
            action: "accept",
            content: "{}",
          },
        });
        expect(resumed.content).toEqual([{ type: "text", text: "action:accept" }]);
      },
      {
        artifacts: store.port,
        connections: connectionsPort([conn("github", "user", "personalGithub")]),
        elicitationMode: {
          mode: "browser",
          approvalUrl: (executionId) => `https://executor.test/resume/${executionId}`,
        },
      },
    );
  });

  // The app channel is as narrow as the surface above it. The shell can only
  // ever emit `return await tools.<path>(<json>)`, so that is all the server
  // accepts — an iframe posting anything wider is refused before it reaches the
  // engine, even though no affordance in the shell writes arbitrary code.
  it("refuses anything that is not a single proxy-shaped tool call", async () => {
    const store = makeArtifactStore();
    const executed: string[] = [];
    const engine = makeStubEngine({
      executeWithPause: (code: string) =>
        Effect.sync(() => {
          executed.push(code);
          return { status: "completed", result: { result: "ok" } };
        }),
    });

    await withClient(
      engine,
      APPS_CAPS,
      async (client) => {
        const smuggled = [
          "let all = []; for (let i = 0; i < 40; i++) { all.push(await tools.a.b({ page: i })) } return all",
          "const me = await tools.github.users.me(); return await tools.github.issues.create({ assignee: me.login })",
          "return await fetch('https://evil.example')",
          "return await tools.a.b({}) ; return await tools.c.d({})",
          "return 42",
        ];

        for (const code of smuggled) {
          const rejected = await client.callTool({
            name: "execute-action",
            arguments: { code },
          });
          expect(rejected.isError, code).toBe(true);
          expect(textOf(rejected)).toContain("execute-action accepts a single tool call");
          expect(structuredOf(rejected)).toMatchObject({
            error: "invalid_action_code",
          });
        }

        // Nothing rejected ever reached the engine.
        expect(executed).toEqual([]);

        // …and the shape the proxy actually emits still runs.
        const allowed = await client.callTool({
          name: "execute-action",
          arguments: {
            code: 'return await tools.inventory.org.main.createItem({"body":{"name":"Widget"}})',
          },
        });
        expect(allowed.isError).toBeFalsy();
        expect(executed).toEqual([
          'return await tools.inventory.org.main.createItem({"body":{"name":"Widget"}})',
        ]);
      },
      { artifacts: store.port },
    );
  });
});

// ---------------------------------------------------------------------------
// Deep-link shape
// ---------------------------------------------------------------------------

describe("artifactUrlFor", () => {
  it("builds /artifacts/:id against the host's origin", () => {
    expect(artifactUrlFor("https://executor.sh")("art_123")).toBe(
      "https://executor.sh/artifacts/art_123",
    );
  });

  it("ignores any path on the configured base and escapes the id", () => {
    expect(artifactUrlFor("http://localhost:4788/")("art/../x")).toBe(
      "http://localhost:4788/artifacts/art%2F..%2Fx",
    );
  });

  // An org-scoped host must name the org in the link. A bare path resolves
  // against whatever org the browser was last in, which is the wrong artifact
  // page — or none — as soon as the user belongs to two.
  it("pins the link to the org slug when the host knows one", () => {
    expect(artifactUrlFor("https://executor.sh", "acme")("art_123")).toBe(
      "https://executor.sh/acme/artifacts/art_123",
    );
  });

  it("escapes the slug, and stays bare for hosts with no org scope", () => {
    expect(artifactUrlFor("https://executor.sh", "a/b")("art_1")).toBe(
      "https://executor.sh/a%2Fb/artifacts/art_1",
    );
    for (const slug of [undefined, null, ""]) {
      expect(artifactUrlFor("https://executor.sh", slug)("art_1")).toBe(
        "https://executor.sh/artifacts/art_1",
      );
    }
  });
});
