import { Option, Schema } from "effect";

import { McpToolAnnotations, McpToolMeta } from "./types";

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
  /** The tool's reserved MCP `_meta` map, carried through verbatim. */
  readonly _meta?: McpToolMeta;
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
  // `_meta` is opaque and entirely server-controlled, so it stays `Unknown`
  // here and is narrowed to the spec's map shape per entry. Declaring the map
  // inline would make one server's malformed `_meta` fail the whole-list
  // decode and drop every tool it advertises.
  _meta: Schema.optional(Schema.Unknown),
});

const ListToolsResult = Schema.Struct({
  tools: Schema.Array(ListedTool),
});

// One page of a paginated `tools/list` response. Entries stay opaque here so a
// page with foreign tool shapes still pages correctly; per-entry decoding
// happens in `extractManifestFromListToolsResult` over the merged list.
const ListToolsPage = Schema.Struct({
  tools: Schema.Array(Schema.Unknown),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

export interface McpListToolsPage {
  readonly tools: readonly unknown[];
  readonly nextCursor?: string | null;
}

const ServerInfo = Schema.Struct({
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
});

const decodeMcpToolMeta = Schema.decodeUnknownOption(McpToolMeta);

/** Narrow a listed tool's `_meta` to the spec's map shape, dropping anything
 *  else. The contents stay unknown and uninterpreted. */
const readToolMeta = (value: unknown): McpToolMeta | undefined =>
  value === undefined ? undefined : Option.getOrUndefined(decodeMcpToolMeta(value));

const decodeListToolsResult = Schema.decodeUnknownOption(ListToolsResult);
const decodeListToolsPageOption = Schema.decodeUnknownOption(ListToolsPage);
const decodeServerInfo = Schema.decodeUnknownOption(ServerInfo);

export const decodeListToolsPage = (value: unknown): Option.Option<McpListToolsPage> =>
  decodeListToolsPageOption(value);

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
        _meta: readToolMeta(tool._meta),
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
