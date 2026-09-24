/** Revisioned MCP metadata is persistent; selected executables remain invocation-owned. */
import { cacheKey } from "@executor-js/app-cache";
import { Effect, Schema } from "effect";
import type { DynamicTools } from "../contracts/dynamic-tools.ts";
import { McpError, McpToolMetadata, McpToolsOptions } from "../contracts/mcp.ts";
import { type JsonValue } from "../contracts/schema.ts";
import { catalogCache, type CatalogCacheOptions } from "./catalog-cache.ts";
import { mcpClientEffect } from "./mcp.ts";
import { adaptMcpTool } from "./mcp-tools.ts";
import { protocolOperations, type OperationKinds } from "./protocol-operations.ts";
import { nativeOperation } from "./operations.ts";

/** Metadata policy for HTTP/SSE sources. A missing cache keeps discovery invocation-local. */
export interface McpCatalogOptions extends McpToolsOptions, CatalogCacheOptions {}

const invoke = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (error) => error });

/** Construction opens no transport unless explicit revalidation is requested. */
export const mcpCatalog = (options: McpCatalogOptions, kinds: OperationKinds) =>
  Effect.gen(function* () {
    // Header names are case-insensitive. Hash all request identity, including credentials,
    // before persistence; custom callers cannot accidentally share two authentication scopes.
    const parsed = yield* Schema.decodeUnknownEffect(McpToolsOptions)(options).pipe(
      Effect.mapError(() => new McpError({ phase: "connect", reason: "invalid_input" })),
    );
    const headers: Record<string, string> = {};
    new Headers(parsed.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const id = yield* cacheKey({ url: parsed.url, headers, accountId: parsed.accountId ?? null });
    const key: JsonValue = ["mcp-catalog-v1", id, "current"];
    const cache = options.cache;
    const changed = cache === undefined ? undefined : invoke(() => cache.invalidate(key));
    const client = yield* mcpClientEffect(options, changed);
    const catalog = yield* catalogCache({
      ...options,
      prefix: ["mcp-catalog-v1", id],
      schema: McpToolMetadata,
      load: (context) =>
        context === undefined
          ? client.list
          : mcpClientEffect(
              { ...parsed, signal: context.signal },
              invoke(() => context.cache.invalidate(key)),
            ).pipe(Effect.flatMap((source) => source.list)),
    });
    const kindOf = (tool: McpToolMetadata) =>
      Object.hasOwn(kinds, tool.name)
        ? (kinds[tool.name] ?? "mutation")
        : tool.annotations?.readOnlyHint === true
          ? "query"
          : "mutation";
    const qualified = (tool: McpToolMetadata) =>
      `${kindOf(tool) === "query" ? "queries" : "mutations"}.${tool.name}`;
    const dynamicTools: DynamicTools = {
      list: () =>
        catalog.list().pipe(
          Effect.map((tools) =>
            tools.map((tool) => ({
              name: qualified(tool),
              description: tool.description ?? tool.title ?? tool.name,
              inputSchema: tool.inputSchema,
              readOnly: kindOf(tool) === "query",
              ...(tool.title === undefined ? {} : { title: tool.title }),
              ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
              annotations: { ...tool.annotations, readOnlyHint: kindOf(tool) === "query" },
              ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
            })),
          ),
        ),
      resolve: (name) =>
        Effect.gen(function* () {
          if (!name.startsWith("queries.") && !name.startsWith("mutations.")) return undefined;
          const raw = name.slice(name.indexOf(".") + 1);
          const tool = yield* catalog.resolve(raw);
          if (tool === undefined || qualified(tool) !== name) return undefined;
          const adapted = yield* adaptMcpTool(client, tool);
          const operations = protocolOperations({ selected: adapted }, { selected: kindOf(tool) });
          return nativeOperation(operations.queries.selected ?? operations.mutations.selected);
        }),
    };
    return { dynamicTools };
  });
