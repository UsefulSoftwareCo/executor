import { Option, Schema } from "effect";

import { McpToolAnnotations } from "./types";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface McpToolManifestEntry {
  readonly toolId: string;
  readonly toolName: string;
  readonly description: string | null;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: McpToolAnnotations;
}

export interface McpServerMetadata {
  readonly name: string | null;
  readonly version: string | null;
  /** The server's `instructions` from initialize, when it sent any. */
  readonly instructions: string | null;
}

export interface McpToolManifest {
  readonly server: McpServerMetadata | null;
  readonly tools: readonly McpToolManifestEntry[];
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ListedTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  inputSchema: Schema.optional(Schema.Unknown),
  parameters: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
  annotations: Schema.optional(McpToolAnnotations),
});

const ListToolsResult = Schema.Struct({
  tools: Schema.Array(ListedTool),
});

const ServerInfo = Schema.Struct({
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
});

const decodeListToolsResult = Schema.decodeUnknownOption(ListToolsResult);
const decodeServerInfo = Schema.decodeUnknownOption(ServerInfo);

export const isListToolsResult = (value: unknown): boolean =>
  Option.isSome(decodeListToolsResult(value));

// ---------------------------------------------------------------------------
// Tool ID sanitization
// ---------------------------------------------------------------------------

const sanitize = (value: string): string => {
  const s = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "tool";
};

const uniqueId = (value: string, seen: Map<string, number>): string => {
  const base = sanitize(value);
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return n === 1 ? base : `${base}_${n}`;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const joinToolPath = (namespace: string | undefined, toolId: string): string =>
  namespace?.trim() ? `${namespace}.${toolId}` : toolId;

export const extractManifestFromListToolsResult = (
  listToolsResult: unknown,
  metadata?: { serverInfo?: unknown; instructions?: string | undefined },
): McpToolManifest => {
  const seen = new Map<string, number>();

  const listed = decodeListToolsResult(listToolsResult).pipe(
    Option.map((result) => result.tools),
    Option.getOrElse(() => []),
  );

  const server = decodeServerInfo(metadata?.serverInfo).pipe(
    Option.map(
      (info): McpServerMetadata => ({
        name: info.name ?? null,
        version: info.version ?? null,
        instructions: metadata?.instructions ?? null,
      }),
    ),
    Option.getOrNull,
  );

  const tools = listed.flatMap((tool): McpToolManifestEntry[] => {
    const toolName = tool.name.trim();
    if (!toolName) return [];

    return [
      {
        toolId: uniqueId(toolName, seen),
        toolName,
        description: tool.description ?? null,
        inputSchema: tool.inputSchema ?? tool.parameters,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
    ];
  });

  return { server, tools };
};

// ---------------------------------------------------------------------------
// Namespace derivation
// ---------------------------------------------------------------------------

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const hostnameOf = (url: string): string | null => {
  if (!URL.canParse(url)) return null;
  return new URL(url).hostname;
};

const basenameOf = (path: string): string => path.trim().split(/[\\/]/).pop() ?? path.trim();

export const deriveMcpNamespace = (input: {
  name?: string | null;
  endpoint?: string | null;
  command?: string | null;
}): string => {
  if (input.name?.trim()) return slugify(input.name) || "mcp";

  const fromEndpoint = input.endpoint?.trim() ? hostnameOf(input.endpoint) : null;
  if (fromEndpoint) return slugify(fromEndpoint) || "mcp";

  if (input.command?.trim()) return slugify(basenameOf(input.command)) || "mcp";

  return "mcp";
};
