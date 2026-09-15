// ---------------------------------------------------------------------------
// MCP tool invocation — shared helper called from plugin.invokeTool.
//
// Responsible for:
//   1. Leasing remote connections from a per-plugin-instance pool when one is
//      provided. MCP streamable-http is a series of HTTP requests keyed by the
//      application-level `Mcp-Session-Id`, not a raw pooled socket, and servers
//      legitimately retain state in that session. The pool keeps one idle
//      connection per resolved identity and leases it exclusively per invoke;
//      stdio and callers without a pool remain strictly per-call.
//   2. Installing a per-invocation `elicitation/create` handler that bridges
//      MCP's elicit capability into the host's elicit function threaded via
//      `InvokeToolInput.elicit`.
//   3. Calling `client.callTool({ name, arguments })`.
// ---------------------------------------------------------------------------

import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";

import type { ClientContext, ProtocolError } from "@modelcontextprotocol/client";

// SDK error classes come through the lazy loader; by the time a tool call can
// fail, the connect path has always loaded the module (see client-module.ts).
import { mcpClientSdkIfLoaded } from "./client-module";

import {
  ElicitationId,
  FormElicitation,
  UrlElicitation,
  type Elicit,
  type ElicitationRequest,
} from "@executor-js/sdk/core";

import { McpConnectionError, McpInvocationError, McpOAuthReauthorizationRequired } from "./errors";
import type { McpConnection, McpConnector } from "./connection";
import type { McpConnectionPool } from "./connection-pool";
import { httpStatusFromCause, insufficientScopeFromCause } from "./http-status";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The MCP SDK's default request timer measures wall-clock time. An elicitation
 * is user work, so it must not consume the tool's active-work budget. The SDK
 * still gets a long timer as a transport-level backstop; this controller owns
 * the normal deadline and is paused while one or more elicitation handlers are
 * waiting for input.
 */
export const MCP_ACTIVE_WORK_TIMEOUT_MS = 60_000;
const MCP_SDK_TIMEOUT_BACKSTOP_MS = 2_147_483_647;

export type ActiveWorkDeadline = {
  readonly signal: AbortSignal;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly dispose: () => void;
};

export const makeActiveWorkDeadline = (
  timeoutMs: number = MCP_ACTIVE_WORK_TIMEOUT_MS,
): ActiveWorkDeadline => {
  const controller = new AbortController();
  let remainingMs = timeoutMs;
  let pendingElicitations = 0;
  let startedAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopTimer = (): void => {
    if (timer === undefined || startedAt === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt));
    startedAt = undefined;
  };

  const abortForTimeout = (): void => {
    timer = undefined;
    startedAt = undefined;
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: AbortSignal consumers need a stable timeout reason
    controller.abort(new Error("MCP tool invocation exceeded its active-work deadline"));
  };

  const startTimer = (): void => {
    if (controller.signal.aborted || pendingElicitations > 0) return;
    if (remainingMs <= 0) {
      abortForTimeout();
      return;
    }
    startedAt = Date.now();
    timer = setTimeout(() => {
      remainingMs = 0;
      abortForTimeout();
    }, remainingMs);
  };

  startTimer();

  return {
    signal: controller.signal,
    pause: () => {
      pendingElicitations += 1;
      if (pendingElicitations === 1) stopTimer();
    },
    resume: () => {
      if (pendingElicitations === 0) return;
      pendingElicitations -= 1;
      if (pendingElicitations === 0) startTimer();
    },
    dispose: () => {
      stopTimer();
      // oxlint-disable-next-line executor/no-error-constructor -- boundary: disposing the scoped signal must interrupt SDK work
      controller.abort(new Error("MCP tool invocation was disposed"));
    },
  };
};

const abortOnSignals = (signals: readonly AbortSignal[]): Effect.Effect<never, Error> =>
  Effect.callback<never, Error>((resume) => {
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: an aborted MCP handler must reject its JSON-RPC response
    const abort = () => resume(Effect.fail(new Error("MCP elicitation was cancelled")));
    if (signals.some((signal) => signal.aborted)) {
      abort();
      return;
    }
    for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => {
      for (const signal of signals) signal.removeEventListener("abort", abort);
    });
  });

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

const asProtocolError = (cause: unknown): ProtocolError | undefined => {
  const sdk = mcpClientSdkIfLoaded();
  if (sdk === undefined) return undefined;
  // oxlint-disable-next-line executor/no-instanceof-tagged-error -- boundary: MCP SDK surfaces JSON-RPC protocol errors as this Error subclass
  return cause instanceof sdk.client.ProtocolError ? cause : undefined;
};

const isUnknownToolCause = (cause: unknown, toolName: string): boolean => {
  const sdk = mcpClientSdkIfLoaded();
  const protocolError = asProtocolError(cause);
  return (
    sdk !== undefined &&
    protocolError !== undefined &&
    (protocolError.code === sdk.client.ProtocolErrorCode.InvalidParams ||
      protocolError.code === sdk.client.ProtocolErrorCode.MethodNotFound) &&
    // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: the narrowing above reaches the SDK's ProtocolError, whose message carries the only unknown-tool discriminator the protocol provides
    isUnknownToolMessage(protocolError.message, toolName)
  );
};

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
    _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  Schema.Struct({
    mode: Schema.optional(Schema.Literal("form")),
    message: Schema.String,
    requestedSchema: Schema.Record(Schema.String, Schema.Unknown),
    _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
]);
type McpElicitParams = typeof McpElicitParams.Type;

const decodeElicitParams = Schema.decodeUnknownSync(McpElicitParams);
const decodeElicitContent = Schema.decodeUnknownSync(
  Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.String,
      Schema.Number,
      Schema.Boolean,
      Schema.mutable(Schema.Array(Schema.String)),
    ]),
  ),
);

/** The `_meta` keys that describe the TERMS of an approval, and nothing else.
 *
 *  `_meta` is an open, implementation-defined map: servers put progress
 *  tokens, internal ids, and their own opaque state in it. A host that renders
 *  all of it as "approval terms" both misleads (none of that is a term the
 *  user is agreeing to) and risks surfacing something private. So this
 *  projects the known consent vocabulary and drops the rest — an unknown
 *  server contributes nothing rather than noise. */
export const APPROVAL_TERM_KEYS = ["persist", "origin", "connector_name", "connector_id"] as const;

export const approvalTerms = (meta: Record<string, unknown> | undefined) => {
  if (meta === undefined) return {};
  const terms = Object.fromEntries(
    APPROVAL_TERM_KEYS.flatMap((key) => {
      const value = meta[key];
      return typeof value === "string" ? [[key, value] as const] : [];
    }),
  );
  return Object.keys(terms).length > 0 ? { meta: terms } : {};
};

const toElicitationRequest = (params: McpElicitParams): ElicitationRequest => {
  const meta = approvalTerms(params._meta);
  return params.mode === "url"
    ? UrlElicitation.make({
        message: params.message,
        url: params.url,
        elicitationId: ElicitationId.make(params.elicitationId ?? params.id ?? ""),
        ...meta,
      })
    : FormElicitation.make({
        message: params.message,
        requestedSchema: params.requestedSchema,
        ...meta,
      });
};

const installElicitationHandler = (
  client: McpConnection["client"],
  elicit: Elicit,
  deadline: ActiveWorkDeadline,
): void => {
  client.setRequestHandler(
    "elicitation/create",
    async (request: { params: unknown }, ctx: ClientContext) => {
      const params = decodeElicitParams(request.params);
      const req = toElicitationRequest(params);
      deadline.pause();
      // Use runPromiseExit so we can inspect typed failures — `elicit`
      // fails with `ElicitationDeclinedError` on decline/cancel, which
      // we translate into the equivalent MCP elicit response instead of
      // surfacing as a JSON-RPC error.
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: MCP SDK request handlers are promise callbacks and must release the active-work lease
      try {
        const exit = await Effect.runPromiseExit(
          Effect.raceFirst(elicit(req), abortOnSignals([ctx.mcpReq.signal, deadline.signal])),
        );
        if (Exit.isSuccess(exit)) {
          const response = exit.value;
          return {
            action: response.action,
            ...(response.action === "accept" && response.content
              ? { content: decodeElicitContent(response.content) }
              : {}),
          };
        }
        const failure = exit.cause.reasons.find(Cause.isFailReason);
        if (failure) {
          const err = failure.error;
          if (Predicate.isTagged(err, "ElicitationDeclinedError")) {
            const action =
              Predicate.hasProperty(err, "action") && err.action === "cancel"
                ? "cancel"
                : "decline";
            return { action };
          }
        }
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: MCP SDK async request handlers signal unexpected failures by rejecting
        throw Cause.squash(exit.cause);
      } finally {
        deadline.resume();
      }
    },
  );
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
  client.setNotificationHandler("notifications/tools/list_changed", () => {
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
    const deadline = yield* Effect.acquireRelease(
      Effect.sync(() => makeActiveWorkDeadline()),
      (activeWork) => Effect.sync(activeWork.dispose),
    );
    installElicitationHandler(connection.client, elicit, deadline);
    installToolListChangedHandler(connection.client, onToolListChanged);
    return yield* Effect.tryPromise({
      try: () =>
        connection.client.callTool(
          { name: toolName, arguments: args },
          { signal: deadline.signal, timeout: MCP_SDK_TIMEOUT_BACKSTOP_MS },
        ),
      catch: (cause) => {
        if (Predicate.isTagged(cause, "McpOAuthReauthorizationRequired")) {
          return new McpOAuthReauthorizationRequired({
            message: "MCP OAuth re-authorization required",
          });
        }
        // Raised by the fetch adapter when the 403 carried an RFC 6750
        // insufficient_scope challenge (the authProvider path, where the SDK
        // would otherwise consume the challenge before we could see it).
        if (Predicate.isTagged(cause, "McpInsufficientScopeError")) {
          return new McpInvocationError({
            toolName,
            message: `MCP tool call failed for ${toolName}`,
            status: 403,
            insufficientScope: true,
            transportFailure: true,
          });
        }
        const status = httpStatusFromCause(cause);
        const protocolFailure = asProtocolError(cause) !== undefined;
        return new McpInvocationError({
          toolName,
          message: `MCP tool call failed for ${toolName}`,
          ...(status === undefined ? {} : { status }),
          ...(!protocolFailure ? { transportFailure: true } : {}),
          ...(isUnknownToolCause(cause, toolName) ? { unknownTool: true } : {}),
          ...(status === 403 && insufficientScopeFromCause(cause)
            ? { insufficientScope: true }
            : {}),
        });
      },
    }).pipe(
      Effect.withSpan("plugin.mcp.client.call_tool", {
        attributes: { "mcp.tool.name": toolName },
      }),
    );
  }).pipe(Effect.scoped);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InvokeMcpToolInput {
  readonly toolId: string;
  /** The real MCP tool name advertised by the server. */
  readonly toolName: string;
  readonly args: unknown;
  readonly transport: string;
  /** Dials a fresh connection when no reusable remote session is available. */
  readonly connector: McpConnector;
  /** Optional per-plugin-instance pool and resolved remote identity key. Both
   *  must be present to enable reuse; otherwise the connection is per-call. */
  readonly connectionPool?: McpConnectionPool;
  readonly connectionPoolKey?: string;
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
    const use = (connection: McpConnection) =>
      useConnection(connection, input.toolName, args, input.elicit, input.onToolListChanged);

    if (input.connectionPool && input.connectionPoolKey) {
      return yield* input.connectionPool.withConnection(
        input.connectionPoolKey,
        input.connector.pipe(
          Effect.withSpan("plugin.mcp.connection.acquire", {
            attributes: { "plugin.mcp.transport": input.transport },
          }),
        ),
        use,
      );
    }

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

    return yield* use(connection);
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
