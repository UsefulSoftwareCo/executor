/** GraphQL helpers. Requires the optional graphql peer. */
import { protocolOperations, type OperationKinds } from "./implementation/protocol-operations.ts";
import { Effect } from "effect";
import type { GraphqlToolsOptions } from "./contracts/graphql.ts";
import { graphqlToolsEffect } from "./implementation/graphql.ts";
export { GraphqlError, type GraphqlToolsOptions } from "./contracts/graphql.ts";

/** Discover operations for the selected account. Kinds override uncertain upstream read-only hints. */
export const graphqlOperations = (options: GraphqlToolsOptions, kinds: OperationKinds = {}) =>
  Effect.runPromise(
    graphqlToolsEffect(options).pipe(
      Effect.map((operations) => protocolOperations(operations, kinds)),
    ),
    options.signal === undefined ? {} : { signal: options.signal },
  );

export type { OperationKinds } from "./implementation/protocol-operations.ts";
