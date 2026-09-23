/** Shared MCP pagination, wire parsing and calls. Transport owns connection lifetime. */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  JsonSchemaType,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Exit, Schema } from "effect";
import {
  defaultMcpClientLimits,
  McpError,
  McpToolMetadata,
  type McpToolContext,
} from "../contracts/mcp.ts";
import type { JsonObject } from "../effect.ts";
import { mcpCall } from "./mcp-call.ts";
import { jsonSchemaDecoder } from "./schema.ts";

/** Use the framework-owned interpreter at the MCP SDK's synchronous validation boundary. */
export const mcpJsonSchemaValidator: jsonSchemaValidator = {
  getValidator<T>(document: JsonSchemaType) {
    const decoder = Effect.runSync(jsonSchemaDecoder(document));
    return (input) => {
      const result = Effect.runSyncExit(Schema.decodeUnknownEffect(decoder)(input));
      if (Exit.isFailure(result))
        return {
          valid: false,
          data: undefined,
          errorMessage: "Value does not match the supported JSON Schema",
        };
      // SAFETY: the MCP SDK associates T with this schema; decoding validates the
      // unknown wire value before returning it through that library contract.
      return { valid: true, data: result.value as T, errorMessage: undefined };
    };
  },
};

/** An operation owns its connection; it must close even when interrupted. */
export interface WithMcpClient {
  <A, E>(
    mode: "discover" | "call",
    use: (client: Client) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | McpError>;
}
/** Shared client operations never cache catalogs or account credentials. */
export function mcpClient(
  withClient: WithMcpClient,
  timeoutMs: number,
  failure: (phase: McpError["phase"], error: unknown) => McpError,
) {
  /** Follow the complete live catalog, rejecting duplicate tools and cursor loops. */
  const list = withClient("discover", (client) =>
    Effect.gen(function* () {
      const tools = new Map<string, typeof McpToolMetadata.Type>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = yield* Effect.tryPromise({
          // This session only reads metadata. listTools() also eagerly compiles
          // every output validator; mcpOperations validates the selected tool on call.
          try: (signal) =>
            client.request(
              { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
              ListToolsResultSchema,
              { signal, timeout: timeoutMs },
            ),
          catch: (error) => failure("discover", error),
        }).pipe(
          Effect.withSpan("provider.mcp.request", {
            kind: "client",
            attributes: { "rpc.system.name": "jsonrpc", "rpc.method": "tools/list" },
          }),
        );
        const metadata = yield* Schema.decodeUnknownEffect(Schema.Array(McpToolMetadata))(
          page.tools,
        ).pipe(
          Effect.mapError(() => new McpError({ phase: "discover", reason: "invalid_response" })),
        );
        for (const tool of metadata) {
          if (!tool.name || tools.has(tool.name) || tools.size >= defaultMcpClientLimits.maxTools)
            return yield* new McpError({ phase: "discover", reason: "invalid_response" });
          tools.set(tool.name, tool);
        }
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (cursors.has(cursor) || cursors.size >= defaultMcpClientLimits.maxPaginationCursors)
            return yield* new McpError({ phase: "discover", reason: "invalid_response" });
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      return [...tools.values()];
    }),
  ).pipe(Effect.withSpan("provider.mcp.discover"));

  /** Call once with one account, retaining content and MCP tool-error results. */
  const call = (name: string, input: JsonObject, context: McpToolContext) =>
    withClient("call", (client) => mcpCall(client, name, input, context, timeoutMs, failure)).pipe(
      Effect.withSpan("provider.mcp.call", { attributes: { "mcp.tool.name": name } }),
    );

  return { list, call };
}

/** Transport-independent operations consumed by the app tool adapter. */
export type McpClient = ReturnType<typeof mcpClient>;
