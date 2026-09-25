/** Cache introspection-derived definitions; resolve one executable with current credentials. */
import { cacheKey } from "@executor-js/app-cache";
import { Effect, Schema } from "effect";
import { GraphqlError, GraphqlToolsOptions, GraphqlToolDefinition } from "../contracts/graphql.ts";
import type { DynamicTools } from "../contracts/dynamic-tools.ts";
import { catalogCache, type CatalogCacheOptions } from "./catalog-cache.ts";
import { graphqlClientEffect, graphqlDefinitions, adaptGraphqlTool } from "./graphql.ts";
import { protocolOperations, type OperationKinds } from "./protocol-operations.ts";
import { nativeOperation } from "./operations.ts";

/** Browsing metadata; schemas are read per tool. */
const GraphqlToolSummary = GraphqlToolDefinition.mapFields(({ name, kind, description }) => ({
  name,
  kind,
  description,
}));
type GraphqlToolSummary = typeof GraphqlToolSummary.Type;

export interface GraphqlCatalogOptions extends GraphqlToolsOptions, CatalogCacheOptions {}

export const graphqlCatalog = (options: GraphqlCatalogOptions, kinds: OperationKinds) =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(GraphqlToolsOptions)(options).pipe(
      Effect.mapError(() => new GraphqlError({ phase: "discover", reason: "invalid_input" })),
    );
    const headers: Record<string, string> = {};
    new Headers(parsed.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const id = yield* cacheKey({ url: parsed.url, headers, accountId: parsed.accountId ?? null });
    const client = yield* graphqlClientEffect(parsed);
    const catalog = yield* catalogCache({
      ...options,
      prefix: ["graphql-catalog-v2", id],
      schema: GraphqlToolDefinition,
      summary: {
        schema: GraphqlToolSummary,
        of: ({ name, kind, description }) => ({ name, kind, description }),
      },
      load: (context) =>
        (context === undefined
          ? Effect.succeed(client)
          : graphqlClientEffect({ ...parsed, signal: context.signal })
        ).pipe(
          Effect.flatMap((source) => source.discover),
          Effect.flatMap(graphqlDefinitions),
        ),
    });
    const kindOf = (tool: GraphqlToolSummary) =>
      Object.hasOwn(kinds, tool.name) ? (kinds[tool.name] ?? "mutation") : tool.kind;
    const qualified = (tool: GraphqlToolSummary) =>
      `${kindOf(tool) === "query" ? "queries" : "mutations"}.${tool.name}`;
    const summarize = (tool: GraphqlToolSummary) => ({
      name: qualified(tool),
      description: tool.description,
      readOnly: kindOf(tool) === "query",
    });
    const describe = (tool: GraphqlToolDefinition) => ({
      ...summarize(tool),
      inputSchema: tool.inputSchema,
    });
    const selected = (name: string) =>
      Effect.gen(function* () {
        if (!name.startsWith("queries.") && !name.startsWith("mutations.")) return undefined;
        const tool = yield* catalog.resolve(name.slice(name.indexOf(".") + 1));
        return tool === undefined || qualified(tool) !== name ? undefined : tool;
      });
    const dynamicTools: DynamicTools = {
      list: () => catalog.list().pipe(Effect.map((tools) => tools.map(describe))),
      summaries: () => catalog.summaries().pipe(Effect.map((tools) => tools.map(summarize))),
      describe: (name) =>
        selected(name).pipe(
          Effect.map((tool) => (tool === undefined ? undefined : describe(tool))),
        ),
      resolve: (name) =>
        Effect.gen(function* () {
          const tool = yield* selected(name);
          if (tool === undefined) return undefined;
          const adapted = yield* adaptGraphqlTool(client, tool);
          const operations = protocolOperations({ selected: adapted }, { selected: kindOf(tool) });
          return nativeOperation(operations.queries.selected ?? operations.mutations.selected);
        }),
    };
    return { dynamicTools };
  });
