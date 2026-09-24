/** GraphQL helpers. Requires the optional graphql peer. */
import type { OperationKinds } from "./implementation/protocol-operations.ts";
import { Effect } from "effect";
import { graphqlCatalog, type GraphqlCatalogOptions } from "./implementation/graphql-catalog.ts";
export { GraphqlError, type GraphqlToolsOptions } from "./contracts/graphql.ts";
export type { GraphqlCatalogOptions } from "./implementation/graphql-catalog.ts";

/** Lazy tools with optional persistent metadata caching for the selected account. */
export const graphqlOperations = (options: GraphqlCatalogOptions, kinds: OperationKinds = {}) =>
  Effect.runPromise(
    graphqlCatalog(options, kinds),
    options.signal === undefined ? {} : { signal: options.signal },
  );

export type { OperationKinds } from "./implementation/protocol-operations.ts";
