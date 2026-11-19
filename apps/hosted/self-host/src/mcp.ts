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
import {
  McpLimits,
  defaultMcpLimits,
  callerMcpStorage,
  mcpInteractionStore,
  mcpSessionStore,
} from "@executor-js/mcp";
import { PgliteClient } from "@effect/sql-pglite";
import { Clock, Config, Effect, Exit, RcMap, Schema, Scope } from "effect";
import { HttpServerResponse } from "effect/http";
import { SelfHostMcpStorage } from "./contracts/mcp-storage.ts";

/**
 * Protocol sessions a handler keeps in each elicitation mode, by last use, forgetting only sessions
 * that own no work. A handler stays while its caller keeps calling, and the transport has no session
 * DELETE, so each client that opened a session for one call, or left without ending its session,
 * kept about 0.7 KB until restart.
 */
const maxSessions = 256;

/** Own protocol sessions in the server scope; the returned handler receives SDK/auth per request. */
export const selfHostMcp = Effect.gen(function* () {
  const storage = yield* SelfHostMcpStorage;
  const clock = yield* Clock.Clock;
  const hostScope = yield* Effect.scope;
  const idleMillis = yield* Config.schema(
    Schema.Int.check(Schema.isGreaterThan(0)),
    "EXECUTOR_MCP_SESSION_IDLE_MS",
  ).pipe(Config.withDefault(30 * 60_000));
  // Decoded as McpLimits, so a budget that is not a positive integer stops startup.
  const limits = yield* Schema.decodeUnknownEffect(McpLimits)({
    ...defaultMcpLimits,
    timeoutMs: yield* Config.Number("EXECUTOR_MCP_TIMEOUT_MS").pipe(
      Config.withDefault(defaultMcpLimits.timeoutMs),
    ),
    maxSteps: yield* Config.Number("EXECUTOR_MCP_MAX_STEPS").pipe(
      Config.withDefault(defaultMcpLimits.maxSteps),
    ),
  });
  const sessions = yield* RcMap.make({
    // Each session keeps what its callers' last tool calls read (CallStateCache).
    lookup: (key: string) => {
      const records = callerMcpStorage(storage, key);
      return Effect.map(
        makeHostedMcp(
          undefined,
          limits,
          mcpSessionStore(records),
          mcpInteractionStore(records, () => clock.currentTimeMillisUnsafe()),
          maxSessions,
        ),
        (handler) => ({
          ...handler,
          holding: false,
          calls: new Map<string, CallState>(),
        }),
      );
    },
    idleTimeToLive: idleMillis,
    capacity: 256,
  });
  /**
   * Acquire before the HTTP request releases its reference. A parked program owns a reference,
   * not a timer racing the idle deadline. Once the last program ends, normal idle eviction resumes.
   */
  const hold = (
    key: string,
    handler: Effect.Success<ReturnType<typeof makeHostedMcp>> & { holding: boolean },
  ) =>
    Effect.gen(function* () {
      if (handler.holding || handler.programs() === 0) return;
      const scope = yield* Scope.make();
      yield* RcMap.get(sessions, key).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
        // This request already holds the key, so retaining it cannot exceed capacity.
        Effect.orDie,
      );
      handler.holding = true;
      yield* Effect.gen(function* () {
        while (handler.programs() > 0) yield* Effect.sleep("1 second");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            handler.holding = false;
          }).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
        ),
        Effect.forkIn(hostScope),
      );
    }).pipe(Effect.uninterruptible);
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
        Effect.ensuring(hold(mcpSessionKey(access), handler)),
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
  const approvals = browserMcpRequest((access, address, issuer) =>
    Effect.gen(function* () {
      const host = yield* RcMap.get(sessions, mcpSessionKey(access));
      return yield* hostedMcpApproval(host.approvals, access, address, issuer).pipe(
        Effect.ensuring(hold(mcpSessionKey(access), host)),
      );
    }).pipe(
      Effect.catchTag("ExceededCapacityError", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      ),
    ),
  );
  return { http, approvals };
});
