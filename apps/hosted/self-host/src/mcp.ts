/** Docker keeps protocol state in bounded, idle-expiring Effect scopes. */
import {
  CallStateCache,
  type CallState,
  ConcurrentStatements,
  StatementBatch,
  authenticatedMcp,
  browserMcpRequest,
  hostedMcpApproval,
  dispatchHostedMcp,
  makeHostedMcp,
  mcpSessionKey,
} from "@executor-js/hosted-server";
import { McpLimits, defaultMcpLimits } from "@executor-js/mcp";
import { PgliteClient } from "@effect/sql-pglite";
import { Config, Context, Effect, RcMap, Schema } from "effect";
import { HttpServerResponse } from "effect/http";

/** Only an explicitly composed development host supplies a verifier. Production stays opt-out. */
export const SelfHostPrivateInvocation = Context.Reference<
  import("@executor-js/sdk/core").PrivateInvocationVerifier | undefined
>("self-host/PrivateInvocation", { defaultValue: () => undefined });

/** Own protocol sessions in the server scope; the returned handler receives SDK/auth per request. */
export const selfHostMcp = Effect.gen(function* () {
  // Decoded as McpLimits, so a budget that is not a positive integer stops startup.
  const limits = yield* Schema.decodeUnknownEffect(McpLimits)({
    ...defaultMcpLimits,
    timeoutMs: yield* Config.Number("EXECUTOR_MCP_TIMEOUT_MS").pipe(
      Config.withDefault(defaultMcpLimits.timeoutMs),
    ),
  });
  const verifier = yield* SelfHostPrivateInvocation;
  const sessions = yield* RcMap.make({
    // Each session keeps what its callers' last tool calls read (CallStateCache).
    lookup: (_key: string) =>
      Effect.map(makeHostedMcp(undefined, limits, undefined, undefined, verifier), (handler) => ({
        ...handler,
        calls: new Map<string, CallState>(),
      })),
    idleTimeToLive: "30 minutes",
    capacity: 256,
  });
  const http = authenticatedMcp((access, address) =>
    Effect.gen(function* () {
      const handler = yield* RcMap.get(sessions, mcpSessionKey(access));
      // PGlite runs in-process, so reads issued together cost no extra connection. A tool call's
      // statements run together under the client's lock, its reads in one snapshot, as in Cloud.
      // Not read-only: a statement another caller handed to PGlite just before the lock can still
      // run inside the transaction, as with any PGlite transaction, and must not fail there.
      return yield* dispatchHostedMcp(access, address, handler.http).pipe(
        Effect.provideService(ConcurrentStatements, { group: (effect) => effect }),
        Effect.provideService(StatementBatch, (leaves, { outside }) =>
          PgliteClient.pipelined(leaves, { outside, begin: "ISOLATION LEVEL REPEATABLE READ" }),
        ),
        Effect.provideService(CallStateCache, handler.calls),
      );
    }).pipe(
      Effect.catchTag("ExceededCapacityError", () =>
        Effect.succeed(
          // An active request is never evicted to admit a new session.
          // Native clients can retry after another scope expires.
          HttpServerResponse.empty({ status: 503 }),
        ),
      ),
    ),
  );
  const approvals = browserMcpRequest((access, address) =>
    Effect.gen(function* () {
      const host = yield* RcMap.get(sessions, mcpSessionKey(access));
      return yield* hostedMcpApproval(host.approvals, access, address);
    }).pipe(
      Effect.catchTag("ExceededCapacityError", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      ),
    ),
  );
  return { http, approvals };
});
