/** Cache introspection-derived definitions; resolve one executable with current credentials. */
import { cacheKey } from "@executor-js/app-cache";
import { Effect, Schema } from "effect";
import { GraphqlError, GraphqlToolsOptions, GraphqlToolDefinition } from "../contracts/graphql.ts";
import type { DynamicTools } from "../contracts/dynamic-tools.ts";
import { catalogCache, type CatalogCacheOptions } from "./catalog-cache.ts";
import { graphqlClientEffect, graphqlDefinitions, adaptGraphqlTool } from "./graphql.ts";
import { protocolOperations, type OperationKinds } from "./protocol-operations.ts";
import { nativeOperation } from "./operations.ts";

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
      prefix: ["graphql-catalog-v1", id],
      schema: GraphqlToolDefinition,
      load: (context) =>
        (context === undefined
          ? Effect.succeed(client)
          : graphqlClientEffect({ ...parsed, signal: context.signal })
        ).pipe(
          Effect.flatMap((source) => source.discover),
          Effect.flatMap(graphqlDefinitions),
        ),
    });
    const kindOf = (tool: GraphqlToolDefinition) =>
      Object.hasOwn(kinds, tool.name) ? (kinds[tool.name] ?? "mutation") : tool.kind;
    const qualified = (tool: GraphqlToolDefinition) =>
      `${kindOf(tool) === "query" ? "queries" : "mutations"}.${tool.name}`;
    const dynamicTools: DynamicTools = {
      list: () =>
        catalog.list().pipe(
          Effect.map((tools) =>
            tools.map((tool) => ({
              name: qualified(tool),
              description: tool.description,
              inputSchema: tool.inputSchema,
              readOnly: kindOf(tool) === "query",
            })),
          ),
        ),
      resolve: (name) =>
        Effect.gen(function* () {
          if (!name.startsWith("queries.") && !name.startsWith("mutations.")) return undefined;
          const tool = yield* catalog.resolve(name.slice(name.indexOf(".") + 1));
          if (tool === undefined || qualified(tool) !== name) return undefined;
          const adapted = yield* adaptGraphqlTool(client, tool);
          const operations = protocolOperations({ selected: adapted }, { selected: kindOf(tool) });
          return nativeOperation(operations.queries.selected ?? operations.mutations.selected);
        }),
    };
    return { dynamicTools };
  });
