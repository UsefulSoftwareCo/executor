import { Cause, Effect, Exit, Schema, type Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Net from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { appEntries } from "../src/implementation/tools.ts";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import {
  AppEvaluationFailed,
  CallFailure,
  ToolCallFailed,
  callFailurePresentation,
  evaluationFailure,
  mayHaveWritten,
} from "../src/contracts/tools.ts";
import { RuntimeProtocolFailed } from "../src/contracts/runtime.ts";
import { ScheduleErrors } from "../src/contracts/schedules.ts";
import { runtimeHops, type SocketRecord } from "../src/implementation/runtime-hop.ts";
import {
  failedAtConnect,
  repeatAtConnect,
  repeatUnopened,
  type Opening,
} from "../src/implementation/runtime-connect.ts";

const cases = [
  "rpc-rescued",
  "rpc-capnweb-rescued",
  "rpc-unreachable",
  "rpc-never-opens",
  "rpc-closed-after-open",
  "rpc-sent-then-closed",
  "http-rescued",
  "http-unreachable",
  "http-reset-after-write",
  "http-closed-after-write",
  "call-first-exchange",
  "call-second-exchange",
  "call-second-exchange-read",
  "connect-decision-shapes",
  "wire-previous-release",
  "rpc-check-before-each-connect",
  "rpc-never-opens-own-reason",
] as const;
type Case = (typeof cases)[number];

const delay = Number(process.argv[process.argv.indexOf("--delay") + 1] ?? 0) || 0;
const forced = Effect.sleep(`${delay} millis`);

const recorded = Effect.map(Effect.currentSpan, (span) =>
  Object.fromEntries([...span.attributes].filter(([key]) => key.startsWith("executor.runtime."))),
);

const tcpServer = (onConnection: (socket: Net.Socket, n: number) => void) =>
  Effect.acquireRelease(
    Effect.callback<{ server: Net.Server; connections: () => number }>((resume) => {
      let n = 0;
      const server = Net.createServer((socket) => onConnection(socket, ++n));
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, connections: () => n })));
    }),
    ({ server }) => Effect.sync(() => server.close()),
  ).pipe(
    Effect.map(({ server, connections }) => ({
      port: (server.address() as Net.AddressInfo).port,
      connections,
    })),
  );

const closedPort = Effect.gen(function* () {
  const { port: listener } = yield* tcpServer((socket) => socket.on("error", () => {}));
  const holder = yield* Effect.acquireRelease(
    Effect.callback<Net.Socket>((resume) => {
      const socket = Net.connect({ host: "127.0.0.1", port: listener }, () =>
        resume(Effect.succeed(socket)),
      );
      socket.on("error", () => {});
    }),
    (socket) => Effect.sync(() => socket.destroy()),
  );
  return holder.localPort!;
});

const untilHeaders = (socket: Net.Socket, then: (head: Buffer) => void) => {
  let buffered = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.indexOf("\r\n\r\n") === -1) return;
    socket.off("data", onData);
    then(buffered);
  };
  socket.on("data", onData);
};

const exchange = (
  port: number,
  messages: number,
  options: {
    readonly beforeEachConnect?: Effect.Effect<void>;
    readonly ownReason?: RuntimeProtocolFailed;
  } = {},
) => {
  const hops = runtimeHops();
  const session = (opening: Opening) =>
    Effect.gen(function* () {
      let record: SocketRecord | undefined;
      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { perMessageDeflate: false });
          record = hops.track(socket);
          opening.watch(socket);
          socket.on("error", () => {});
          return socket;
        }),
        (socket) => Effect.sync(() => socket.terminate()),
      );
      const work = Effect.callback<string, Error>((resume) => {
        let replies = 0;
        socket.on("message", () => {
          if (++replies === messages) resume(Effect.succeed("answered"));
        });
        socket.on("close", () => resume(Effect.fail(new Error("closed"))));
        for (let i = 0; i < messages; i++) socket.send("call");
        if (messages === 0) return;
      });
      return yield* hops.rpc(
        () => record,
        Effect.andThen(opening.opened, () => work),
      );
    }).pipe(
      Effect.scoped,
      Effect.mapError((error) => options.ownReason ?? error),
    );
  return repeatUnopened(
    session,
    options.beforeEachConnect === undefined ? {} : { beforeEachConnect: options.beforeEachConnect },
  );
};

const wsStub = (
  upgrade: (n: number) => "upgrade" | "close-before-upgrade",
  serve: (socket: WebSocket) => void,
) =>
  Effect.gen(function* () {
    const wss: WebSocketServer = new WebSocketServer({ noServer: true });
    wss.on("connection", serve);
    return yield* tcpServer((socket, n) => {
      if (upgrade(n) === "close-before-upgrade")
        return untilHeaders(socket, () => socket.destroy());
      untilHeaders(socket, (head) => {
        const text = head.toString("latin1");
        const [requestLine, ...lines] = text.slice(0, text.indexOf("\r\n\r\n")).split("\r\n");
        const headers = Object.fromEntries(
          lines.map((line) => [
            line.slice(0, line.indexOf(":")).toLowerCase(),
            line.slice(line.indexOf(":") + 1).trim(),
          ]),
        );
        const request = Object.assign(Object.create(null), {
          method: requestLine!.split(" ")[0],
          url: requestLine!.split(" ")[1],
          headers,
        });
        wss.handleUpgrade(request as never, socket, Buffer.alloc(0), (ws) =>
          wss.emit("connection", ws, request),
        );
      });
    });
  });

const rpcCase = (
  stub: Effect.Effect<{ port: number; connections: () => number }, never, Scope.Scope>,
  messages: number,
) =>
  Effect.gen(function* () {
    const { port, connections } = yield* stub;
    const exit = yield* Effect.exit(exchange(port, messages));
    return {
      outcome: Exit.isSuccess(exit) ? "answered" : "failed",
      failure: Exit.isFailure(exit) ? failureOf(exit.cause) : undefined,
      connections: connections(),
      attributes: yield* recorded,
    };
  }).pipe(Effect.withSpan("probe"));

const failureOf = (cause: Cause.Cause<unknown>) => {
  const reason = cause.reasons[0];
  if (reason === undefined || !Cause.isFailReason(reason)) return "other";
  const error = reason.error as {
    _tag?: string;
    reason?: string;
    notSent?: boolean;
    message?: string;
  };
  return {
    tag: error._tag ?? (error instanceof Error ? error.message : "other"),
    ...(error.reason === undefined || typeof error.reason !== "string"
      ? {}
      : { reason: error.reason }),
    ...(error.notSent === true ? { notSent: true } : {}),
  };
};

const httpCase = (
  port: () => number,
  connections: () => number,
  body: string,
  beforeConnect: (attempt: number) => Effect.Effect<void, never, Scope.Scope> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const hops = runtimeHops();
    const http = yield* HttpClient.HttpClient;
    let attempt = 0;
    const once = Effect.gen(function* () {
      yield* beforeConnect(++attempt);
      const request = HttpClientRequest.post(`http://127.0.0.1:${port()}/workflow`, {
        headers: { connection: "close" },
      }).pipe(HttpClientRequest.bodyText(body, "application/json"));
      return yield* hops.http("/workflow", http.execute(request), (response) => response.text);
    });
    const exit = yield* Effect.exit(repeatAtConnect(once));
    return {
      outcome: Exit.isSuccess(exit) ? "answered" : "failed",
      attempts: attempt,
      connections: connections(),
      attributes: yield* recorded,
    };
  }).pipe(Effect.withSpan("probe"), Effect.provide(FetchHttpClient.layer));

const callCase = (entries: number, read: boolean) => {
  let enteredApp = false;
  const tracker = appEntries(() => {
    enteredApp = true;
  });
  for (let i = 0; i < entries; i++) tracker.entered();
  const failure = new ToolCallFailed({
    app: "app_00000000-0000-4000-8000-000000000000" as never,
    version: "dpl_00000000-0000-4000-8000-000000000000" as never,
    tool: "probe" as never,
    reason: "Executor could not connect to the app runtime, so it did not send this tool call.",
    notSent: true,
  });
  const surfaced = tracker.callFailure(read, enteredApp)(failure) as ToolCallFailed;
  const presented = callFailurePresentation(surfaced);
  return Effect.succeed({
    notSent: surfaced.notSent === true,
    mayHaveWritten: surfaced.mayHaveWritten === true,
    reason: surfaced.reason,
    retryable: presented?.retryable ?? null,
    action: presented?.recovery.action ?? null,
    attributes: {},
  });
};

const decisions = () => {
  const transport = (cause: unknown) => ({
    _tag: "HttpClientError",
    reason: { _tag: "TransportError", cause },
  });
  const shaped = (fields: Record<string, unknown>) =>
    Object.assign(new TypeError("synthetic"), fields);
  return Effect.succeed({
    decisions: {
      bunRefused: failedAtConnect(
        transport(shaped({ code: "ECONNREFUSED", errno: 0, path: "/x" })),
      ),
      bunTimedOut: failedAtConnect(transport(shaped({ code: "ETIMEDOUT", errno: 0, path: "/x" }))),
      bunReset: failedAtConnect(transport(shaped({ code: "ECONNRESET", errno: 0, path: "/x" }))),
      nodeConnectTimedOut: failedAtConnect(
        transport(
          Object.assign(new TypeError("fetch failed"), {
            cause: shaped({ code: "ETIMEDOUT", syscall: "connect" }),
          }),
        ),
      ),
      nodeReadReset: failedAtConnect(
        transport(
          Object.assign(new TypeError("fetch failed"), {
            cause: shaped({ code: "ECONNRESET", syscall: "read" }),
          }),
        ),
      ),
      undiciConnectTimeout: failedAtConnect(
        transport(
          Object.assign(new TypeError("fetch failed"), {
            cause: shaped({ code: "UND_ERR_CONNECT_TIMEOUT" }),
          }),
        ),
      ),
      notTransport: failedAtConnect({
        _tag: "HttpClientError",
        reason: { _tag: "StatusCodeError" },
      }),
    },
    attributes: {},
  });
};

const previousRuntimeFailures = [
  "cold-start",
  "memory",
  "cpu",
  "timeout",
  "overloaded",
  "reset",
  "disconnected",
  "hung",
  "internal",
  "invalid-reply",
  "too-large",
  "data",
  "build",
  "unsupported",
  "managed",
  "unrecognized",
];
const previousServerAnswers: ReadonlyArray<readonly [string, keyof typeof wireSchemas, string]> = [
  [
    "runtime failure",
    "RuntimeProtocolFailed",
    '{"_tag":"RuntimeProtocolFailed","reason":"disconnected","message":""}',
  ],
  [
    "tool listing failure",
    "AppEvaluationFailed",
    '{"_tag":"AppEvaluationFailed","app":"app_00000000-0000-4000-8000-000000000000","version":"dpl_00000000-0000-4000-8000-000000000000","reason":"App evaluation failed","runtime":{"kind":"worker","failure":"disconnected"},"message":"Executor could not load this app\u2019s tool definitions. The app\u2019s Worker stopped without an answer from the app\u2019s code. Its error matches this cause, which Executor has not confirmed: The connection to the app\'s Worker was lost.","recovery":{"action":"Try again once. If it fails the same way, report the failure with its reference.","instructions":"This happened while Executor loaded the app\'s definition, before any tool ran. Do not change the app\'s accounts to work around it. Retry the unchanged request at most once. This does not show whether the app\'s code or Executor\'s runtime caused it. If it fails again, report the failure with the reference shown beside this error, if any, and check what the app\'s recent changes run while it lists its tools. Verify that the app\'s tools load after the repair."}}',
  ],
  [
    "tool listing failure in a call's failures",
    "CallFailure",
    '{"_tag":"AppEvaluationFailed","app":"app_00000000-0000-4000-8000-000000000000","version":"dpl_00000000-0000-4000-8000-000000000000","reason":"App evaluation failed","runtime":{"kind":"worker","failure":"disconnected"},"message":"Executor could not load this app\u2019s tool definitions. The app\u2019s Worker stopped without an answer from the app\u2019s code. Its error matches this cause, which Executor has not confirmed: The connection to the app\'s Worker was lost.","recovery":{"action":"Try again once. If it fails the same way, report the failure with its reference.","instructions":"This happened while Executor loaded the app\'s definition, before any tool ran. Do not change the app\'s accounts to work around it. Retry the unchanged request at most once. This does not show whether the app\'s code or Executor\'s runtime caused it. If it fails again, report the failure with the reference shown beside this error, if any, and check what the app\'s recent changes run while it lists its tools. Verify that the app\'s tools load after the repair."}}',
  ],
  [
    "tool listing failure in a schedule's failures",
    "ScheduleErrors",
    '{"_tag":"AppEvaluationFailed","app":"app_00000000-0000-4000-8000-000000000000","version":"dpl_00000000-0000-4000-8000-000000000000","reason":"App evaluation failed","runtime":{"kind":"worker","failure":"disconnected"},"message":"Executor could not load this app\u2019s tool definitions. The app\u2019s Worker stopped without an answer from the app\u2019s code. Its error matches this cause, which Executor has not confirmed: The connection to the app\'s Worker was lost.","recovery":{"action":"Try again once. If it fails the same way, report the failure with its reference.","instructions":"This happened while Executor loaded the app\'s definition, before any tool ran. Do not change the app\'s accounts to work around it. Retry the unchanged request at most once. This does not show whether the app\'s code or Executor\'s runtime caused it. If it fails again, report the failure with the reference shown beside this error, if any, and check what the app\'s recent changes run while it lists its tools. Verify that the app\'s tools load after the repair."}}',
  ],
  [
    "tool call not sent",
    "ToolCallFailed",
    '{"_tag":"ToolCallFailed","app":"app_00000000-0000-4000-8000-000000000000","version":"dpl_00000000-0000-4000-8000-000000000000","tool":"probe","reason":"Executor did not receive a usable result from this tool call. The runtime\u2019s error matches this cause, which Executor has not confirmed: The connection to the app\'s Worker was lost.","mayHaveWritten":true,"message":"Executor did not receive a usable result from this tool call. The runtime\u2019s error matches this cause, which Executor has not confirmed: The connection to the app\'s Worker was lost. No further failure detail is available.","recovery":{"action":"Do not automatically repeat this call or duplicate its change. Executor could not confirm its outcome.","instructions":"This call may have changed data or may still complete. A safe read can show effects but cannot rule out later completion. Tell the user what is known and get their agreement before repeating the change. For a call that only reads, the advice for this failure is: \u201cTry once more. If it fails again, inspect the available diagnostics or report the failure. No further failure detail is available, and this error does not establish whether the tool completed. For a read, one further attempt may help. If it fails again, inspect the available diagnostics or report the failure.\u201d Because this call may have changed data, do not repeat it automatically; steps in that advice other than repeating the call still apply. Repairing the cause does not establish whether the earlier call completed."}}',
  ],
  [
    "tool call not sent in a call's failures",
    "CallFailure",
    '{"_tag":"ToolCallFailed","app":"app_00000000-0000-4000-8000-000000000000","version":"dpl_00000000-0000-4000-8000-000000000000","tool":"probe","reason":"Executor did not receive a usable result from this tool call. The runtime\u2019s error matches this cause, which Executor has not confirmed: The connection to the app\'s Worker was lost.","mayHaveWritten":true,"message":"Executor did not receive a usable result from this tool call. The runtime\u2019s error matches this cause, which Executor has not confirmed: The connection to the app\'s Worker was lost. No further failure detail is available.","recovery":{"action":"Do not automatically repeat this call or duplicate its change. Executor could not confirm its outcome.","instructions":"This call may have changed data or may still complete. A safe read can show effects but cannot rule out later completion. Tell the user what is known and get their agreement before repeating the change. For a call that only reads, the advice for this failure is: \u201cTry once more. If it fails again, inspect the available diagnostics or report the failure. No further failure detail is available, and this error does not establish whether the tool completed. For a read, one further attempt may help. If it fails again, inspect the available diagnostics or report the failure.\u201d Because this call may have changed data, do not repeat it automatically; steps in that advice other than repeating the call still apply. Repairing the cause does not establish whether the earlier call completed."}}',
  ],
];
const wireSchemas = {
  RuntimeProtocolFailed,
  ToolCallFailed,
  AppEvaluationFailed,
  CallFailure,
  ScheduleErrors: Schema.Union(ScheduleErrors),
} as const;
const wireJson = (name: keyof typeof wireSchemas) =>
  Schema.fromJsonString(wireSchemas[name] as never);

const wireCase = () =>
  Effect.gen(function* () {
    const app = "app_00000000-0000-4000-8000-000000000000" as never;
    const version = "dpl_00000000-0000-4000-8000-000000000000" as never;
    const port = yield* closedPort;
    const exit = yield* Effect.exit(exchange(port, 1));
    const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
    const runtime =
      reason !== undefined &&
      Cause.isFailReason(reason) &&
      reason.error instanceof RuntimeProtocolFailed
        ? reason.error
        : new RuntimeProtocolFailed({});
    const listing = evaluationFailure({ app, version }, runtime);
    const sent: Array<readonly [string, keyof typeof wireSchemas, unknown]> = [
      ["runtime failure", "RuntimeProtocolFailed", runtime],
      ["tool listing failure", "AppEvaluationFailed", listing],
      ["tool listing failure in a schedule's failures", "ScheduleErrors", listing],
    ];
    const values = sent.map(([label, schema, value]) => {
      const encoded = JSON.parse(Schema.encodeSync(wireJson(schema))(value as never)) as {
        reason?: string;
        notSent?: boolean;
        runtime?: { failure?: string; notSent?: boolean };
      };
      const failure =
        schema === "RuntimeProtocolFailed" ? encoded.reason : encoded.runtime?.failure;
      return {
        label,
        failure,
        known: failure !== undefined && previousRuntimeFailures.includes(failure),
        notSent: encoded.notSent === true || encoded.runtime?.notSent === true,
      };
    });
    const read = previousServerAnswers.map(([label, schema, encoded]) => {
      try {
        Schema.decodeUnknownSync(wireJson(schema))(encoded);
        return { label, decoded: true };
      } catch {
        return { label, decoded: false };
      }
    });
    const call = mayHaveWritten(
      ToolCallFailed,
      new ToolCallFailed({ app, version, tool: "probe" as never, reason: "x", notSent: true }),
    );
    return {
      wire: {
        values,
        read,
        partlyRunDropsNotSent: call.notSent === undefined && call.mayHaveWritten === true,
      },
      attributes: {},
    };
  });

class CountingApi extends RpcTarget {
  invocations = 0;
  invoke() {
    this.invocations += 1;
    return "ran";
  }
}

const capnwebRescue = Effect.gen(function* () {
  const api = new CountingApi();
  const { port, connections } = yield* wsStub(
    (n) => (n === 1 ? "close-before-upgrade" : "upgrade"),
    (socket) => {
      newWebSocketRpcSession(socket as unknown as globalThis.WebSocket, api);
    },
  );
  const hops = runtimeHops();
  const exit = yield* Effect.exit(
    repeatUnopened((opening: Opening) =>
      Effect.scoped(
        Effect.gen(function* () {
          let record: SocketRecord | undefined;
          const peer = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
                perMessageDeflate: false,
              });
              record = hops.track(socket);
              opening.watch(socket);
              socket.on("error", () => {});
              return newWebSocketRpcSession<CountingApi>(socket as unknown as globalThis.WebSocket);
            }),
            (peer) => Effect.sync(() => peer[Symbol.dispose]()),
          );
          return yield* hops.rpc(
            () => record,
            Effect.andThen(opening.opened, () =>
              Effect.tryPromise(async () => String(await peer.invoke())),
            ),
          );
        }),
      ),
    ),
  );
  return {
    outcome: Exit.isSuccess(exit) ? "answered" : "failed",
    value: Exit.isSuccess(exit) ? exit.value : undefined,
    invocations: api.invocations,
    connections: connections(),
    attributes: yield* recorded,
  };
}).pipe(Effect.withSpan("probe"));

const run = (name: Case): Effect.Effect<unknown, unknown, Scope.Scope> => {
  switch (name) {
    case "rpc-rescued":
      return rpcCase(
        wsStub(
          (n) => (n === 1 ? "close-before-upgrade" : "upgrade"),
          (socket) =>
            socket.on("message", () =>
              Effect.runFork(
                Effect.andThen(
                  forced,
                  Effect.sync(() => socket.send("reply")),
                ),
              ),
            ),
        ),
        1,
      );
    case "rpc-unreachable":
      return rpcCase(closedPort.pipe(Effect.map((port) => ({ port, connections: () => 0 }))), 1);
    case "rpc-never-opens":
      return rpcCase(
        wsStub(
          () => "close-before-upgrade",
          () => {},
        ),
        1,
      );
    case "rpc-closed-after-open":
      return rpcCase(
        wsStub(
          () => "upgrade",
          (socket) =>
            Effect.runFork(
              Effect.andThen(
                forced,
                Effect.sync(() => socket.close(4001)),
              ),
            ),
        ),
        0,
      );
    case "rpc-sent-then-closed":
      return rpcCase(
        wsStub(
          () => "upgrade",
          (socket) =>
            socket.once("message", () =>
              Effect.runFork(
                Effect.andThen(
                  forced,
                  Effect.sync(() => socket.close(1011)),
                ),
              ),
            ),
        ),
        1,
      );
    case "http-rescued":
      return Effect.gen(function* () {
        const closed = yield* closedPort;
        let open: { port: number; connections: () => number } | undefined;
        return yield* httpCase(
          () => (open === undefined ? closed : open.port),
          () => open?.connections() ?? 0,
          "{}",
          (attempt) =>
            attempt === 2
              ? Effect.andThen(
                  forced,
                  tcpServer((socket) =>
                    untilHeaders(socket, () =>
                      socket.end(
                        "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
                      ),
                    ),
                  ).pipe(
                    Effect.tap((server) => Effect.sync(() => (open = server))),
                    Effect.asVoid,
                  ),
                )
              : Effect.void,
        );
      });
    case "http-unreachable":
      return closedPort.pipe(
        Effect.flatMap((port) =>
          httpCase(
            () => port,
            () => 0,
            "{}",
          ),
        ),
      );
    case "http-reset-after-write":
      return tcpServer((socket) =>
        untilHeaders(socket, () =>
          Effect.runFork(
            Effect.andThen(
              forced,
              Effect.sync(() => socket.resetAndDestroy()),
            ),
          ),
        ),
      ).pipe(
        Effect.flatMap(({ port, connections }) =>
          httpCase(() => port, connections, "x".repeat(16 * 1024 * 1024)),
        ),
      );
    case "http-closed-after-write":
      return tcpServer((socket) =>
        untilHeaders(socket, () =>
          Effect.runFork(
            Effect.andThen(
              forced,
              Effect.sync(() => socket.end()),
            ),
          ),
        ),
      ).pipe(Effect.flatMap(({ port, connections }) => httpCase(() => port, connections, "{}")));
    case "rpc-capnweb-rescued":
      return capnwebRescue;
    case "connect-decision-shapes":
      return decisions();
    case "wire-previous-release":
      return wireCase();
    case "rpc-check-before-each-connect":
      return Effect.gen(function* () {
        const stub = yield* wsStub(
          () => "close-before-upgrade",
          () => {},
        );
        const seen: number[] = [];
        const exit = yield* Effect.exit(
          exchange(stub.port, 1, {
            beforeEachConnect: Effect.sync(() => {
              seen.push(stub.connections());
            }),
          }),
        );
        return {
          outcome: Exit.isSuccess(exit) ? "answered" : "failed",
          checks: seen,
          connections: stub.connections(),
          attributes: {},
        };
      });
    case "rpc-never-opens-own-reason":
      return Effect.gen(function* () {
        const stub = yield* wsStub(
          () => "close-before-upgrade",
          () => {},
        );
        const exit = yield* Effect.exit(
          exchange(stub.port, 1, {
            ownReason: new RuntimeProtocolFailed({ reason: "overloaded" }),
          }),
        );
        return {
          outcome: Exit.isSuccess(exit) ? "answered" : "failed",
          failure: Exit.isFailure(exit) ? failureOf(exit.cause) : undefined,
          connections: stub.connections(),
          attributes: {},
        };
      });
    case "call-first-exchange":
      return callCase(1, false);
    case "call-second-exchange":
      return callCase(2, false);
    case "call-second-exchange-read":
      return callCase(2, true);
  }
};

const name = process.argv[process.argv.indexOf("--case") + 1] as Case;
if (!cases.includes(name)) throw new Error(`--case must be one of ${cases.join(", ")}`);
Effect.runPromise(Effect.scoped(run(name)).pipe(Effect.timeout("30 seconds"))).then(
  (result) => {
    console.log(JSON.stringify(result));
    process.exit(0);
  },
  (error) => {
    console.error(String(error));
    process.exit(1);
  },
);
