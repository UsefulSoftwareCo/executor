import { owned } from "@executor-js/telemetry";
import type { ProviderError } from "../contracts/provider-error.ts";
import type { NetworkRefused } from "../contracts/network.ts";
/** Shared MCP pagination, wire parsing and calls. Transport owns connection lifetime. */
import { ProtocolError, type Client } from "@modelcontextprotocol/client";
import type { JsonSchemaType, jsonSchemaValidator } from "@modelcontextprotocol/client";

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

/** The JSON-RPC error the server answered with, excluding the SDK's own failures. */
export const answeredError = (error: unknown): UpstreamError | undefined =>
  error instanceof ProtocolError
    ? bodyUpstreamError({ error: { code: error.code, message: error.message } })
    : undefined;

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
          // This session only reads metadata. listTools() also eagerly compiles
          // every output validator; mcpRouter validates the selected tool on call.
          try: (signal) =>
            client.request(
              { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
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
      // The SDK has validated these fields. Icons are display-only, so one that does not fit
      // is dropped; a header that still does not fit is omitted. Tools stay usable either way.
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
        client.request(
          { method: "tools/list", params: {} },
          {
            signal,
            timeout: timeoutMs,
          },
        ),
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
  const call = (tool: McpToolMetadata, input: JsonObject, context: McpToolContext) =>
    withClient("call", (client) => mcpCall(client, tool, input, context, timeoutMs, failure)).pipe(
      owned("upstream", "provider.mcp.call", { attributes: { "mcp.tool.name": tool.name } }),
    );

  return { list, check, call };
}

/** Transport-independent operations consumed by the app tool adapter. */
export type McpClient = ReturnType<typeof mcpClient>;
