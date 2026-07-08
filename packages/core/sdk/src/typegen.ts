// ---------------------------------------------------------------------------
// Typed tool proxy generation: the `executor generate` backend.
//
// Turns a `ToolCatalogExport` (every visible tool's input/output JSON schema,
// grouped per connection with the connection's shared `$defs`) into ONE
// self-contained TypeScript source file:
//
//   - a dependency-free runtime client (Proxy-based, so its size is constant
//     no matter how many tools the catalog holds) that invokes tools through
//     the server's `/api/executions` endpoint,
//   - one non-instantiated (type-only, erasable) namespace per connection
//     carrying that connection's shared definitions and per-tool input/output
//     types,
//   - an `ExecutorTools` interface mirroring the sandbox `tools.*` path tree,
//     so `client.github.org.main.issues.create({...})` is fully typed.
//
// Scale is a first-class constraint: catalogs reach 10k+ tools. Schemas are
// compiled through `compileToolChunkTypeScript` (many tools per compiler pass;
// one pass per `chunkSize` tools) because per-tool passes pay fixed overhead
// 10k times and one whole-catalog pass grows super-linearly with declaration
// count. All source assembly appends to arrays and joins once.
// ---------------------------------------------------------------------------

import {
  compileToolChunkTypeScript,
  type ToolChunkSchemaEntry,
  type ToolChunkTypeScriptEntry,
} from "./schema-types";
import type { ToolCatalogConnectionExport, ToolCatalogExport } from "./types";

export type GenerateToolProxyOptions = {
  /** Tools compiled per compiler pass. The pass cost grows super-linearly
   *  with declaration count, so keep chunks small; 200 keeps each pass tens
   *  of milliseconds while amortizing per-pass overhead. */
  readonly chunkSize?: number;
  /** Client factory name in the generated file. */
  readonly clientName?: string;
};

const DEFAULT_CHUNK_SIZE = 200;

// ---------------------------------------------------------------------------
// Identifier helpers
// ---------------------------------------------------------------------------

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const sanitizeIdentifier = (value: string): string => {
  const cleaned = value.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned.length > 0 ? cleaned : "_";
};

const propertyKey = (segment: string): string =>
  IDENTIFIER_PATTERN.test(segment) ? segment : JSON.stringify(segment);

const uniqueName = (base: string, used: Set<string>): string => {
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
};

const escapeJsDoc = (value: string): string => value.replace(/\*\//g, "*\\/");

// ---------------------------------------------------------------------------
// Per-connection compilation
// ---------------------------------------------------------------------------

type CompiledTool = {
  readonly pathSegments: readonly string[];
  readonly description?: string;
  /** Fully-qualified type reference (`Ns.Name_Input`) or undefined when the
   *  tool has no input schema (callable with no argument). */
  readonly inputTypeRef?: string;
  /** Fully-qualified type reference or "unknown". */
  readonly outputTypeRef: string;
};

type CompiledConnection = {
  readonly namespaceName: string;
  /** `export type Name = body;` lines inside the namespace. */
  readonly declarations: readonly string[];
  readonly tools: readonly CompiledTool[];
};

/** Sandbox `tools.*` path for a tool: dynamic addresses drop the `tools.`
 *  proxy-root prefix; static addresses are already the callable path. */
const toolPathSegments = (
  connection: ToolCatalogConnectionExport,
  tool: ToolCatalogConnectionExport["tools"][number],
): readonly string[] => {
  const address = String(tool.address);
  const path = address.startsWith("tools.") ? address.slice("tools.".length) : address;
  return path.split(".");
};

const compileConnection = (
  connection: ToolCatalogConnectionExport,
  namespaceName: string,
  chunkSize: number,
): CompiledConnection => {
  const defs = new Map<string, unknown>(Object.entries(connection.definitions ?? {}));
  const tools = [...connection.tools].sort((a, b) =>
    String(a.address).localeCompare(String(b.address)),
  );

  // Chunked compile: keys are positional (`t<index>`), unique and identifier-
  // safe by construction. A failing chunk retries tool-by-tool so one broken
  // schema degrades that tool to `unknown` instead of the whole chunk.
  const compiled = new Map<string, ToolChunkTypeScriptEntry>();
  const definitionDecls = new Map<string, string>();
  const entries: ToolChunkSchemaEntry[] = tools.map((tool, index) => ({
    key: `t${index}`,
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
  }));

  const absorb = (result: ReturnType<typeof compileToolChunkTypeScript>) => {
    for (const [key, value] of result.tools) {
      compiled.set(key, value);
    }
    for (const [name, body] of Object.entries(result.definitions)) {
      if (!definitionDecls.has(name)) {
        definitionDecls.set(name, body);
      }
    }
  };

  for (let start = 0; start < entries.length; start += chunkSize) {
    const chunk = entries.slice(start, start + chunkSize);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the vendored json-schema-to-typescript compiler throws on invalid schemas; a failing chunk retries tool-by-tool
    try {
      absorb(compileToolChunkTypeScript(chunk, defs));
    } catch {
      for (const entry of chunk) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: same throwing compiler; a single broken schema degrades to unknown
        try {
          absorb(compileToolChunkTypeScript([entry], defs));
        } catch {
          compiled.set(entry.key, {
            ...(entry.inputSchema !== undefined ? { inputTypeScript: "unknown" } : {}),
            ...(entry.outputSchema !== undefined ? { outputTypeScript: "unknown" } : {}),
          });
        }
      }
    }
  }

  // Name per-tool types after the tool, avoiding collisions with definition
  // names (which the compiled type bodies reference bare) and each other.
  const usedNames = new Set<string>(definitionDecls.keys());
  const declarations: string[] = [];
  for (const [name, body] of [...definitionDecls.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    declarations.push(`  export type ${name} = ${body};`);
  }

  const compiledTools: CompiledTool[] = tools.map((tool, index) => {
    const entry = compiled.get(`t${index}`) ?? {};
    const base = sanitizeIdentifier(tool.name);
    let inputTypeRef: string | undefined;
    if (entry.inputTypeScript !== undefined) {
      const inputName = uniqueName(`${base}_Input`, usedNames);
      declarations.push(`  export type ${inputName} = ${entry.inputTypeScript};`);
      inputTypeRef = `${namespaceName}.${inputName}`;
    }
    let outputTypeRef = "unknown";
    if (entry.outputTypeScript !== undefined) {
      const outputName = uniqueName(`${base}_Output`, usedNames);
      declarations.push(`  export type ${outputName} = ${entry.outputTypeScript};`);
      outputTypeRef = `${namespaceName}.${outputName}`;
    }
    return {
      pathSegments: toolPathSegments(connection, tool),
      ...(tool.description !== undefined && tool.description.length > 0
        ? { description: tool.description }
        : {}),
      ...(inputTypeRef !== undefined ? { inputTypeRef } : {}),
      outputTypeRef,
    };
  });

  return { namespaceName, declarations, tools: compiledTools };
};

// ---------------------------------------------------------------------------
// Path tree
// ---------------------------------------------------------------------------

type TreeNode = {
  children: Map<string, TreeNode>;
  leaf?: CompiledTool;
};

const insertTool = (root: TreeNode, tool: CompiledTool): void => {
  let node = root;
  for (const segment of tool.pathSegments) {
    let child = node.children.get(segment);
    if (!child) {
      child = { children: new Map() };
      node.children.set(segment, child);
    }
    node = child;
  }
  node.leaf = tool;
};

const leafType = (tool: CompiledTool): string =>
  tool.inputTypeRef !== undefined
    ? `ExecutorToolFn<${tool.inputTypeRef}, ${tool.outputTypeRef}>`
    : `ExecutorToolFnNoInput<${tool.outputTypeRef}>`;

const emitNode = (node: TreeNode, indent: string, out: string[]): void => {
  // A node can be both callable (a tool lives at this exact path) and a
  // container (deeper tools share the prefix); emit the intersection.
  const segments = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (node.leaf) {
    out.push(leafType(node.leaf));
    if (segments.length > 0) {
      out.push(" & ");
    }
  }
  if (segments.length === 0) {
    return;
  }
  out.push("{\n");
  for (const [segment, child] of segments) {
    if (child.leaf?.description !== undefined) {
      out.push(`${indent}  /** ${escapeJsDoc(child.leaf.description)} */\n`);
    }
    out.push(`${indent}  ${propertyKey(segment)}: `);
    emitNode(child, `${indent}  `, out);
    out.push(";\n");
  }
  out.push(`${indent}}`);
};

// ---------------------------------------------------------------------------
// Runtime template: embedded verbatim in the generated file so the output
// has zero dependencies. Keep this plain TypeScript: no imports, no
// namespaces with runtime meaning, nothing beyond ES2020 + fetch.
// ---------------------------------------------------------------------------

const runtimeTemplate = (clientName: string): string => `\
export type ExecutorToolError = {
  code: string;
  message: string;
  status?: number;
  details?: unknown;
  retryable?: boolean;
};
export type ExecutorToolHttpMeta = { status: number; headers: { [k: string]: string } };
export type ExecutorToolOutcome<O> =
  | { ok: true; data: O; http?: ExecutorToolHttpMeta }
  | { ok: false; error: ExecutorToolError };
export interface ExecutorCallOptions {
  /** Approve approval-gated tools as the caller instead of pausing. */
  autoApprove?: boolean;
  signal?: AbortSignal;
}
export type ExecutorToolFn<I, O> = (
  input: I,
  options?: ExecutorCallOptions,
) => Promise<ExecutorToolOutcome<O>>;
export type ExecutorToolFnNoInput<O> = (
  input?: Record<string, unknown>,
  options?: ExecutorCallOptions,
) => Promise<ExecutorToolOutcome<O>>;

export interface ExecutorClientOptions {
  /** Executor server origin, e.g. "http://localhost:4788". */
  baseUrl?: string;
  /** Bearer token. Defaults to EXECUTOR_API_KEY / EXECUTOR_AUTH_TOKEN. */
  token?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  /** Approve approval-gated tools for every call from this client. */
  autoApprove?: boolean;
}

export class ExecutorRequestError extends Error {
  readonly status: number | null;
  readonly body: string;
  constructor(message: string, status: number | null, body: string) {
    super(message);
    this.name = "ExecutorRequestError";
    this.status = status;
    this.body = body;
  }
}

export class ExecutorPausedError extends Error {
  readonly executionId: string | null;
  readonly approvalUrl: string | null;
  constructor(message: string, executionId: string | null, approvalUrl: string | null) {
    super(message);
    this.name = "ExecutorPausedError";
    this.executionId = executionId;
    this.approvalUrl = approvalUrl;
  }
}

const DEFAULT_BASE_URL = "http://localhost:4788";
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

const readEnvToken = (): string | undefined => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.EXECUTOR_API_KEY ?? env?.EXECUTOR_AUTH_TOKEN;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface ExecutorClientHandle {
  /** Invoke any tool by dotted path, untyped. */
  $call: (
    path: string,
    input?: Record<string, unknown>,
    options?: ExecutorCallOptions,
  ) => Promise<ExecutorToolOutcome<unknown>>;
}

export type ExecutorClient = ExecutorTools & ExecutorClientHandle;

export function ${clientName}(options: ExecutorClientOptions = {}): ExecutorClient {
  const origin = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\\/+$/, "");
  const token = options.token ?? readEnvToken();
  const fetchImpl = options.fetch ?? globalThis.fetch;

  // Calls go through the instance's REST invoke endpoint (the same
  // operations the exported OpenAPI document describes).
  const invoke = async (
    segments: readonly string[],
    input: unknown,
    callOptions?: ExecutorCallOptions,
  ): Promise<ExecutorToolOutcome<unknown>> => {
    for (const segment of segments) {
      if (!PATH_SEGMENT_PATTERN.test(segment)) {
        throw new ExecutorRequestError(\`Invalid tool path segment: \${segment}\`, null, "");
      }
    }
    if (input !== undefined && !isRecord(input)) {
      throw new ExecutorRequestError("Tool input must be a JSON object", null, "");
    }

    const path = segments.join(".");
    const autoApprove = callOptions?.autoApprove ?? options.autoApprove;
    const query = autoApprove ? "?autoApprove=true" : "";
    const response = await fetchImpl(
      \`\${origin}/api/tools/invoke/\${encodeURIComponent(path)}\${query}\`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: \`Bearer \${token}\` } : {}),
          ...options.headers,
        },
        body: JSON.stringify(input ?? {}),
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      },
    );

    const bodyText = await response.text();
    if (response.status === 404) {
      throw new ExecutorRequestError(\`Tool not found: \${path}\`, 404, bodyText);
    }
    if (!response.ok) {
      throw new ExecutorRequestError(
        \`Executor request failed with status \${response.status}\`,
        response.status,
        bodyText,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new ExecutorRequestError("Executor returned a non-JSON response", null, bodyText);
    }
    if (!isRecord(payload) || typeof payload.ok !== "boolean") {
      throw new ExecutorRequestError("Executor returned an unexpected response", null, bodyText);
    }

    // Approval-gated calls come back as an execution_paused error; surface
    // them as a typed exception carrying the resume coordinates.
    if (payload.ok === false && isRecord(payload.error) && payload.error.code === "execution_paused") {
      const executionId =
        typeof payload.error.executionId === "string" ? payload.error.executionId : null;
      throw new ExecutorPausedError(
        typeof payload.error.message === "string"
          ? payload.error.message
          : "Execution paused awaiting approval",
        executionId,
        executionId ? \`\${origin}/resume/\${encodeURIComponent(executionId)}\` : null,
      );
    }

    return payload as ExecutorToolOutcome<unknown>;
  };

  const callByPath = (
    path: string,
    input?: Record<string, unknown>,
    callOptions?: ExecutorCallOptions,
  ) => invoke(path.split("."), input, callOptions);

  const makeNode = (segments: readonly string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_target, property) => {
        if (segments.length === 0 && property === "$call") {
          return callByPath;
        }
        if (typeof property !== "string") {
          return undefined;
        }
        return makeNode([...segments, property]);
      },
      apply: (_target, _thisArg, args: unknown[]) => invoke(segments, args[0], args[1] as ExecutorCallOptions | undefined),
    });

  return makeNode([]) as ExecutorClient;
}
`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export type GeneratedToolProxy = {
  readonly source: string;
  readonly toolCount: number;
  readonly connectionCount: number;
};

export const generateToolProxySource = (
  catalog: ToolCatalogExport,
  options: GenerateToolProxyOptions = {},
): GeneratedToolProxy => {
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const clientName = options.clientName ?? "createExecutorClient";

  const connections = [...catalog.connections].sort((a, b) => {
    const left = `${a.integration} ${a.owner} ${a.connection}`;
    const right = `${b.integration} ${b.owner} ${b.connection}`;
    return left.localeCompare(right);
  });

  const usedNamespaces = new Set<string>();
  const compiledConnections = connections.map((connection) =>
    compileConnection(
      connection,
      uniqueName(
        `Executor_${sanitizeIdentifier(`${connection.integration}_${connection.owner}_${connection.connection}`)}`,
        usedNamespaces,
      ),
      chunkSize,
    ),
  );

  const root: TreeNode = { children: new Map() };
  let toolCount = 0;
  for (const connection of compiledConnections) {
    for (const tool of connection.tools) {
      insertTool(root, tool);
      toolCount += 1;
    }
  }

  const out: string[] = [];
  out.push(
    "// Generated by `executor generate`. Do not edit.\n",
    "// Regenerate with: executor generate\n",
    "/* eslint-disable */\n",
    "\n",
  );
  out.push(runtimeTemplate(clientName));
  out.push("\n");

  for (const connection of compiledConnections) {
    if (connection.declarations.length === 0) {
      continue;
    }
    // Type-only (non-instantiated) namespace: erased at compile time, so the
    // generated file stays valid under erasableSyntaxOnly and isolatedModules.
    out.push(`export namespace ${connection.namespaceName} {\n`);
    for (const declaration of connection.declarations) {
      out.push(declaration, "\n");
    }
    out.push("}\n\n");
  }

  out.push("export interface ExecutorTools ");
  const treeOut: string[] = [];
  emitNode(root, "", treeOut);
  // The root is never callable; emitNode on an empty tree emits nothing.
  out.push(treeOut.length > 0 ? treeOut.join("") : "{\n}");
  out.push("\n");

  return {
    source: out.join(""),
    toolCount,
    connectionCount: compiledConnections.length,
  };
};
