/** Revisioned MCP metadata is persistent; selected executables remain invocation-owned. */
import { cacheKey } from "@executor-js/app-cache";
import { Effect, Schema } from "effect";
import type { DynamicRouter, RouterMeta } from "../contracts/router.ts";
import { McpError, McpServerHeader, McpToolMetadata, McpToolsOptions } from "../contracts/mcp.ts";
import { type JsonValue } from "../contracts/schema.ts";
import {
  catalogCache,
  catalogScope,
  type CatalogAccount,
  type CatalogCacheOptions,
} from "./catalog-cache.ts";
import { fromPromise, method } from "./authoring.ts";
import { mcpClientEffect } from "./mcp.ts";
import { adaptMcpTool } from "./mcp-tools.ts";
import { protocolOperations, type OperationKinds } from "./protocol-operations.ts";
import { nativeOperation } from "./operations.ts";
import { operationDescription } from "./router-catalog.ts";
import { routerDeclaration } from "./router.ts";

/**
 * A server, the account whose catalog it is, and the metadata policy for HTTP/SSE sources. A
 * missing cache keeps discovery invocation-local.
 */
export type McpCatalogOptions = Omit<McpToolsOptions, "accountId" | "headers"> &
  CatalogCacheOptions &
  CatalogAccount;

/** Browsing metadata; schemas are read per tool. */
const McpToolSummary = McpToolMetadata.mapFields(
  ({ inputSchema: _input, outputSchema: _output, _meta, ...fields }) => fields,
);
type McpToolSummary = typeof McpToolSummary.Type;

/** Router metadata from a server's self-description. Author metadata on the router wins. */
const serverMeta = (server: McpServerHeader): RouterMeta => {
  const title = server.title ?? server.name;
  return {
    ...(title === undefined ? {} : { title }),
    ...(server.description === undefined ? {} : { description: server.description }),
    ...(server.instructions === undefined ? {} : { instructions: server.instructions }),
    ...(server.icons === undefined ? {} : { icons: server.icons }),
  };
};

/** Construction opens no transport unless explicit revalidation is requested. */
export const mcpCatalog = (options: McpCatalogOptions, kinds: OperationKinds) =>
  Effect.gen(function* () {
    const invalid = () => new McpError({ phase: "connect", reason: "invalid_input" });
    const parsed = yield* Schema.decodeUnknownEffect(McpToolsOptions)({
      url: options.url,
      accountId: options.account?.id,
      headers: options.headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    }).pipe(Effect.mapError(invalid));
    // The account's scope separates credentials, so the server alone identifies its catalog.
    const cache = yield* catalogScope(options, options.headers, invalid);
    const id = yield* cacheKey({ url: parsed.url });
    const key: JsonValue = ["mcp-catalog-v3", id, "current"];
    const changed =
      cache === undefined ? undefined : fromPromise(method(cache, "invalidate"), "cache")(key);
    const client = yield* mcpClientEffect(parsed, changed);
    const catalog = yield* catalogCache({
      ...options,
      cache,
      prefix: ["mcp-catalog-v3", id],
      schema: McpToolMetadata,
      summary: {
        schema: McpToolSummary,
        of: ({ inputSchema: _input, outputSchema: _output, _meta, ...summary }) => summary,
      },
      load: (context) =>
        (context === undefined
          ? client.list
          : mcpClientEffect(
              { ...parsed, signal: context.signal },
              fromPromise(method(context.cache, "invalidate"), "cache")(key),
            ).pipe(Effect.flatMap((source) => source.list))
        ).pipe(
          Effect.flatMap(({ tools, server }) =>
            Schema.encodeEffect(McpServerHeader)(server).pipe(
              Effect.map((header) => ({ tools, header })),
            ),
          ),
        ),
    });
    const kindOf = (tool: McpToolSummary) =>
      Object.hasOwn(kinds, tool.name)
        ? (kinds[tool.name] ?? "mutation")
        : tool.annotations?.readOnlyHint === true
          ? "query"
          : "mutation";
    const summarize = (tool: McpToolSummary) => ({
      name: tool.name,
      description: tool.description ?? tool.title ?? tool.name,
      readOnly: kindOf(tool) === "query",
      ...(tool.title === undefined ? {} : { title: tool.title }),
      annotations: { ...tool.annotations, readOnlyHint: kindOf(tool) === "query" },
    });
    /** The operation a call runs; descriptions are rendered from it, so they cannot differ. */
    const operation = (tool: McpToolMetadata) =>
      adaptMcpTool(client, tool).pipe(
        Effect.map((adapted) =>
          nativeOperation(
            protocolOperations({ selected: adapted }, { selected: kindOf(tool) }).selected,
          ),
        ),
      );
    const describe = (tool: McpToolMetadata) =>
      operation(tool).pipe(
        Effect.flatMap((selected) =>
          selected === undefined
            ? Effect.succeed(undefined)
            : operationDescription(tool.name, "", selected),
        ),
      );
    const router: DynamicRouter = {
      kind: "dynamic",
      meta: () =>
        catalog.header().pipe(
          Effect.flatMap((header) =>
            header === undefined
              ? Effect.succeed({})
              : Schema.decodeUnknownEffect(McpServerHeader)(header),
          ),
          Effect.map(serverMeta),
        ),
      list: () =>
        catalog.list().pipe(
          Effect.flatMap((tools) => Effect.forEach(tools, describe)),
          Effect.map((tools) => tools.filter((tool) => tool !== undefined)),
        ),
      summaries: () => catalog.summaries().pipe(Effect.map((tools) => tools.map(summarize))),
      describe: (name) =>
        catalog
          .resolve(name)
          .pipe(
            Effect.flatMap((tool) =>
              tool === undefined ? Effect.succeed(undefined) : describe(tool),
            ),
          ),
      resolve: (name) =>
        catalog
          .resolve(name)
          .pipe(
            Effect.flatMap((tool) =>
              tool === undefined ? Effect.succeed(undefined) : operation(tool),
            ),
          ),
    };
    return routerDeclaration(router);
  });
