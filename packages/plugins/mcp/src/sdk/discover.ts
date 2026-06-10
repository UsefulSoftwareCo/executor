// ---------------------------------------------------------------------------
// MCP tool discovery — connect to an MCP server and list its tools
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { McpConnector } from "./connection";
import { McpToolDiscoveryError } from "./errors";
import {
  extractManifestFromListToolsResult,
  isListToolsResult,
  type McpToolManifest,
} from "./manifest";

const ErrorWithMessage = Schema.Struct({ message: Schema.String });
const decodeErrorWithMessage = Schema.decodeUnknownOption(ErrorWithMessage);

const listToolsFailureMessage = (error: unknown): string =>
  Option.match(decodeErrorWithMessage(error), {
    onNone: () => "Failed listing MCP tools",
    onSome: ({ message }) => `Failed listing MCP tools: ${message}`,
  });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Connect to an MCP server and discover all available tools.
 * Returns the parsed manifest containing server metadata and tool entries.
 */
export const discoverTools = (
  connector: McpConnector,
): Effect.Effect<McpToolManifest, McpToolDiscoveryError> =>
  Effect.gen(function* () {
    // Acquire connection
    const connection = yield* connector.pipe(
      Effect.mapError(
        ({ message }) =>
          new McpToolDiscoveryError({
            stage: "connect",
            message: `Failed connecting to MCP server: ${message}`,
          }),
      ),
    );

    // List tools
    const listResult = yield* Effect.tryPromise({
      try: () => connection.client.listTools(),
      catch: (error) =>
        new McpToolDiscoveryError({
          stage: "list_tools",
          message: listToolsFailureMessage(error),
        }),
    });

    if (!isListToolsResult(listResult)) {
      yield* closeConnection(connection);
      return yield* new McpToolDiscoveryError({
        stage: "list_tools",
        message: "MCP listTools response did not match the expected schema",
      });
    }

    const manifest = extractManifestFromListToolsResult(listResult, {
      serverInfo: connection.client.getServerVersion?.(),
    });

    // Close the connection after discovery
    yield* closeConnection(connection);

    return manifest;
  });

const closeConnection = (connection: {
  readonly close: () => Promise<void>;
}): Effect.Effect<void, never> =>
  Effect.ignore(
    Effect.tryPromise({
      try: () => connection.close(),
      catch: () =>
        new McpToolDiscoveryError({
          stage: "list_tools",
          message: "Failed closing MCP connection",
        }),
    }),
  );
