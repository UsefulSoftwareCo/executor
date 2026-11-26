import { owned } from "@executor-js/telemetry";
import type { ProviderError } from "../contracts/provider-error.ts";
import type { NetworkRefused } from "../contracts/network.ts";
/** Shared MCP pagination, wire parsing and calls. Transport owns connection lifetime. */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  JsonSchemaType,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import {
  ErrorCode,
  ListToolsResultSchema,
  McpError as ProtocolError,
} from "@modelcontextprotocol/sdk/types.js";
import { Effect, Exit, Option, Schema } from "effect";
import {
  defaultMcpClientLimits,
  McpError,
  McpServerHeader,
  McpToolMetadata,
  type McpToolContext,
} from "../contracts/mcp.ts";
import type { UpstreamError } from "../contracts/failure.ts";
import { RouterIcon } from "../contracts/router.ts";
import type { JsonObject } from "../effect.ts";
import { mcpCall } from "./mcp-call.ts";
import { jsonSchemaDecoder } from "./schema.ts";
import { bodyUpstreamError } from "./upstream-error.ts";

/** Codes the MCP SDK raises itself, for a request it stopped waiting for or a closed connection. */
const clientCodes: ReadonlySet<number> = new Set([
  ErrorCode.RequestTimeout,
  ErrorCode.ConnectionClosed,
]);

/**
 * The JSON-RPC error a server answered a request with, if `error` is one. The SDK formats its
 * message as `MCP error <code>: <message>`; the server's own message follows that prefix.
 */
export const answeredError = (error: unknown): UpstreamError | undefined => {
  if (!(error instanceof ProtocolError) || clientCodes.has(error.code)) return undefined;
  const prefix = `MCP error ${error.code}: `;
  return bodyUpstreamError({
    error: {
      code: error.code,
      message: error.message.startsWith(prefix)
        ? error.message.slice(prefix.length)
        : error.message,
    },
  });
};

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
      return { valid: true, data: result.value as T, errorMessage: undefined };
    };
  },
};

/** An operation owns its connection; it must close even when interrupted. */
export interface WithMcpClient {
  <A, E>(
    mode: "discover" | "call",
    use: (client: Client) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | McpError | ProviderError | NetworkRefused>;
}
/** Shared client operations never cache catalogs or account credentials. */
export function mcpClient(
  withClient: WithMcpClient,
  timeoutMs: number,
  failure: (phase: McpError["phase"], error: unknown) => McpError | ProviderError | NetworkRefused,
) {
  /**
   * Follow the complete live catalog, rejecting duplicate tools and cursor loops. The server's
   * self-description comes from the same session's initialization.
   */
  const list = withClient("discover", (client) =>
    Effect.gen(function* () {
      const tools = new Map<string, typeof McpToolMetadata.Type>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        // oxlint-disable-next-line executor/authored-code-through-adapter -- MCP SDK
        const page = yield* Effect.tryPromise({
          try: (signal) =>
            client.request(
              { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
              ListToolsResultSchema,
              { signal, timeout: timeoutMs },
            ),
          catch: (error) => failure("discover", error),
        }).pipe(
          owned("upstream", "provider.mcp.request", {
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
      const info = client.getServerVersion();
      const instructions = client.getInstructions();
      const icons = info?.icons?.flatMap((icon) =>
        Option.toArray(Schema.decodeUnknownOption(RouterIcon)(icon)),
      );
      const server = Schema.decodeUnknownOption(McpServerHeader)({
        ...(info?.name === undefined ? {} : { name: info.name }),
        ...(info?.title === undefined ? {} : { title: info.title }),
        ...(info?.version === undefined ? {} : { version: info.version }),
        ...(info?.description === undefined ? {} : { description: info.description }),
        ...(info?.websiteUrl === undefined ? {} : { websiteUrl: info.websiteUrl }),
        ...(icons === undefined ? {} : { icons }),
        ...(instructions === undefined ? {} : { instructions }),
      });
      return {
        tools: [...tools.values()],
        server: Option.getOrElse(server, () => ({})),
      };
    }),
  ).pipe(owned("upstream", "provider.mcp.discover"));

  /**
   * Initialize a session and read the first page of tools, which servers that accept anonymous
   * initialization still authenticate. Nothing is retained. `mcpHealth` runs it with and without
   * the account's credentials.
   */
  const check = withClient("discover", (client) =>
    // oxlint-disable-next-line executor/authored-code-through-adapter -- MCP SDK
    Effect.tryPromise({
      try: (signal) =>
        client.request({ method: "tools/list", params: {} }, ListToolsResultSchema, {
          signal,
          timeout: timeoutMs,
        }),
      catch: (error) => failure("discover", error),
    }).pipe(
      Effect.asVoid,
      owned("upstream", "provider.mcp.request", {
        kind: "client",
        attributes: { "rpc.system.name": "jsonrpc", "rpc.method": "tools/list" },
      }),
    ),
  ).pipe(owned("upstream", "provider.mcp.check"));

  /** Call once with one account, retaining content and MCP tool-error results. */
  const call = (name: string, input: JsonObject, context: McpToolContext) =>
    withClient("call", (client) => mcpCall(client, name, input, context, timeoutMs, failure)).pipe(
      owned("upstream", "provider.mcp.call", { attributes: { "mcp.tool.name": name } }),
    );

  return { list, check, call };
}

/** Transport-independent operations consumed by the app tool adapter. */
export type McpClient = ReturnType<typeof mcpClient>;
