// ---------------------------------------------------------------------------
// MCP tool invocation — shared helper called from plugin.invokeTool.
//
// Responsible for:
//   1. Finding/creating a cached MCP client connection for the source.
//   2. Installing a per-invocation `ElicitRequestSchema` handler that
//      bridges MCP's elicit capability into the host's elicit function
//      threaded via `InvokeToolInput.elicit`.
//   3. Calling `client.callTool({ name, arguments })`.
//   4. Retrying once on connection failure (invalidate + reconnect).
// ---------------------------------------------------------------------------

import { Cause, Effect, Exit, Option, Predicate, Schema, ScopedCache } from "effect";

import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  FormElicitation,
  UrlElicitation,
  type Elicit,
  type ElicitationRequest,
} from "@executor-js/sdk/core";

import { McpConnectionError, McpInvocationError } from "./errors";
import type { McpConnection } from "./connection";
import type { McpStoredSourceData } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ArgsRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeArgsRecord = Schema.decodeUnknownOption(ArgsRecord);

const argsRecord = (value: unknown): Record<string, unknown> =>
  Option.getOrElse(decodeArgsRecord(value), () => ({}));

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const fingerprint = (value: unknown): string => {
  const input = stableJson(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const connectionCacheKey = (input: {
  readonly sourceData: McpStoredSourceData;
  readonly invokerScope: string;
  readonly sourceId: string;
  readonly sourceScope: string;
}): string => {
  const sd = input.sourceData;
  return sd.transport === "stdio"
    ? `stdio:${fingerprint({
        sourceId: input.sourceId,
        sourceScope: input.sourceScope,
        command: sd.command,
        args: sd.args ?? [],
        env: sd.env ?? {},
        cwd: sd.cwd ?? null,
      })}`
    : `remote:${fingerprint({
        sourceId: input.sourceId,
        sourceScope: input.sourceScope,
        invokerScope: input.invokerScope,
        endpoint: sd.endpoint,
        remoteTransport: sd.remoteTransport ?? "auto",
        headers: sd.headers ?? {},
        queryParams: sd.queryParams ?? {},
        auth: sd.auth,
      })}`;
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
    ? new UrlElicitation({
        message: params.message,
        url: params.url,
        elicitationId: params.elicitationId ?? params.id ?? "",
      })
    : new FormElicitation({
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
): Effect.Effect<unknown, McpInvocationError> =>
  Effect.gen(function* () {
    installElicitationHandler(connection.client, elicit);
    return yield* Effect.tryPromise({
      try: () => connection.client.callTool({ name: toolName, arguments: args }),
      catch: () =>
        new McpInvocationError({
          toolName,
          message: `MCP tool call failed for ${toolName}`,
        }),
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
  readonly toolName: string;
  readonly args: unknown;
  readonly sourceData: McpStoredSourceData;
  readonly sourceId: string;
  readonly sourceScope: string;
  /** Innermost executor scope id at invoke time. Mixed into the
   *  connection cache key so per-user OAuth/secret resolution doesn't
   *  collapse multiple users onto one shared connection. */
  readonly invokerScope: string;
  readonly resolveConnector: () => Effect.Effect<McpConnection, McpConnectionError>;
  readonly connectionCache: ScopedCache.ScopedCache<string, McpConnection, McpConnectionError>;
  readonly pendingConnectors: Map<string, Effect.Effect<McpConnection, McpConnectionError>>;
  readonly elicit: Elicit;
}

export const invokeMcpTool = (
  input: InvokeMcpToolInput,
): Effect.Effect<unknown, McpConnectionError | McpInvocationError> => {
  const transport: string =
    input.sourceData.transport === "stdio" ? "stdio" : (input.sourceData.remoteTransport ?? "auto");
  return Effect.gen(function* () {
    const cacheKey = connectionCacheKey(input);
    const args = argsRecord(input.args);

    // Register the connector for the cache lookup (side-channel pattern
    // — the ScopedCache lookup closure reads from `pendingConnectors`).
    const connector = input.resolveConnector();
    input.pendingConnectors.set(cacheKey, connector);

    // Check cache state BEFORE acquire so the span clearly attributes
    // tail latency to either a cold handshake (miss) or warm reuse (hit).
    // Without this every `plugin.mcp.connection.acquire` span looks the
    // same in Axiom and you have to cross-reference the
    // `plugin.mcp.connection.handshake` count to back out the hit rate.
    const cacheHit = yield* ScopedCache.has(input.connectionCache, cacheKey);

    const firstConnection = yield* ScopedCache.get(input.connectionCache, cacheKey).pipe(
      Effect.withSpan("plugin.mcp.connection.acquire", {
        attributes: {
          "plugin.mcp.transport": transport,
          "plugin.mcp.cache_key": cacheKey,
          "plugin.mcp.attempt": 1,
          "plugin.mcp.cache_hit": cacheHit,
        },
      }),
    );

    return yield* useConnection(firstConnection, input.toolName, args, input.elicit).pipe(
      // On failure, invalidate the cache and retry once with a fresh
      // connection. Matches the old invoker's retry-once semantics.
      Effect.catch(() =>
        Effect.gen(function* () {
          yield* ScopedCache.invalidate(input.connectionCache, cacheKey);
          input.pendingConnectors.set(cacheKey, connector);
          const fresh = yield* ScopedCache.get(input.connectionCache, cacheKey);
          return yield* useConnection(fresh, input.toolName, args, input.elicit);
        }).pipe(
          Effect.withSpan("plugin.mcp.invoke.retry", {
            attributes: {
              "plugin.mcp.transport": transport,
              "plugin.mcp.cache_key": cacheKey,
              "mcp.tool.name": input.toolName,
            },
          }),
        ),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.withSpan("plugin.mcp.invoke", {
      attributes: {
        "mcp.tool.name": input.toolName,
        "plugin.mcp.tool_id": input.toolId,
        "plugin.mcp.transport": transport,
      },
    }),
  );
};
