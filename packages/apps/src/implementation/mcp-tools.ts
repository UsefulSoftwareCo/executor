import type { ProviderError } from "../contracts/provider-error.ts";
import { ToolResultObservation } from "../contracts/host.ts";
/** Adapt any MCP transport into ordinary tools with shared validation behavior. */
import { Effect, Schema } from "effect";
import { McpError, type McpTools, type McpToolMetadata } from "../contracts/mcp.ts";
import { JsonObject, compileJsonSchemaDecoder, jsonSchemaDecoder } from "../effect.ts";
import type { McpClient } from "./mcp-client.ts";

/** Compile only the selected tool and bind its executable to the current invocation. */
export const adaptMcpTool = (client: McpClient, tool: McpToolMetadata) =>
  Effect.gen(function* () {
    const decoder = yield* jsonSchemaDecoder(tool.inputSchema).pipe(
      Effect.mapError(() => new McpError({ phase: "schema", reason: "invalid_response" })),
    );
    const output =
      tool.outputSchema === undefined
        ? undefined
        : yield* Effect.cached(
            compileJsonSchemaDecoder(tool.outputSchema).pipe(
              Effect.mapError(() => new McpError({ phase: "schema", reason: "invalid_response" })),
            ),
          );
    const adapted: McpTools[string] = {
      ...tool,
      description: tool.description ?? tool.title ?? tool.name,
      input: decoder,
      ...(tool.annotations?.readOnlyHint === undefined
        ? {}
        : { readOnly: tool.annotations.readOnlyHint }),
      run: (context, input) =>
        Effect.gen(function* () {
          const arguments_ = yield* Schema.decodeUnknownEffect(decoder)(input).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(JsonObject)),
            Effect.mapError(() => new McpError({ phase: "call", reason: "invalid_input" })),
          );
          // Compile the selected output schema before sending a potentially
          // mutating call, so an unsupported schema cannot fail after its effects.
          const outputDecoder = output === undefined ? undefined : yield* output;
          const result = yield* client.call(tool.name, arguments_, context);
          if (result.isError === true) {
            (yield* ToolResultObservation).failed();
            yield* Effect.annotateCurrentSpan({
              "executor.outcome": "failed",
              "error.type": "McpToolError",
            });
          }
          if (outputDecoder !== undefined && !result.isError)
            yield* Schema.decodeUnknownEffect(outputDecoder)(result.structuredContent).pipe(
              Effect.mapError(() => new McpError({ phase: "call", reason: "invalid_response" })),
            );
          return result;
        }),
    };
    return adapted;
  });

/** Discover a complete catalog for probes and uncached low-level callers. */
export const adaptMcpTools = (
  client: McpClient,
): Effect.Effect<McpTools, McpError | ProviderError> =>
  Effect.gen(function* () {
    const metadata = yield* client.list;
    const entries = yield* Effect.forEach(metadata, (tool) =>
      adaptMcpTool(client, tool).pipe(Effect.map((adapted) => [tool.name, adapted] as const)),
    );
    return Object.fromEntries(entries);
  });
