/** Cache introspection-derived definitions; resolve one executable with current credentials. */
import { cacheKey } from "@executor-js/app-cache";
import { Effect, Schema } from "effect";
import { GraphqlError, GraphqlToolsOptions, GraphqlToolDefinition } from "../contracts/graphql.ts";
import type { DynamicRouter } from "../contracts/router.ts";
import {
  catalogCache,
  catalogScope,
  type CatalogAccount,
  type CatalogCacheOptions,
} from "./catalog-cache.ts";
import { graphqlClientEffect, graphqlDefinitions, adaptGraphqlTool } from "./graphql.ts";
import { protocolOperations, type OperationKinds } from "./protocol-operations.ts";
import { nativeOperation } from "./operations.ts";
import { routerDeclaration } from "./router.ts";

/** Browsing metadata; schemas are read per tool. */
const GraphqlToolSummary = GraphqlToolDefinition.mapFields(({ name, kind, description }) => ({
  name,
  kind,
  description,
}));
type GraphqlToolSummary = typeof GraphqlToolSummary.Type;

/** An endpoint, the account whose schema it is, and the metadata policy. */
export type GraphqlCatalogOptions = Omit<GraphqlToolsOptions, "accountId" | "headers"> &
  CatalogCacheOptions &
  CatalogAccount;

export const graphqlCatalog = (options: GraphqlCatalogOptions, kinds: OperationKinds) =>
  Effect.gen(function* () {
    const invalid = () => new GraphqlError({ phase: "discover", reason: "invalid_input" });
    const parsed = yield* Schema.decodeUnknownEffect(GraphqlToolsOptions)({
      url: options.url,
      accountId: options.account?.id,
      headers: options.headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    }).pipe(Effect.mapError(invalid));
    // The account's scope separates credentials, so the endpoint alone identifies its schema.
    const cache = yield* catalogScope(options, options.headers, invalid);
    const id = yield* cacheKey({ url: parsed.url });
    const client = yield* graphqlClientEffect(parsed);
    const catalog = yield* catalogCache({
      ...options,
      cache,
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
          Effect.map((tools) => ({ tools })),
        ),
    });
    const kindOf = (tool: GraphqlToolSummary) =>
      Object.hasOwn(kinds, tool.name) ? (kinds[tool.name] ?? "mutation") : tool.kind;
    const summarize = (tool: GraphqlToolSummary) => ({
      name: tool.name,
      description: tool.description,
      readOnly: kindOf(tool) === "query",
    });
    const describe = (tool: GraphqlToolDefinition) => ({
      ...summarize(tool),
      inputSchema: tool.inputSchema,
    });
    const router: DynamicRouter = {
      kind: "dynamic",
      list: () => catalog.list().pipe(Effect.map((tools) => tools.map(describe))),
      summaries: () => catalog.summaries().pipe(Effect.map((tools) => tools.map(summarize))),
      describe: (name) =>
        catalog
          .resolve(name)
          .pipe(Effect.map((tool) => (tool === undefined ? undefined : describe(tool)))),
      resolve: (name) =>
        Effect.gen(function* () {
          const tool = yield* catalog.resolve(name);
          if (tool === undefined) return undefined;
          const adapted = yield* adaptGraphqlTool(client, tool);
          const operations = protocolOperations({ selected: adapted }, { selected: kindOf(tool) });
          return nativeOperation(operations.selected);
        }),
    };
    return routerDeclaration(router);
  });
