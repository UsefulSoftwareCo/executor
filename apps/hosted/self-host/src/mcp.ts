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
import {
  Clock,
  Config,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Schedule,
  Schema,
  Scope,
} from "effect";
import { McpSchema } from "effect/ai";
import { HttpServerResponse } from "effect/http";
import { mcpClientLimits } from "./contracts/config.ts";

/**
 * Protocol sessions one client's handler keeps in each elicitation mode, by last use, forgetting
 * only sessions that own no work. A handler stays while its caller keeps calling, and the transport
 * has no session DELETE, so each client that opened a session for one call, or left without ending
 * its session, kept about 0.7 KB until restart.
 */
const maxSessions = 256;
/** A client with no request in flight and no paused program is forgotten after this long. */
const idleMillis = Duration.toMillis(Duration.minutes(30));

/** Every client that could make room owns work: a request in flight or a paused program. */
class McpClientsFull extends Schema.TaggedError<McpClientsFull>()("McpClientsFull", {}) {}

/** Own protocol sessions in the server scope; the returned handler receives SDK/auth per request. */
export const selfHostMcp = Effect.gen(function* () {
  // Decoded as McpLimits, so a budget that is not a positive integer stops startup.
  const limits = yield* Schema.decodeUnknownEffect(McpLimits)({
    ...defaultMcpLimits,
    timeoutMs: yield* Config.Number("EXECUTOR_MCP_TIMEOUT_MS").pipe(
      Config.withDefault(defaultMcpLimits.timeoutMs),
    ),
  });
  const bound = yield* mcpClientLimits;
  // Each client keeps what its callers' last tool calls read (CallStateCache).
  const build = Effect.map(
    makeHostedMcp(undefined, limits, undefined, undefined, maxSessions),
    (handler) => ({ ...handler, calls: new Map<string, CallState>() }),
  );
  type Handler = Effect.Success<typeof build>;
  // A handler outlives the request that opened it, so it is built in the server's context.
  const context = yield* Effect.context<Exclude<Effect.Services<typeof build>, Scope.Scope>>();
  const server = yield* Effect.scope;
  const clock = yield* Clock.Clock;

  interface Client {
    readonly user: string;
    readonly scope: Scope.Closeable;
    readonly ready: Deferred.Deferred<Handler>;
    handler: Handler | undefined;
    /** Requests in flight, each until its response has been sent, its event stream included. */
    requests: number;
    idleSince: number;
  }
  /** One client per `mcpSessionKey`, least recently used first. */
  const clients = new Map<string, Client>();
  const ownsWork = (client: Client) =>
    client.requests > 0 || client.handler === undefined || client.handler.programs() > 0;
  const forget = (key: string, client: Client) => {
    clients.delete(key);
    Scope.close(client.scope, Exit.void).pipe(Effect.runForkWith(context), Fiber.runIn(server));
  };
  /** Forget the least recently used client, of `user` when named, that owns no work. */
  const forgetIdle = (user?: string) => {
    for (const [key, client] of clients) {
      if ((user === undefined || client.user === user) && !ownsWork(client)) {
        forget(key, client);
        return true;
      }
    }
    return false;
  };
  /** Room for one more client of `user`, in the same synchronous step that will take it. */
  const makeRoom = (user: string) => {
    let held = 0;
    for (const client of clients.values()) if (client.user === user) held++;
    if (held >= bound.perUser) return forgetIdle(user);
    return clients.size < bound.total || forgetIdle();
  };
  const open = (key: string, user: string) => {
    const client: Client = {
      user,
      scope: Scope.forkUnsafe(server),
      ready: Deferred.makeUnsafe(),
      handler: undefined,
      requests: 0,
      idleSince: clock.currentTimeMillisUnsafe(),
    };
    clients.set(key, client);
    build
      .pipe(
        Effect.runForkWith(Context.add(context, Scope.Scope, client.scope)),
        Fiber.runIn(client.scope),
      )
      .addObserver((exit) => {
        if (Exit.isSuccess(exit)) client.handler = exit.value;
        else if (clients.get(key) === client) forget(key, client);
        Deferred.doneUnsafe(client.ready, exit);
      });
    return client;
  };
  /** The handler of `user`'s client `key`, held by the request's scope and moved to most recent. */
  const handlerFor = (key: string, user: string) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        let client = clients.get(key);
        if (client === undefined) {
          if (!makeRoom(user)) return Effect.fail(new McpClientsFull());
          client = open(key, user);
        } else {
          clients.delete(key);
          clients.set(key, client);
        }
        const held = client;
        held.requests++;
        return Effect.addFinalizer(() =>
          Effect.sync(() => {
            held.requests--;
            held.idleSince = clock.currentTimeMillisUnsafe();
            // Used until its response ended, so a long event stream does not leave it first in line.
            if (clients.get(key) === held) {
              clients.delete(key);
              clients.set(key, held);
            }
          }),
        ).pipe(Effect.andThen(restore(Deferred.await(held.ready))));
      }),
    );
  yield* Effect.sync(() => {
    const now = clock.currentTimeMillisUnsafe();
    for (const [key, client] of clients)
      if (!ownsWork(client) && now - client.idleSince >= idleMillis) forget(key, client);
  }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);

  const http = authenticatedMcp((access, address) =>
    Effect.gen(function* () {
      const handler = yield* handlerFor(mcpSessionKey(access), access.userId);
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
      // A client that owns work is never forgotten to admit another, so this one waits its turn.
      Effect.catchTag("McpClientsFull", () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            {
              jsonrpc: "2.0",
              id: null,
              error: {
                code: McpSchema.RESOURCE_EXHAUSTED_ERROR_CODE,
                message:
                  "Too many MCP clients in use: every client this server keeps for you, or for everyone, is running a request or holds a paused program. Retry when one of them finishes.",
              },
            },
            { status: 503, headers: { "retry-after": "1" } },
          ),
        ),
      ),
    ),
  );
  const approvals = browserMcpRequest((access, address) =>
    Effect.gen(function* () {
      const host = yield* handlerFor(mcpSessionKey(access), access.userId);
      return yield* hostedMcpApproval(host.approvals, access, address);
    }).pipe(
      Effect.catchTag("McpClientsFull", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 503, headers: { "retry-after": "1" } })),
      ),
    ),
  );
  return { http, approvals };
});
