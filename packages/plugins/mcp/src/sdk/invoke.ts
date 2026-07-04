// ---------------------------------------------------------------------------
// MCP tool invocation — shared helper called from plugin.invokeTool.
//
// Responsible for:
//   1. Dialing a fresh MCP client connection for the call (no DB-connection
//      caching — request-scoped per the Hyperdrive rule; each invoke acquires
//      and releases its own connection).
//   2. Installing a per-invocation `ElicitRequestSchema` handler that bridges
//      MCP's elicit capability into the host's elicit function threaded via
//      `InvokeToolInput.elicit`.
//   3. Calling `client.callTool({ name, arguments })`.
// ---------------------------------------------------------------------------

import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";

import {
  ElicitRequestSchema,
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  ElicitationId,
  FormElicitation,
  UrlElicitation,
  type Elicit,
  type ElicitationRequest,
} from "@executor-js/sdk/core";

import { McpConnectionError, McpInvocationError, McpOAuthReauthorizationRequired } from "./errors";
import type { McpConnection, McpConnector } from "./connection";
import { httpStatusFromCause } from "./http-status";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ArgsRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeArgsRecord = Schema.decodeUnknownOption(ArgsRecord);

const argsRecord = (value: unknown): Record<string, unknown> =>
  Option.getOrElse(decodeArgsRecord(value), () => ({}));

// The spec answers `tools/call` for a tool the server no longer advertises
// with a protocol error (`-32602 Invalid params`, example message
// "Unknown tool: …"); the reference TypeScript SDK server instead catches that
// error and returns it as an execution-error envelope (`isError: true`, text
// "Tool <name> not found"). Both shapes mean the same thing — the persisted
// catalog drifted — so both are detected, anchored to the exact tool name to
// keep a domain error that merely mentions "not found" from matching. A miss
// is benign (the catalog still heals via TTL or explicit refresh).
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const isUnknownToolMessage = (message: string, toolName: string): boolean => {
  const name = escapeRegExp(toolName);
  return new RegExp(
    `(?:unknown tool:?\\s*"?${name}"?|tool\\s+"?${name}"?\\s+(?:not found|is not available|does not exist))`,
    "i",
  ).test(message);
};

const isUnknownToolCause = (cause: unknown, toolName: string): boolean =>
  // oxlint-disable-next-line executor/no-instanceof-tagged-error -- boundary: MCP SDK surfaces JSON-RPC protocol errors as this Error subclass
  cause instanceof McpError &&
  (cause.code === ErrorCode.InvalidParams || cause.code === ErrorCode.MethodNotFound) &&
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: instanceof narrows to the SDK's McpError, whose message carries the only unknown-tool discriminator the protocol provides
  isUnknownToolMessage(cause.message, toolName);

// ---------------------------------------------------------------------------
// Elicitation bridge — decode incoming MCP ElicitRequest, route through
// the host's elicit function, marshal the response back to MCP shape.
// ---------------------------------------------------------------------------

const McpElicitParams = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("url"),
    message: Schema.String,
    url: Schema.String,
    elicitationId: Schema.optional(Schema.String),
    id: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    mode: Schema.optional(Schema.Literal("form")),
    message: Schema.String,
    requestedSchema: Schema.Record(Schema.String, Schema.Unknown),
  }),
]);
type McpElicitParams = typeof McpElicitParams.Type;

const decodeElicitParams = Schema.decodeUnknownSync(McpElicitParams);

const toElicitationRequest = (params: McpElicitParams): ElicitationRequest =>
  params.mode === "url"
    ? UrlElicitation.make({
        message: params.message,
        url: params.url,
        elicitationId: ElicitationId.make(params.elicitationId ?? params.id ?? ""),
      })
    : FormElicitation.make({
        message: params.message,
        requestedSchema: params.requestedSchema,
      });

const installElicitationHandler = (client: McpConnection["client"], elicit: Elicit): void => {
  client.setRequestHandler(ElicitRequestSchema, async (request: { params: unknown }) => {
    const params = decodeElicitParams(request.params);
    const req = toElicitationRequest(params);
    // Use runPromiseExit so we can inspect typed failures — `elicit`
    // fails with `ElicitationDeclinedError` on decline/cancel, which
    // we translate into the equivalent MCP elicit response instead of
    // surfacing as a JSON-RPC error.
    const exit = await Effect.runPromiseExit(elicit(req));
    if (Exit.isSuccess(exit)) {
      const response = exit.value;
      return {
        action: response.action,
        ...(response.action === "accept" && response.content ? { content: response.content } : {}),
      };
    }
    const failure = exit.cause.reasons.find(Cause.isFailReason);
    if (failure) {
      const err = failure.error;
      if (Predicate.isTagged(err, "ElicitationDeclinedError")) {
        const action =
          Predicate.hasProperty(err, "action") && err.action === "cancel" ? "cancel" : "decline";
        return { action };
      }
    }
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: MCP SDK async request handlers signal unexpected failures by rejecting
    throw Cause.squash(exit.cause);
  });
};

// ---------------------------------------------------------------------------
// tools/list_changed bridge — while a connection is open (the call window),
// listen for the spec's `notifications/tools/list_changed` and surface it to
// the host so it can mark the persisted catalog stale. Registering the handler
// is unconditional: it only fires if the server sends the notification, and a
// server that never does costs nothing.
// ---------------------------------------------------------------------------

const installToolListChangedHandler = (
  client: McpConnection["client"],
  onToolListChanged: (() => void) | undefined,
): void => {
  if (!onToolListChanged) return;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    onToolListChanged();
  });
};

// ---------------------------------------------------------------------------
// Single tool call — install handlers, callTool, return raw result
// ---------------------------------------------------------------------------

const useConnection = (
  connection: McpConnection,
  toolName: string,
  args: Record<string, unknown>,
  elicit: Elicit,
  onToolListChanged: (() => void) | undefined,
): Effect.Effect<unknown, McpInvocationError | McpOAuthReauthorizationRequired> =>
  Effect.gen(function* () {
    installElicitationHandler(connection.client, elicit);
    installToolListChangedHandler(connection.client, onToolListChanged);
    return yield* Effect.tryPromise({
      try: () => connection.client.callTool({ name: toolName, arguments: args }),
      catch: (cause) => {
        if (Predicate.isTagged(cause, "McpOAuthReauthorizationRequired")) {
          return new McpOAuthReauthorizationRequired({
            message: "MCP OAuth re-authorization required",
          });
        }
        const status = httpStatusFromCause(cause);
        return new McpInvocationError({
          toolName,
          message: `MCP tool call failed for ${toolName}`,
          ...(status === undefined ? {} : { status }),
          ...(isUnknownToolCause(cause, toolName) ? { unknownTool: true } : {}),
        });
      },
    }).pipe(
      Effect.withSpan("plugin.mcp.client.call_tool", {
        attributes: { "mcp.tool.name": toolName },
      }),
    );
  });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InvokeMcpToolInput {
  readonly toolId: string;
  /** The real MCP tool name advertised by the server. */
  readonly toolName: string;
  readonly args: unknown;
  readonly transport: string;
  /** Dials a fresh connection. The connection is closed after the call. */
  readonly connector: McpConnector;
  readonly elicit: Elicit;
  /** Fired when the server sends `notifications/tools/list_changed` during
   *  the call window. Synchronous and non-throwing by contract; the caller
   *  uses it to mark the persisted catalog stale. */
  readonly onToolListChanged?: () => void;
}

export const invokeMcpTool = (
  input: InvokeMcpToolInput,
): Effect.Effect<
  unknown,
  McpConnectionError | McpInvocationError | McpOAuthReauthorizationRequired
> =>
  Effect.gen(function* () {
    const args = argsRecord(input.args);

    const connection = yield* Effect.acquireRelease(
      input.connector.pipe(
        Effect.withSpan("plugin.mcp.connection.acquire", {
          attributes: { "plugin.mcp.transport": input.transport },
        }),
      ),
      (conn) =>
        Effect.ignore(
          Effect.tryPromise({
            try: () => conn.close(),
            catch: () =>
              new McpConnectionError({
                transport: input.transport,
                message: "Failed to close MCP connection",
              }),
          }),
        ),
    );

    return yield* useConnection(
      connection,
      input.toolName,
      args,
      input.elicit,
      input.onToolListChanged,
    );
  }).pipe(
    Effect.scoped,
    Effect.withSpan("plugin.mcp.invoke", {
      attributes: {
        "mcp.tool.name": input.toolName,
        "plugin.mcp.tool_id": input.toolId,
        "plugin.mcp.transport": input.transport,
      },
    }),
  );
