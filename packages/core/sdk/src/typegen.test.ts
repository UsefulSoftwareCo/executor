// ---------------------------------------------------------------------------
// generateToolProxySource: the `executor generate` backend.
//
// Covered here:
//   - the generated source is valid strict TypeScript (checked with the real
//     compiler) and its types reject wrong inputs,
//   - the generated runtime client invokes tools through /api/executions and
//     unwraps completed/paused/error responses (transpiled and imported, run
//     against a fake fetch),
//   - naming: hyphenated tool names, colliding sanitized names, description
//     text that tries to escape its JSDoc comment,
//   - resilience: a schema the compiler rejects degrades that one tool to
//     `unknown` without poisoning its chunk,
//   - `executor.tools.export` (the data source): schemas + trimmed shared
//     $defs per connection, policy-filtered, static tools flagged.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as ts from "typescript";

import { AuthTemplateSlug, ConnectionName, IntegrationSlug, ToolAddress, ToolName } from "./ids";
import { definePlugin } from "./plugin";
import { makeTestExecutor, memoryCredentialsPlugin } from "./testing";
import { generateToolProxySource } from "./typegen";
import type { ToolCatalogExport } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const typecheck = (source: string, extraSource = ""): readonly string[] => {
  const fileName = "generated.ts";
  const fullSource = extraSource.length > 0 ? `${source}\n${extraSource}` : source;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) =>
    candidate === fileName
      ? ts.createSourceFile(candidate, fullSource, languageVersion, true)
      : originalGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);
  host.readFile = (candidate) =>
    candidate === fileName ? fullSource : originalReadFile(candidate);
  host.fileExists = (candidate) => candidate === fileName || originalFileExists(candidate);

  const program = ts.createProgram([fileName], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    const position =
      diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : null;
    return position
      ? `${diagnostic.file!.fileName}:${position.line + 1}:${position.character + 1} ${message}`
      : message;
  });
};

/** Transpile the generated TypeScript and import it as a real module. */
const importGenerated = async (source: string): Promise<Record<string, unknown>> => {
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  const dir = mkdtempSync(join(tmpdir(), "executor-typegen-"));
  const file = join(dir, "generated.mjs");
  writeFileSync(file, transpiled);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: temp-dir cleanup around a dynamic import of the generated module
  try {
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

type ConnectionExport = ToolCatalogExport["connections"][number];
type ToolExport = ConnectionExport["tools"][number];

const catalog = (connections: readonly ConnectionExport[]): ToolCatalogExport => ({ connections });

const connectionExport = (input: {
  owner: "org" | "user";
  integration: string;
  connection: string;
  definitions?: Record<string, unknown>;
  tools: ReadonlyArray<{
    address: string;
    name: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    static?: boolean;
  }>;
}): ConnectionExport => ({
  owner: input.owner,
  integration: IntegrationSlug.make(input.integration),
  connection: ConnectionName.make(input.connection),
  ...(input.definitions !== undefined ? { definitions: input.definitions } : {}),
  tools: input.tools.map(
    (tool): ToolExport => ({
      ...tool,
      address: ToolAddress.make(tool.address),
    }),
  ),
});

const githubConnection = connectionExport({
  owner: "org",
  integration: "github",
  connection: "main",
  definitions: {
    User: {
      type: "object",
      properties: { id: { type: "string" }, login: { type: "string" } },
      required: ["id"],
    },
  },
  tools: [
    {
      address: "tools.github.org.main.issues.create",
      name: "issues.create",
      description: "Create an issue",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, assignee: { $ref: "#/$defs/User" } },
        required: ["title"],
      },
      outputSchema: {
        type: "object",
        properties: { number: { type: "number" }, user: { $ref: "#/$defs/User" } },
      },
    },
    {
      address: "tools.github.org.main.issues.list",
      name: "issues.list",
      description: "List issues */ } escape attempt",
      inputSchema: {
        type: "object",
        properties: { state: { enum: ["open", "closed"] } },
      },
    },
    {
      address: "tools.github.org.main.repos.get",
      name: "repos.get",
      description: "No schemas at all",
    },
  ],
});

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

describe("generateToolProxySource", { timeout: 60_000 }, () => {
  it("emits strict-TypeScript-valid source with per-tool types", () => {
    const generated = generateToolProxySource(catalog([githubConnection]));
    expect(generated.toolCount).toBe(3);
    expect(generated.connectionCount).toBe(1);

    const diagnostics = typecheck(generated.source);
    expect(diagnostics).toEqual([]);

    expect(generated.source).toContain("export interface ExecutorTools");
    expect(generated.source).toContain("issues_create_Input");
    // Shared $defs become named, reused types instead of inlined copies.
    expect(generated.source).toContain("export type User =");
  });

  it("generated types accept correct calls and reject wrong ones", () => {
    const generated = generateToolProxySource(catalog([githubConnection]));

    const validConsumer = `
      const client = createExecutorClient({ baseUrl: "http://localhost:4788" });
      async function main() {
        const created = await client.github.org.main.issues.create({ title: "hi" });
        if (created.ok) {
          const n: number | undefined = created.data.number;
          void n;
        } else {
          const code: string = created.error.code;
          void code;
        }
        await client.github.org.main.repos.get();
        await client.$call("github.org.main.repos.get", {});
      }
      void main;
    `;
    expect(typecheck(generated.source, validConsumer)).toEqual([]);

    const invalidConsumer = `
      const client = createExecutorClient();
      async function main() {
        // title is required and must be a string
        await client.github.org.main.issues.create({ title: 42 });
      }
      void main;
    `;
    expect(typecheck(generated.source, invalidConsumer)).not.toEqual([]);
  });

  it("keeps hyphenated path segments callable and dedupes colliding type names", () => {
    const generated = generateToolProxySource(
      catalog([
        connectionExport({
          owner: "user",
          integration: "linear",
          connection: "personal",
          tools: [
            {
              address: "tools.linear.user.personal.issue-create",
              name: "issue-create",
              inputSchema: { type: "object", properties: { title: { type: "string" } } },
            },
            {
              // Sanitizes to the same identifier as issue-create.
              address: "tools.linear.user.personal.issue_create",
              name: "issue_create",
              inputSchema: { type: "object", properties: { key: { type: "string" } } },
            },
          ],
        }),
      ]),
    );

    expect(typecheck(generated.source)).toEqual([]);
    expect(generated.source).toContain('"issue-create":');
    // Both tools keep distinct input types despite the name collision.
    expect(generated.source).toContain("issue_create_Input");
    expect(generated.source).toContain("issue_create_Input_2");
  });

  it("degrades a compiler-rejected schema to unknown without poisoning its chunk", () => {
    const generated = generateToolProxySource(
      catalog([
        connectionExport({
          owner: "org",
          integration: "demo",
          connection: "main",
          tools: [
            {
              address: "tools.demo.org.main.good",
              name: "good",
              inputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
            },
            {
              address: "tools.demo.org.main.broken",
              name: "broken",
              // $ref to a definition that does not exist: the vendored
              // compiler throws on dangling refs.
              inputSchema: { $ref: "#/$defs/DoesNotExist" },
            },
          ],
        }),
      ]),
      { chunkSize: 50 },
    );

    expect(typecheck(generated.source)).toEqual([]);
    // The good tool keeps its real type; the broken one degrades to unknown.
    expect(generated.source).toContain("good_Input = { ok?: boolean; }");
    expect(generated.source).toContain("broken_Input = unknown");
  });

  it("returns an empty interface for an empty catalog", () => {
    const generated = generateToolProxySource(catalog([]));
    expect(generated.toolCount).toBe(0);
    expect(typecheck(generated.source)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Generated runtime client
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init: { headers: Record<string, string>; body: string } };

const makeFakeFetch = (respond: (call: FetchCall) => unknown) => {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (url, init) => {
    const call: FetchCall = {
      url: String(url),
      init: {
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      },
    };
    calls.push(call);
    return new Response(JSON.stringify(respond(call)), { status: 200 });
  };
  return { calls, fetchImpl };
};

describe("generated runtime client", { timeout: 60_000 }, () => {
  it("invokes tools through /api/tools/invoke and unwraps the outcome", async () => {
    const generated = generateToolProxySource(catalog([githubConnection]));
    const module = await importGenerated(generated.source);
    const createClient = module.createExecutorClient as (
      options: Record<string, unknown>,
    ) => unknown;

    const { calls, fetchImpl } = makeFakeFetch(() => ({ ok: true, data: { number: 7 } }));

    // oxlint-disable-next-line executor/no-double-cast -- test boundary: the client is a dynamically imported Proxy; the cast pins the path this test dials
    const client = createClient({
      baseUrl: "http://example.test:4788/",
      token: "tok_123",
      fetch: fetchImpl,
    }) as unknown as {
      github: {
        org: {
          main: {
            issues: { create: (input: unknown) => Promise<{ ok: boolean; data?: unknown }> };
          };
        };
      };
    };

    const outcome = await client.github.org.main.issues.create({ title: "hi" });
    expect(outcome).toEqual({ ok: true, data: { number: 7 } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `http://example.test:4788/api/tools/invoke/${encodeURIComponent("github.org.main.issues.create")}`,
    );
    expect(calls[0]!.init.headers.authorization).toBe("Bearer tok_123");
    expect(calls[0]!.init.body).toBe('{"title":"hi"}');
  });

  it("throws ExecutorPausedError with the approval url on paused executions", async () => {
    const generated = generateToolProxySource(catalog([githubConnection]));
    const module = await importGenerated(generated.source);
    const createClient = module.createExecutorClient as (options: Record<string, unknown>) => {
      $call: (path: string, input?: unknown) => Promise<unknown>;
    };

    const { fetchImpl } = makeFakeFetch(() => ({
      ok: false,
      error: {
        code: "execution_paused",
        message: "Approval required",
        executionId: "exec_42",
        resumePath: "/executions/exec_42/resume",
      },
    }));

    const client = createClient({ baseUrl: "http://example.test:4788", fetch: fetchImpl });
    const failure = await client.$call("github.org.main.issues.create", { title: "hi" }).then(
      () => null,
      (error: unknown) => error as Record<string, unknown>,
    );

    expect(failure).not.toBeNull();
    expect(failure!.name).toBe("ExecutorPausedError");
    expect(failure!.executionId).toBe("exec_42");
    expect(failure!.approvalUrl).toBe("http://example.test:4788/resume/exec_42");
  });

  it("rejects path segments that could break out of the invoke code", async () => {
    const generated = generateToolProxySource(catalog([githubConnection]));
    const module = await importGenerated(generated.source);
    const createClient = module.createExecutorClient as (options: Record<string, unknown>) => {
      $call: (path: string, input?: unknown) => Promise<unknown>;
    };

    const { calls, fetchImpl } = makeFakeFetch(() => ({}));
    const client = createClient({ fetch: fetchImpl });

    await expect(client.$call('bad"segment];evil()', {})).rejects.toMatchObject({
      name: "ExecutorRequestError",
    });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// executor.tools.export: the catalog read behind the CLI
// ---------------------------------------------------------------------------

const INTEG = IntegrationSlug.make("demo");
const CONN = ConnectionName.make("main");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

const demoPlugin = definePlugin(() => ({
  id: "demo" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [
        {
          name: ToolName.make("inspect"),
          description: "inspect",
          inputSchema: {
            type: "object",
            properties: { pet: { $ref: "#/$defs/Pet" } },
            required: ["pet"],
          },
          outputSchema: { $ref: "#/$defs/Owner" },
        },
        { name: ToolName.make("run"), description: "run" },
      ],
      definitions: {
        Pet: { type: "object", properties: { name: { type: "string" } } },
        Owner: { type: "object", properties: { pet: { $ref: "#/$defs/Pet" } } },
        Unreferenced: { type: "object", properties: { value: { type: "string" } } },
      },
    }),
  invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "Demo",
        config: {},
      }),
  }),
}))();

const setup = () =>
  Effect.gen(function* () {
    const executor = yield* makeTestExecutor({
      plugins: [memoryCredentialsPlugin(), demoPlugin] as const,
    });
    yield* executor.demo.seed();
    yield* executor.connections.create({
      owner: "org",
      name: CONN,
      integration: INTEG,
      template: TEMPLATE,
      value: "token",
    });
    return executor;
  });

describe("tools.export", { timeout: 60_000 }, () => {
  it.effect("returns schemas grouped per connection with trimmed shared $defs", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      const exported = yield* executor.tools.export({ integration: INTEG });

      expect(exported.connections).toHaveLength(1);
      const connection = exported.connections[0]!;
      expect(String(connection.integration)).toBe("demo");
      expect(String(connection.connection)).toBe("main");
      expect(connection.tools.map((tool) => tool.name).sort()).toEqual(["inspect", "run"]);

      const inspect = connection.tools.find((tool) => tool.name === "inspect")!;
      expect(inspect.inputSchema).toMatchObject({ type: "object" });
      expect(inspect.outputSchema).toEqual({ $ref: "#/$defs/Owner" });

      // Referenced defs (Pet transitively via Owner) come along; unreferenced
      // ones are trimmed.
      expect(Object.keys(connection.definitions ?? {}).sort()).toEqual(["Owner", "Pet"]);
    }),
  );

  it.effect("omits blocked tools like tools.list does", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.policies.create({
        owner: "org",
        pattern: "demo.org.main.run",
        action: "block",
      });

      const exported = yield* executor.tools.export({ integration: INTEG });
      const names = exported.connections.flatMap((connection) =>
        connection.tools.map((tool) => tool.name),
      );
      expect(names).toEqual(["inspect"]);
    }),
  );

  it.effect("flags static tools and feeds a generatable catalog end to end", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [memoryCredentialsPlugin(), demoPlugin] as const,
        coreTools: { webBaseUrl: "http://localhost:3000" },
      });
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        value: "token",
      });
      const exported = yield* executor.tools.export({ includeBlocked: true });

      const staticTools = exported.connections
        .flatMap((connection) => connection.tools)
        .filter((tool) => tool.static === true);
      expect(staticTools.length).toBeGreaterThan(0);

      const generated = generateToolProxySource(exported);
      expect(generated.toolCount).toBeGreaterThanOrEqual(2);
      expect(typecheck(generated.source)).toEqual([]);
    }),
  );
});
