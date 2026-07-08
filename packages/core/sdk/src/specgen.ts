// ---------------------------------------------------------------------------
// OpenAPI spec generation: the primary `executor generate` artifact.
//
// Turns a `ToolCatalogExport` into an OpenAPI 3.1 document describing the
// instance's tool catalog as a plain REST API: one POST operation per tool at
// `/tools/invoke/{tool path}`, request body = the tool's input schema,
// response = the ok/error outcome envelope every tool returns. The point is
// interop: the document feeds any OpenAPI client generator
// (openapi-typescript, openapi-generator, Kiota, ...), so people bring their
// own client instead of ours.
//
// Shared `$defs` are hoisted into `components.schemas` under a
// per-connection namespace (`<integration>.<owner>.<connection>.<Name>`), so
// a 10k-tool catalog references each shared schema once instead of inlining
// 10k copies. Tool input/output schemas stay inline in their operation:
// they are tool-specific, and inlining avoids inventing 20k component names.
// ---------------------------------------------------------------------------

import { normalizeRefs } from "./schema-refs";
import type { ToolCatalogConnectionExport, ToolCatalogExport } from "./types";

export type GenerateOpenApiSpecOptions = {
  /** `servers[0].url` of the document. Point it at the instance's API base
   *  (origin + `/api`). Defaults to the local daemon. */
  readonly serverUrl?: string;
  readonly title?: string;
  readonly version?: string;
};

export type GeneratedOpenApiSpec = {
  readonly document: Record<string, unknown>;
  readonly toolCount: number;
  readonly connectionCount: number;
};

const DEFAULT_SERVER_URL = "http://localhost:4788/api";

const ADDRESS_PREFIX = "tools.";

/** Sandbox-callable tool path: dynamic addresses drop the `tools.` proxy-root
 *  prefix; static addresses already are the callable path. Mirrors the MCP
 *  tool server's naming. */
const addressToPath = (address: string): string =>
  address.startsWith(ADDRESS_PREFIX) ? address.slice(ADDRESS_PREFIX.length) : address;

const DEFS_REF_PATTERN = /^#\/(?:\$defs|definitions)\/(.+)$/;

/** Deep-rewrite `#/$defs/<name>` refs to namespaced `#/components/schemas/`
 *  pointers. Returns the input unchanged when nothing needs rewriting. */
const rewriteRefs = (node: unknown, namespace: string): unknown => {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((item) => {
      const next = rewriteRefs(item, namespace);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : node;
  }

  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") {
    const name = obj.$ref.match(DEFS_REF_PATTERN)?.[1];
    if (name) {
      return { ...obj, $ref: `#/components/schemas/${namespace}.${name}` };
    }
    return obj;
  }

  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const next = rewriteRefs(value, namespace);
    if (next !== value) changed = true;
    result[key] = next;
  }
  return changed ? result : obj;
};

const asSchemaObject = (schema: unknown): Record<string, unknown> | undefined => {
  if (schema === undefined || schema === null) return undefined;
  if (typeof schema === "boolean") return schema ? {} : undefined;
  if (typeof schema !== "object" || Array.isArray(schema)) return undefined;
  return schema as Record<string, unknown>;
};

// The outcome envelope every invoke returns. `execution_paused` rides the
// error channel so generated clients get exactly one response shape.
const ENVELOPE_SCHEMAS: Record<string, unknown> = {
  ExecutorToolError: {
    type: "object",
    description:
      "Tool failure. `code` is machine-readable; `execution_paused` means the call needs approval: resume it at `resumePath` (or POST /executions/{executionId}/resume).",
    required: ["code", "message"],
    properties: {
      code: { type: "string" },
      message: { type: "string" },
      status: { type: "number" },
      details: {},
      retryable: { type: "boolean" },
      executionId: { type: "string" },
      resumePath: { type: "string" },
    },
  },
  ExecutorToolHttpMeta: {
    type: "object",
    description: "Upstream transport facts for HTTP-backed tools.",
    required: ["status"],
    properties: {
      status: { type: "number" },
      headers: { type: "object", additionalProperties: { type: "string" } },
    },
  },
};

const responseSchema = (outputSchema: unknown, namespace: string): Record<string, unknown> => {
  const output = asSchemaObject(outputSchema);
  return {
    oneOf: [
      {
        type: "object",
        required: ["ok", "data"],
        properties: {
          ok: { const: true },
          data: output !== undefined ? rewriteRefs(normalizeRefs(output), namespace) : {},
          http: { $ref: "#/components/schemas/ExecutorToolHttpMeta" },
        },
      },
      {
        type: "object",
        required: ["ok", "error"],
        properties: {
          ok: { const: false },
          error: { $ref: "#/components/schemas/ExecutorToolError" },
        },
      },
    ],
  };
};

const connectionNamespace = (connection: ToolCatalogConnectionExport): string =>
  `${connection.integration}.${connection.owner}.${connection.connection}`;

const uniqueOperationId = (base: string, used: Set<string>): string => {
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
};

export const generateOpenApiSpec = (
  catalog: ToolCatalogExport,
  options: GenerateOpenApiSpecOptions = {},
): GeneratedOpenApiSpec => {
  const connections = [...catalog.connections].sort((a, b) =>
    connectionNamespace(a).localeCompare(connectionNamespace(b)),
  );

  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = { ...ENVELOPE_SCHEMAS };
  const tags = new Map<string, string>();
  const operationIds = new Set<string>();
  let toolCount = 0;

  for (const connection of connections) {
    const namespace = connectionNamespace(connection);
    for (const [name, schema] of Object.entries(connection.definitions ?? {})) {
      schemas[`${namespace}.${name}`] = rewriteRefs(normalizeRefs(schema), namespace);
    }

    const tag = namespace;
    if (!tags.has(tag)) {
      tags.set(
        tag,
        `Tools from the ${connection.integration} connection "${connection.connection}" (${connection.owner}).`,
      );
    }

    const tools = [...connection.tools].sort((a, b) =>
      String(a.address).localeCompare(String(b.address)),
    );
    for (const tool of tools) {
      const path = addressToPath(String(tool.address));
      const input = asSchemaObject(tool.inputSchema);
      const operation: Record<string, unknown> = {
        operationId: uniqueOperationId(path.replace(/[^A-Za-z0-9_]/g, "_"), operationIds),
        tags: [tag],
        ...(tool.description !== undefined && tool.description.length > 0
          ? { summary: tool.description.split("\n")[0], description: tool.description }
          : {}),
        ...(input !== undefined
          ? {
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: rewriteRefs(normalizeRefs(input), namespace),
                  },
                },
              },
            }
          : {}),
        responses: {
          "200": {
            description:
              "Tool outcome envelope: `ok: true` with the tool's output, or `ok: false` with a typed error (including `execution_paused` for approval-gated calls).",
            content: {
              "application/json": {
                schema: responseSchema(tool.outputSchema, namespace),
              },
            },
          },
          "404": { description: "No tool exists at this path." },
        },
      };
      paths[`/tools/invoke/${path}`] = { post: operation };
      toolCount += 1;
    }
  }

  const document: Record<string, unknown> = {
    openapi: "3.1.0",
    info: {
      title: options.title ?? "Executor tool catalog",
      version: options.version ?? "0.0.0",
      description:
        "Every tool this Executor instance exposes, as one REST operation per tool. Calls execute through Executor, so credentials, policies, and approvals apply. Feed this document to any OpenAPI client generator.",
    },
    servers: [{ url: options.serverUrl ?? DEFAULT_SERVER_URL }],
    security: [{ bearerAuth: [] }],
    tags: [...tags.entries()].map(([name, description]) => ({ name, description })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Executor API token (EXECUTOR_API_KEY / EXECUTOR_AUTH_TOKEN).",
        },
      },
      schemas,
    },
  };

  return { document, toolCount, connectionCount: connections.length };
};
