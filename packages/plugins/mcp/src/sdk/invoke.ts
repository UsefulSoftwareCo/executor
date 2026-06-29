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

import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  ElicitationId,
  FormElicitation,
  UrlElicitation,
  type Elicit,
  type ElicitationRequest,
} from "@executor-js/sdk";

import { McpConnectionError, McpInvocationError, McpOAuthReauthorizationRequired } from "./errors";
import type { McpConnection, McpConnector } from "./connection";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ArgsRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeArgsRecord = Schema.decodeUnknownOption(ArgsRecord);

const argsRecord = (value: unknown): Record<string, unknown> =>
  Option.getOrElse(decodeArgsRecord(value), () => ({}));

const SsePostErrorCause = Schema.Struct({ message: Schema.String });
const decodeSsePostErrorCause = Schema.decodeUnknownOption(SsePostErrorCause);

// Matches the SDK's SSEClientTransport POST-failure message (sse.js); re-verify
// on SDK bumps. A format drift just yields undefined (generic error, no crash).
const statusFromSsePostError = (cause: unknown): number | undefined =>
  Option.match(decodeSsePostErrorCause(cause), {
    onNone: () => undefined,
    onSome: ({ message }) => {
      const match = /^Error POSTing to endpoint \(HTTP ([1-5][0-9]{2})\):/.exec(message);
      if (!match) return undefined;
      return Number(match[1]);
    },
  });

const statusFromStreamableHttpError = (cause: unknown): number | undefined => {
  // oxlint-disable-next-line executor/no-instanceof-tagged-error -- boundary: MCP SDK exposes transport HTTP failures as this Error subclass; protocol errors can carry the same numeric code
  if (!(cause instanceof StreamableHTTPError)) return undefined;
  const code = cause.code;
  return code !== undefined && code >= 100 && code <= 599 ? code : undefined;
};

const httpStatusFromCause = (cause: unknown): number | undefined =>
  statusFromStreamableHttpError(cause) ?? statusFromSsePostError(cause);

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
// Single tool call — install handler, callTool, return raw result
// ---------------------------------------------------------------------------

const useConnection = (
  connection: McpConnection,
  toolName: string,
  args: Record<string, unknown>,
  elicit: Elicit,
): Effect.Effect<unknown, McpInvocationError | McpOAuthReauthorizationRequired> =>
  Effect.gen(function* () {
    installElicitationHandler(connection.client, elicit);
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

    return yield* useConnection(connection, input.toolName, args, input.elicit);
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
