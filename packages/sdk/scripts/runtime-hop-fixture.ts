/**
 * Local-only probe of what a failed exchange with the app runtime records (`runtime-hop.ts`). Each
 * case runs exchanges against a stub on 127.0.0.1, or a failure built to break the recording, and
 * prints what the span recorded as JSON for `runtime-hop-shape.spec.ts` to judge. The HTTP cases
 * use the same `FetchHttpClient` the runtime's hops use, here on the fixture's own runtime (Node in
 * the scenario). The RPC cases use a `ws` socket, as the runtime's sessions do.
 */
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Net from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { classify } from "../src/implementation/app-runner.ts";
import {
  runtimeHops,
  type RuntimeView,
  type SocketRecord,
} from "../src/implementation/runtime-hop.ts";

const cases = [
  "http-unanswered",
  "http-answer-reset",
  "http-reset-half-written",
  "http-unread-body",
  "http-idle",
  "http-restarted",
  "guard-throwing-getter",
  "guard-proxy",
  "guard-throwing-context",
  "guard-throwing-socket",
  "context-checked",
  "code-long",
  "ws-refused",
  "ws-closed-before-upgrade",
  "ws-close-before-message",
  "ws-close-after-message",
  "rpc-app-failure",
  "rpc-success",
  "rpc-interrupt",
] as const;
type Case = (typeof cases)[number];

/** The `executor.runtime.*` attributes the current span carries. */
const recorded = Effect.map(Effect.currentSpan, (span) =>
  Object.fromEntries([...span.attributes].filter(([key]) => key.startsWith("executor.runtime."))),
);

/** A TCP server on 127.0.0.1 that handles each connection with `onConnection`. */
const tcpServer = (onConnection: (socket: Net.Socket) => void) =>
  Effect.acquireRelease(
    Effect.callback<Net.Server>((resume) => {
      const server = Net.createServer(onConnection);
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.sync(() => server.close()),
  ).pipe(Effect.map((server) => (server.address() as Net.AddressInfo).port));

/** Run `then` once the request's headers have arrived on `socket`. */
const untilHeaders = (socket: Net.Socket, then: () => void) => {
  let buffered = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.indexOf("\r\n\r\n") === -1) return;
    socket.off("data", onData);
    then();
  };
  socket.on("data", onData);
};

const answering = tcpServer((socket) =>
  untilHeaders(socket, () =>
    socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok"),
  ),
);

/** One exchange through `hops.http` as the runtime's `/workflow` hop makes it. */
const exchange = (
  hops: ReturnType<typeof runtimeHops>,
  port: number,
  body: string,
  onHeaders: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(`http://127.0.0.1:${port}/workflow`, {
      headers: { connection: "close" },
    }).pipe(HttpClientRequest.bodyText(body, "application/json"));
    return yield* Effect.exit(
      hops.http("/workflow", http.execute(request), (response) =>
        response.status !== 200
          ? Effect.fail(new Error("status"))
          : Effect.andThen(onHeaders, response.text),
      ),
    );
  });

/** A span around `program`, reporting its outcome and what the span recorded. */
const probe = <A, E, R>(program: Effect.Effect<Exit.Exit<A, unknown>, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* program;
    return { outcome: Exit.isSuccess(exit) ? "answered" : "failed", attributes: yield* recorded };
  }).pipe(Effect.withSpan("probe"), Effect.provide(FetchHttpClient.layer));

/**
 * A failure built to break the recording, sent through the HTTP hop and through the RPC hop: the
 * same object must come out, classified as it would be without the recording.
 */
const guardCase = (error: unknown, view?: RuntimeView, socket?: SocketRecord) =>
  Effect.gen(function* () {
    const hops = runtimeHops(view);
    const viaHttp = yield* Effect.exit(
      hops.http("/workflow", Effect.fail(error), () => Effect.succeed("unreachable")),
    );
    const httpAttributes = yield* recorded;
    const rpc = yield* Effect.gen(function* () {
      const exit = yield* Effect.exit(hops.rpc(() => socket, Effect.fail(error)));
      return { exit, attributes: yield* recorded };
    }).pipe(Effect.withSpan("rpc"));
    const same = (exit: Exit.Exit<unknown, unknown>) =>
      Exit.isFailure(exit) &&
      exit.cause.reasons.length === 1 &&
      Cause.isFailReason(exit.cause.reasons[0]!) &&
      exit.cause.reasons[0]!.error === error;
    // The classification the failure gets, or that classifying it throws, as without the recording.
    const label = (value: unknown) => {
      try {
        return classify(value);
      } catch {
        return "throws";
      }
    };
    const out = (exit: Exit.Exit<unknown, unknown>) =>
      Exit.isFailure(exit) && Cause.isFailReason(exit.cause.reasons[0]!)
        ? exit.cause.reasons[0]!.error
        : undefined;
    return {
      sameErrorHttp: same(viaHttp),
      sameErrorRpc: same(rpc.exit),
      classified: label(error) === label(out(viaHttp)) && label(error) === label(out(rpc.exit)),
      attributes: httpAttributes,
      rpcAttributes: rpc.attributes,
    };
  }).pipe(Effect.withSpan("probe"));

/** An error whose `code` getter throws. */
const throwingGetter = () => {
  const error = new Error("synthetic");
  Object.defineProperty(error, "code", {
    get() {
      throw new Error("getter");
    },
  });
  return error;
};
/** A value every property read of which throws. */
const throwingProxy = () =>
  new Proxy(new Error("synthetic"), {
    get() {
      throw new Error("proxy");
    },
    has() {
      throw new Error("proxy");
    },
    getPrototypeOf() {
      throw new Error("proxy");
    },
  });

/** An RPC socket to a WebSocket stub doing `serve`, recorded once it has closed. */
const wsServer = (serve: (socket: WebSocket) => void) =>
  Effect.acquireRelease(
    Effect.callback<WebSocketServer>((resume) => {
      const server: WebSocketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () =>
        resume(Effect.succeed(server)),
      );
      server.on("connection", serve);
    }),
    (server) => Effect.sync(() => server.close()),
  ).pipe(Effect.map((server) => (server.address() as { port: number }).port));

/** Run `then` once at least `ms` have passed on this process's clock, however late timers fire. */
const atLeast = (ms: number, then: () => void) => {
  const from = performance.now();
  const check = () => {
    const left = ms - (performance.now() - from);
    if (left <= 0) then();
    else setTimeout(check, Math.ceil(left));
  };
  setTimeout(check, ms);
};

/**
 * One RPC session through `hops.rpc`: its work fails once the socket has closed (`transport`), at
 * once while the socket is open (`app`), succeeds (`success`), or is interrupted (`interrupt`).
 * `onReceived` runs after the client has received a message (the recording has counted it).
 */
const session = (
  port: number,
  ending: "transport" | "app" | "success" | "interrupt",
  sendOnOpen: boolean,
  onReceived?: () => void,
) =>
  Effect.gen(function* () {
    const hops = runtimeHops();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { perMessageDeflate: false });
    const record = hops.track(socket);
    const opened = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    socket.on("open", () => {
      Deferred.doneUnsafe(opened, Exit.void);
      if (sendOnOpen) socket.send("hello");
    });
    socket.on("error", () => {});
    socket.on("close", () => Deferred.doneUnsafe(closed, Exit.void));
    if (onReceived !== undefined) socket.on("message", onReceived);
    const work = {
      transport: Effect.andThen(Deferred.await(closed), Effect.fail(new Error("transport"))),
      app: Effect.andThen(Deferred.await(opened), Effect.fail(new Error("app"))),
      success: Effect.andThen(Deferred.await(opened), Effect.succeed("ok")),
      interrupt: Effect.andThen(Deferred.await(opened), Effect.never),
    }[ending];
    const fiber = yield* Effect.forkChild(Effect.exit(hops.rpc(() => record, work)));
    if (ending === "interrupt") {
      yield* Deferred.await(opened);
      yield* Fiber.interrupt(fiber);
    } else yield* Fiber.join(fiber);
    socket.terminate();
    return { attributes: yield* recorded };
  }).pipe(Effect.withSpan("probe"));

const run = (name: Case) => {
  switch (name) {
    case "http-unanswered":
      // Closes 120 ms after the request arrived: the time to failure is at least that.
      return tcpServer((socket) =>
        untilHeaders(socket, () => setTimeout(() => socket.destroy(), 120)),
      ).pipe(Effect.flatMap((port) => probe(exchange(runtimeHops(), port, "{}"))));
    case "http-answer-reset":
      return Effect.gen(function* () {
        // The server resets only once the client has read the reply's headers.
        const headersRead = yield* Deferred.make<void>();
        const port = yield* tcpServer((socket) =>
          untilHeaders(socket, () => {
            socket.write(
              "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 64\r\n\r\n",
            );
            Effect.runFork(
              Effect.andThen(
                Deferred.await(headersRead),
                Effect.sync(() => socket.resetAndDestroy()),
              ),
            );
          }),
        );
        return yield* probe(
          exchange(
            runtimeHops(),
            port,
            "{}",
            Deferred.done(headersRead, Exit.void).pipe(Effect.asVoid),
          ),
        );
      });
    case "http-reset-half-written":
      return tcpServer((socket) => untilHeaders(socket, () => socket.resetAndDestroy())).pipe(
        Effect.flatMap((port) =>
          probe(exchange(runtimeHops(), port, "x".repeat(16 * 1024 * 1024))),
        ),
      );
    case "http-unread-body":
      return tcpServer((socket) =>
        untilHeaders(socket, () => {
          socket.pause();
          socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
        }),
      ).pipe(
        Effect.flatMap((port) => probe(exchange(runtimeHops(), port, "x".repeat(4 * 1024 * 1024)))),
      );
    case "http-idle":
      // A successful exchange, 150 ms idle, then one that fails: the failure says how long it was.
      return Effect.gen(function* () {
        const hops = runtimeHops();
        const good = yield* answering;
        const bad = yield* tcpServer((socket) => untilHeaders(socket, () => socket.destroy()));
        const first = yield* exchange(hops, good, "{}").pipe(Effect.provide(FetchHttpClient.layer));
        yield* Effect.sleep("150 millis");
        return {
          first: Exit.isSuccess(first) ? "answered" : "failed",
          ...(yield* probe(exchange(hops, bad, "{}"))),
        };
      });
    case "http-restarted":
      // A runtime replaced twice, the last time 80 ms before the failure.
      return Effect.gen(function* () {
        const lastAt = performance.now();
        yield* Effect.sleep("80 millis");
        const hops = runtimeHops({ restarts: () => ({ count: 2, lastAt }), probe: () => ({}) });
        const bad = yield* tcpServer((socket) => untilHeaders(socket, () => socket.destroy()));
        return yield* probe(exchange(hops, bad, "{}"));
      });
    case "guard-throwing-getter":
      return guardCase(throwingGetter());
    case "guard-proxy":
      return guardCase(throwingProxy());
    case "guard-throwing-context":
      return guardCase(new Error("synthetic"), {
        restarts: () => ({ count: 0, lastAt: undefined }),
        probe: () => {
          throw new Error("context");
        },
      });
    case "guard-throwing-socket":
      return guardCase(new Error("synthetic"), undefined, {
        ended: () => true,
        attributes: () => {
          throw new Error("socket");
        },
      });
    case "context-checked":
      // A probe context with keys and values the recording must refuse, and an odd error tag.
      return guardCase(
        Object.assign(new Error("synthetic"), {
          _tag: "has spaces in it",
          code: "sk_live_0123456789abcdef0123456789abcd",
          syscall: "aws_secret_key_x",
        }),
        {
          restarts: () => ({ count: 0, lastAt: undefined }),
          probe: () => ({
            "executor.runtime.probe.sequence": 7,
            "executor.runtime.probe.outcome": "timeout",
            "executor.runtime.probe.in_flight": true,
            "executor.runtime.http.route": "/elsewhere",
            // Keys under the recording's own prefix that the hop never writes itself.
            "executor.runtime.forged": "forged",
            "executor.runtime.http.forged": 1,
            "other.prefix": 1,
            "executor.runtime.probe.long": "x".repeat(200),
            "executor.runtime.probe.secret": "sk_live_0123456789abcdef0123456789abcd",
            "executor.runtime.probe.object": { nested: true },
            "executor.runtime.probe.huge": 1e12,
          }),
        },
      );
    case "code-long":
      // Node's longer codes, 26 and 28 characters, are kept. A code of Bun's word form longer than
      // the 40 characters a value may have is recorded as `other`, not dropped.
      return Effect.gen(function* () {
        const stream = yield* guardCase(
          Object.assign(new Error("synthetic"), { code: "ERR_STREAM_PREMATURE_CLOSE" }),
        );
        const status = yield* guardCase(
          Object.assign(new Error("synthetic"), { code: "UND_ERR_RESPONSE_STATUS_CODE" }),
        );
        const long = yield* guardCase(
          Object.assign(new Error("synthetic"), {
            code: "ConnectionRefusedHostUnreachableTemporarily",
          }),
        );
        return {
          attributes: stream.attributes,
          rpcAttributes: status.attributes,
          longAttributes: long.attributes,
        };
      });
    case "ws-refused":
      // Nothing listens on the port: the socket never opens.
      // The listener is closed (its socket released at once) before the client connects.
      return Effect.scoped(tcpServer(() => {})).pipe(
        Effect.flatMap((port) => session(port, "transport", false)),
      );
    case "ws-closed-before-upgrade":
      // The server accepts the connection and closes it before answering the upgrade.
      return tcpServer((socket) => untilHeaders(socket, () => socket.destroy())).pipe(
        Effect.flatMap((port) => session(port, "transport", false)),
      );
    case "ws-close-before-message":
      return wsServer((socket) => socket.close(4001)).pipe(
        Effect.flatMap((port) => session(port, "transport", false)),
      );
    case "ws-close-after-message":
      // Answers the client's message. The client, at least 30 ms on its own clock after it has
      // received the reply, asks the stub to close: the order is a fact, not a delay.
      return Effect.gen(function* () {
        let served: WebSocket | undefined;
        const port = yield* wsServer((socket) => {
          served = socket;
          socket.once("message", () => socket.send("reply"));
        });
        return yield* session(port, "transport", true, () =>
          atLeast(30, () => served?.close(1011)),
        );
      });
    case "rpc-app-failure":
      return wsServer(() => {}).pipe(Effect.flatMap((port) => session(port, "app", false)));
    case "rpc-success":
      return wsServer(() => {}).pipe(Effect.flatMap((port) => session(port, "success", false)));
    case "rpc-interrupt":
      return wsServer(() => {}).pipe(Effect.flatMap((port) => session(port, "interrupt", false)));
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
