// ---------------------------------------------------------------------------
// MCP tool discovery — connect to an MCP server and list its tools
// ---------------------------------------------------------------------------

import { Duration, Effect, Option, Predicate } from "effect";

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

// Every caller of `discoverTools` (resolveTools, detect, probeEndpoint,
// checkHealth) is a probe: dial a server we don't control and list its
// tools. Neither the MCP SDK's transport connect nor its `listTools` call
// carries a deadline of its own against a server that never answers (a
// closed/half-open loopback socket, a server wedged mid-handshake), so
// without a bound here a single unresponsive endpoint hangs the calling
// fiber forever. Mirrors the shape-probe fallback's default
// (`probeMcpEndpointShape`'s `timeoutMs = 8_000`) at a slightly longer
// bound since a real handshake + listTools round-trip is heavier than the
// shape probe's single unauth POST.
const DEFAULT_DISCOVER_TIMEOUT = Duration.seconds(15);

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
 *
 * Bounded by `timeoutMs` (default `DEFAULT_DISCOVER_TIMEOUT`): every caller
 * is dialing a server we don't control, and neither the connect handshake
 * nor `listTools` has a deadline of its own, so an unresponsive endpoint
 * (dead loopback port, wedged mid-handshake) would otherwise hang the
 * calling fiber (and, transitively, the server-side request handling it)
 * forever. On timeout, any connection that DID get established is closed
 * before the timeout error is raised (`Effect.onExit` still fires for an
 * interrupted fiber).
 */
export const discoverTools = (
  connector: McpConnector,
  timeoutMs: number = Duration.toMillis(DEFAULT_DISCOVER_TIMEOUT),
): Effect.Effect<McpToolManifest, McpToolDiscoveryError> =>
  Effect.gen(function* () {
    // Acquire connection
    const connection = yield* connector.pipe(
      Effect.mapError((failure) => {
        // Preserve the handshake HTTP status (401/403 = auth wall) so the
        // liveness health check can classify structurally.
        const httpStatus = Predicate.isTagged(failure, "McpConnectionError")
          ? failure.httpStatus
          : undefined;
        return new McpToolDiscoveryError({
          stage: "connect",
          message: `Failed connecting to MCP server: ${failure.message}`,
          ...(httpStatus !== undefined ? { httpStatus } : {}),
        });
      }),
    );

    const manifest = yield* listAllTools(connection).pipe(
      Effect.onExit(() => closeConnection(connection)),
    );

    return manifest;
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        Effect.fail(
          new McpToolDiscoveryError({
            stage: "connect",
            message: `MCP discovery timed out after ${timeoutMs}ms`,
          }),
        ),
    }),
  );

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
