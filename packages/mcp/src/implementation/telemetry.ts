import { Effect } from "effect";
import { McpRequestAttributes } from "../contracts/telemetry.ts";

/**
 * `Effect.withSpan` for an MCP operation: the span records the host's request attributes
 * (`McpRequestAttributes`) from its start, beside its own.
 */
export const withOperationSpan =
  (name: string, options?: { readonly attributes?: Readonly<Record<string, unknown>> }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(McpRequestAttributes, (request) =>
      Effect.withSpan(effect, name, { attributes: { ...request, ...options?.attributes } }),
    );
