// ---------------------------------------------------------------------------
// MCP tool discovery — connect to an MCP server and list its tools
// ---------------------------------------------------------------------------

import { Effect, Option } from "effect";

import type { McpConnection, McpConnector } from "./connection";
import { McpToolDiscoveryError } from "./errors";
import {
  decodeListToolsPage,
  extractManifestFromListToolsResult,
  type McpToolManifest,
} from "./manifest";

// Backstop for a server that returns a cycling / never-terminating cursor.
// The spec puts no bound on page count; a compliant server terminates by
// omitting `nextCursor`, so any real catalog fits well inside this.
const MAX_LIST_TOOLS_PAGES = 100;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List every tool from an open MCP connection, following `nextCursor`
 * pagination (spec: `tools/list` is a paginated operation — a single call
 * returns one page, not the catalog).
 */
const listAllTools = (
  connection: McpConnection,
): Effect.Effect<McpToolManifest, McpToolDiscoveryError> =>
  Effect.gen(function* () {
    const tools: unknown[] = [];
    let cursor: string | undefined = undefined;

    for (let page = 0; page < MAX_LIST_TOOLS_PAGES; page++) {
      const params: { cursor?: string } | undefined = cursor === undefined ? undefined : { cursor };
      const listResult = yield* Effect.tryPromise({
        try: () => connection.client.listTools(params),
        catch: () =>
          new McpToolDiscoveryError({
            stage: "list_tools",
            message: "Failed listing MCP tools",
          }),
      });

      const decoded = decodeListToolsPage(listResult);
      if (Option.isNone(decoded)) {
        return yield* new McpToolDiscoveryError({
          stage: "list_tools",
          message: "MCP listTools response did not match the expected schema",
        });
      }

      tools.push(...decoded.value.tools);
      const nextCursor = decoded.value.nextCursor;
      if (nextCursor == null || nextCursor === "") break;
      cursor = nextCursor;
    }

    return extractManifestFromListToolsResult(
      { tools },
      {
        serverInfo: connection.client.getServerVersion?.(),
        instructions: connection.client.getInstructions?.(),
      },
    );
  });

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

    const manifest = yield* listAllTools(connection).pipe(
      Effect.onExit(() => closeConnection(connection)),
    );

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
