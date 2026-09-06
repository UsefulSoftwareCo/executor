// ---------------------------------------------------------------------------
// MCP tool discovery — connect to an MCP server and list its tools
// ---------------------------------------------------------------------------

import { Duration, Effect, Option, Predicate, Schema } from "effect";

import { hasNestedOAuthReauthorization, type McpConnection, type McpConnector } from "./connection";
import { McpToolDiscoveryError } from "./errors";
import { createMcpConnector, type ConnectorInput } from "./connection";
import { httpStatusFromCause } from "./http-status";
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

// Teardown is best-effort and paid for by the request that performed discovery.
// A remote transport may accept close and then never settle, so use the same
// bound as the invocation connection pool instead of stranding the caller in an
// uninterruptible finalizer after discovery itself has already completed.
const CLOSE_TIMEOUT = Duration.seconds(2);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The SDK rejects with an Error subclass carrying a stable `code`; decode
 *  the boundary instead of stringifying an unknown. */
const SdkFailure = Schema.Struct({
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
const decodeSdkFailure = Schema.decodeUnknownOption(SdkFailure);

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
        // A bearer accepted at the handshake can be rejected by the time the
        // listing runs (revocation landing mid-discovery). The fetch adapter's
        // reauthorization interception fires here exactly as during connect,
        // so keep the structural signals — the reauthorization tag and the
        // HTTP status — instead of collapsing every listing failure into a
        // generic discovery error; discarding them left the connection on a
        // sticky degraded verdict instead of reconnect-required. Statuses come
        // from `httpStatusFromCause` only: the connection-only numeric-code
        // decode must stay out, since JSON-RPC error codes are not HTTP
        // statuses.
        catch: (cause) => {
          if (hasNestedOAuthReauthorization(cause)) {
            return new McpToolDiscoveryError({
              stage: "list_tools",
              message: "Failed listing MCP tools: MCP OAuth re-authorization required",
              reauthorizationRequired: true,
            });
          }
          const failure = Option.getOrNull(decodeSdkFailure(cause));
          // A modern-era connection whose server breaks the modern response
          // contract means the server echoed our proposed revision without
          // implementing it; callers can retry with legacy negotiation.
          const modernContractViolation =
            connection.client.getProtocolEra?.() === "modern" && failure?.code === "INVALID_RESULT";
          const httpStatus = httpStatusFromCause(cause);
          return new McpToolDiscoveryError({
            stage: "list_tools",
            message:
              failure?.message !== undefined
                ? `Failed listing MCP tools: ${failure.message.slice(0, 300)}`
                : httpStatus === undefined
                  ? "Failed listing MCP tools"
                  : `Failed listing MCP tools (HTTP ${httpStatus})`,
            ...(httpStatus === undefined ? {} : { httpStatus }),
            ...(modernContractViolation ? { modernContractViolation: true } : {}),
          });
        },
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

/** Discovery that survives version-echoing servers. Some servers answer the
 *  proposed 2026-07-28 revision affirmatively while emitting 2024-era results
 *  (Walmart's MCP), which the modern client rightly rejects. On that exact
 *  signature, retry once with legacy negotiation and report which one worked,
 *  so an add flow can pin `versionNegotiation: "legacy"` on the integration. */
export const discoverToolsFromInput = (
  input: ConnectorInput,
  timeoutMs?: number,
): Effect.Effect<
  { readonly manifest: McpToolManifest; readonly versionNegotiation: "auto" | "legacy" | null },
  McpToolDiscoveryError
> =>
  discoverTools(createMcpConnector(input), timeoutMs).pipe(
    Effect.map((manifest) => ({
      manifest,
      versionNegotiation: input.transport === "stdio" ? null : (input.versionNegotiation ?? "auto"),
    })),
    Effect.catch((error) => {
      const retriable =
        error.modernContractViolation === true &&
        input.transport !== "stdio" &&
        input.versionNegotiation !== "legacy";
      if (!retriable) return Effect.fail(error);
      return discoverTools(
        createMcpConnector({ ...input, versionNegotiation: "legacy" }),
        timeoutMs,
      ).pipe(
        Effect.map((manifest) => ({ manifest, versionNegotiation: "legacy" as const })),
        Effect.withSpan("mcp.discover.legacy_retry"),
      );
    }),
  );

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
 *
 * Interruption-safe: the connect phase cleans up after itself (the connector
 * aborts the handshake and closes the transport, killing any spawned stdio
 * child; #1631), and the mask below removes the window between the
 * connector succeeding and `onExit` attaching, where an interrupt would
 * leak the connection. The connector and listTools stay `restore`d so a 499
 * or the timeout above can still cancel them promptly.
 */
export const discoverTools = (
  connector: McpConnector,
  timeoutMs: number = Duration.toMillis(DEFAULT_DISCOVER_TIMEOUT),
): Effect.Effect<McpToolManifest, McpToolDiscoveryError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      // Acquire connection
      const connection = yield* restore(
        connector.pipe(
          Effect.mapError((failure) => {
            // Preserve the handshake HTTP status (401/403 = auth wall) and a
            // connect-level timeout so the liveness health check can classify
            // structurally — dropping `failureKind: "timeout"` here is what
            // made a timed-out handshake read as a generic probe failure.
            const httpStatus = Predicate.isTagged(failure, "McpConnectionError")
              ? failure.httpStatus
              : undefined;
            const reauthorizationRequired = Predicate.isTagged(
              failure,
              "McpOAuthReauthorizationRequired",
            );
            const timedOut =
              Predicate.isTagged(failure, "McpConnectionError") &&
              failure.failureKind === "timeout";
            return new McpToolDiscoveryError({
              stage: "connect",
              message: `Failed connecting to MCP server: ${failure.message}`,
              ...(httpStatus !== undefined ? { httpStatus } : {}),
              ...(reauthorizationRequired ? { reauthorizationRequired: true } : {}),
              ...(timedOut ? { timedOut } : {}),
            });
          }),
        ),
      );

      // The connection advertises the elicitation capability (connection.ts),
      // so a server may elicit mid-listTools — the Codex desktop plugins do
      // this for first-use approvals. Discovery has no user to route the
      // request to (unlike the invoke path's bridge in invoke.ts), and a
      // handler-less request would surface as a method-not-found error on the
      // server's side of an otherwise healthy sync. Decline explicitly: the
      // server completes the list with whatever it allows unapproved.
      connection.client.setRequestHandler("elicitation/create", () =>
        Promise.resolve({ action: "decline" }),
      );

      const manifest = yield* restore(listAllTools(connection)).pipe(
        Effect.onExit(() => closeConnection(connection)),
      );

      return manifest;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        Effect.fail(
          new McpToolDiscoveryError({
            stage: "connect",
            message: `MCP discovery timed out after ${timeoutMs}ms`,
            timedOut: true,
          }),
        ),
    }),
  );

const closeConnection = (connection: {
  readonly close: () => Promise<void>;
}): Effect.Effect<void, never> =>
  Effect.tryPromise({
    try: () => connection.close(),
    catch: () =>
      new McpToolDiscoveryError({
        stage: "list_tools",
        message: "Failed closing MCP connection",
      }),
  }).pipe(Effect.timeout(CLOSE_TIMEOUT), Effect.ignore);
