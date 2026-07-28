import { describe, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type * as Cause from "effect/Cause";

import { ArtifactId, FormElicitation, type Artifact, type ArtifactSummary } from "@executor-js/sdk";
import type { ExecutionEngine, ExecutionResult } from "@executor-js/execution";

import { MCP_APPS_SHELL_RESOURCE_URI, artifactUrlFor } from "./render-ui";
import { createExecutorMcpServer, type ExecutorMcpServerConfig } from "./tool-server";

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
  const calls: Array<{ title: string; description: string | null; code: string }> = [];
  return {
    calls,
    rows,
    port: {
      list: (): Effect.Effect<readonly ArtifactSummary[]> =>
        Effect.sync(() =>
          [...rows.values()]
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
            .map(({ code: _code, ...summary }) => summary),
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
      }): Effect.Effect<Artifact, TestArtifactError> =>
        Effect.suspend(() => {
          calls.push({
            title: input.title,
            description: input.description ?? null,
            code: input.code,
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
        expect(names).toContain("render-ui");
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
        expect(names).toContain("render-ui");
        expect(names).toContain("execute-action");
        expect(names).toContain("execute-action-resume");
      },
      { artifacts: store.port },
    );
  });

  it("registers no ui tools at all when no shell loader is configured", async () => {
    const store = makeArtifactStore();
    const mcpServer = await Effect.runPromise(
      createExecutorMcpServer({ engine: makeStubEngine({}), artifacts: store.port }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("execute");
    expect(names).not.toContain("render-ui");
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
        const read = await client.readResource({ uri: MCP_APPS_SHELL_RESOURCE_URI });
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
// render-ui delivery
// ---------------------------------------------------------------------------

describe("MCP host — render-ui", () => {
  it("returns the code inline and persists it when the client renders apps", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "render-ui",
          arguments: {
            code: COUNTER_CODE,
            title: "Active users dashboard",
            description: "Daily active users over time",
          },
        });
        expect(structuredOf(result)).toEqual({ code: COUNTER_CODE, artifactId: "art_1" });
        expect(result.isError).toBeFalsy();
        expect(store.calls).toEqual([
          {
            title: "Active users dashboard",
            description: "Daily active users over time",
            code: COUNTER_CODE,
          },
        ]);
      },
      { artifacts: store.port, artifactUrl: artifactUrlFor("https://executor.test") },
    );
  });

  it("returns a deep link and still persists when the client cannot render apps", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      NO_APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "render-ui",
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
      { artifacts: store.port, artifactUrl: artifactUrlFor("https://executor.test") },
    );
  });

  it("still persists and reports the id when no web UI is configured", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      NO_APPS_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "render-ui",
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
          name: "render-ui",
          arguments: {
            code: "const { useState } = React; function App(){ return null; }",
            title: "Bad",
          },
        });
        expect(destructured.isError).toBe(true);
        expect(textOf(destructured)).toContain("Do not destructure React");

        const shadowed = await client.callTool({
          name: "render-ui",
          arguments: { code: "const Card = 1; function App(){ return null; }", title: "Bad" },
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
          name: "render-ui",
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
          name: "render-ui",
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

  it("allows display constants that the dropped data heuristic used to reject", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        // The donor branch rejected this on the variable name alone. Legit
        // chart configuration is not a hardcoded live-data snapshot.
        const result = await client.callTool({
          name: "render-ui",
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
});

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

describe("MCP host — artifact retrieval", () => {
  it("round-trips: render-ui saves, list-artifacts finds it, show-artifact returns the code", async () => {
    const store = makeArtifactStore();
    await withClient(
      makeStubEngine({}),
      APPS_CAPS,
      async (client) => {
        await client.callTool({
          name: "render-ui",
          arguments: {
            code: COUNTER_CODE,
            title: "Active users dashboard",
            description: "DAU over time",
          },
        });

        const listed = await client.callTool({ name: "list-artifacts", arguments: {} });
        expect(structuredOf(listed)).toMatchObject({
          artifacts: [
            { id: "art_1", title: "Active users dashboard", description: "DAU over time" },
          ],
        });
        // The text form is what a model without structured-output support reads.
        expect(textOf(listed)).toContain("Active users dashboard");

        const shown = await client.callTool({
          name: "show-artifact",
          arguments: { id: "art_1" },
        });
        expect(structuredOf(shown)).toEqual({ code: COUNTER_CODE, artifactId: "art_1" });
      },
      { artifacts: store.port },
    );
  });

  it("delivers a saved artifact as a deep link to clients without apps support", async () => {
    const store = makeArtifactStore();
    await Effect.runPromise(
      store.port.save({ title: "Saved earlier", description: null, code: COUNTER_CODE }),
    );
    await withClient(
      makeStubEngine({}),
      NO_APPS_CAPS,
      async (client) => {
        const shown = await client.callTool({ name: "show-artifact", arguments: { id: "art_1" } });
        expect(structuredOf(shown)).toEqual({
          status: "fallback_url",
          url: "https://executor.test/artifacts/art_1",
          artifactId: "art_1",
        });
      },
      { artifacts: store.port, artifactUrl: artifactUrlFor("https://executor.test") },
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
        expect(structuredOf(shown)).toMatchObject({ error: "artifact_not_found", id: "art_nope" });
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
        const listed = await client.callTool({ name: "list-artifacts", arguments: {} });
        expect(listed.isError).toBeFalsy();
        expect(structuredOf(listed)).toEqual({ artifacts: [] });
        expect(textOf(listed)).toContain("No saved artifacts");
      },
      { artifacts: store.port },
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
            ? { status: "completed", result: { result: `action:${response.action}` } }
            : null,
        ),
    });

    await withClient(
      engine,
      APPS_CAPS,
      async (client) => {
        const paused = await client.callTool({
          name: "execute-action",
          arguments: { code: "return await tools.github.issues.create({})" },
        });
        expect(paused.structuredContent).toMatchObject({
          status: "waiting_for_interaction",
          executionId: "exec_app",
          interaction: { message: "Approve UI action?" },
        });
        expect(textOf(paused)).not.toContain("executor.test/resume");

        const resumed = await client.callTool({
          name: "execute-action-resume",
          arguments: { executionId: "exec_app", action: "accept", content: "{}" },
        });
        expect(resumed.content).toEqual([{ type: "text", text: "action:accept" }]);
      },
      {
        artifacts: store.port,
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
          expect(structuredOf(rejected)).toMatchObject({ error: "invalid_action_code" });
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
});
