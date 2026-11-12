/**
 * Local Cloud's Worker proxy follows HTTP/1.1 framing so a client keeps its connection when
 * workerd closes its end after an answer that left the body unread
 * (patches/cloudflare-runtime-keep-alive.md). These cases run the patched proxy in front of a fake
 * workerd and check that the framing never strands a connection: under Node, which loads the
 * patched `dist/`, and under Bun, which loads the patched `src/`.
 *
 * - An early answer to a large upload that workerd stops reading, then resets: the proxy must
 *   read and discard the rest of the body, and answer the next request on the same connection.
 * - An answer the proxy cannot frame (a head over 64 KB) while it holds the next request: it must
 *   send the held request on, so every request is answered, in order, including when more than
 *   the 1 MB it reads ahead is held.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const probe = String.raw`
const scenario = process.argv.at(-1);
const net = await import("node:net");
const { Effect, Exit, Scope } = await import("effect");
const { WorkerProxy } = await import("@alchemy.run/cloudflare-runtime/core/proxy");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (handler) =>
  new Promise((resolve) => {
    const server = net.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
/** Reads requests off one fake workerd connection; calls answer(socket, head, body) for each. */
const workerd = (answer) =>
  listen((socket) => {
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let body;
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        if (body === undefined) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end === -1) return;
          const head = buffer.subarray(0, end).toString("latin1");
          buffer = buffer.subarray(end + 4);
          const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
          body = { head, length };
          if (answer(socket, head, undefined) === "paused") return;
        }
        if (buffer.length < body.length) return;
        buffer = buffer.subarray(body.length);
        const { head } = body;
        body = undefined;
        answer(socket, head, true);
      }
    });
  });
const ok = (path) => "HTTP/1.1 200 OK\r\nContent-Length: " + path.length + "\r\n\r\n" + path;
const pathOf = (head) => head.split(" ")[1];

const scope = await Effect.runPromise(Scope.make());
const serve = (upstream) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const proxy = yield* WorkerProxy.WorkerProxy;
      const instance = yield* proxy.serve({ host: "127.0.0.1" });
      yield* instance.set(new URL("http://127.0.0.1:" + upstream.address().port));
      return instance;
    }).pipe(Effect.provide(WorkerProxy.WorkerProxyLive), Scope.provide(scope)),
  );
const client = async (instance) => {
  const socket = net.connect(Number(instance.url.port), "127.0.0.1");
  const state = { received: "", closed: false };
  socket.on("error", () => {});
  socket.on("data", (data) => (state.received += data.toString("latin1")));
  socket.on("close", () => (state.closed = true));
  await new Promise((resolve) => socket.once("connect", resolve));
  return { socket, state };
};
/** The body of each response the client has read, in order. */
const answers = (received) => [...received.matchAll(/\r\n\r\n(\/[a-z]+|refused)/g)].map((m) => m[1]);
const until = async (check, ms) => {
  for (let waited = 0; !check() && waited < ms; waited += 20) await sleep(20);
  return check();
};
const report = {};

if (scenario === "early-answer") {
  // workerd stops reading a large upload, answers it, then resets the connection, as it does
  // for a body it does not read.
  const upstream = await workerd((socket, head, complete) => {
    if (head.startsWith("POST") && complete === undefined) {
      socket.pause();
      setTimeout(() => {
        socket.write("HTTP/1.1 413 Payload Too Large\r\nContent-Length: 7\r\n\r\nrefused");
        setTimeout(() => socket.destroy(), 5);
      }, 200);
      return "paused";
    }
    if (complete) socket.write(ok(pathOf(head)));
  });
  const { socket, state } = await client(await serve(upstream));
  const size = 32 * 1024 * 1024;
  socket.write("POST /upload HTTP/1.1\r\nHost: a\r\nContent-Length: " + size + "\r\n\r\n");
  const piece = Buffer.alloc(64 * 1024, 120);
  let sent = 0;
  let stalled = false;
  while (sent < size && !state.closed) {
    sent += piece.length;
    if (socket.write(piece)) continue;
    const drained = await Promise.race([
      new Promise((resolve) => socket.once("drain", () => resolve(true))),
      sleep(10_000).then(() => false),
    ]);
    if (!drained) {
      stalled = true;
      break;
    }
  }
  report.uploadSent = !stalled && !state.closed;
  if (report.uploadSent) {
    socket.write("GET /next HTTP/1.1\r\nHost: a\r\n\r\n");
    await until(() => answers(state.received).length >= 2 || state.closed, 10_000);
  }
  report.answers = answers(state.received);
  report.clientOpen = !state.closed;
} else if (scenario === "untracked-held" || scenario === "untracked-held-large") {
  // The answer to POST /a has a head the proxy does not frame (over 64 KB, in two reads), so it
  // stops tracking while the request after it is held.
  const seen = [];
  let answered = Promise.resolve();
  const upstream = await workerd((socket, head, complete) => {
    if (!complete) return;
    seen.push(pathOf(head));
    // Answers go out in order, as a server's would: each after the one before it is written.
    if (!head.startsWith("POST /a")) {
      answered = answered.then(() => socket.write(ok(pathOf(head))));
      return;
    }
    const answer = Buffer.from(
      "HTTP/1.1 200 OK\r\nX-Large: " + "x".repeat(70 * 1024) + "\r\nContent-Length: 2\r\n\r\n/a",
    );
    socket.write(answer.subarray(0, 66_000));
    answered = sleep(50).then(() => socket.write(answer.subarray(66_000)));
  });
  const { socket, state } = await client(await serve(upstream));
  // The second request is held behind the first; the large variant holds more than the 1 MB the
  // proxy reads ahead.
  const second =
    scenario === "untracked-held"
      ? "GET /b HTTP/1.1\r\nHost: a\r\n\r\n"
      : "POST /b HTTP/1.1\r\nHost: a\r\nContent-Length: " + 2 * 1024 * 1024 + "\r\n\r\n" + "y".repeat(2 * 1024 * 1024);
  socket.write("POST /a HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\n\r\nabc" + second);
  await until(() => answers(state.received).length >= 2 || state.closed, 5_000);
  socket.write("GET /c HTTP/1.1\r\nHost: a\r\n\r\n");
  await until(() => answers(state.received).length >= 3 || state.closed, 5_000);
  report.workerdSaw = seen;
  report.answers = answers(state.received);
  report.clientOpen = !state.closed;
}
await Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.ignore));
console.log(JSON.stringify(report));
process.exit(0);
`;

const runtimes = {
  node: ["--input-type=module", "--eval", probe],
  bun: ["-e", probe],
} as const;

const Report = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

/** Runs one scenario; `exited` is false when the probe was still running after 60 s. */
const scenario = (
  runtime: keyof typeof runtimes,
  name: "early-answer" | "untracked-held" | "untracked-held-large",
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make(runtime, [...runtimes[runtime], name], { cwd: path.resolve(".") }),
    );
    const result = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.timeoutOption("60 seconds"));
    if (Option.isNone(result)) return { exited: false, report: undefined } as const;
    const [stdout, stderr, exitCode] = result.value;
    expect(exitCode, stderr).toBe(0);
    const report = yield* Schema.decodeUnknownEffect(Report)(stdout.trim().split("\n").at(-1));
    return { exited: true, report } as const;
  }).pipe(Effect.scoped);

layer(NodeServices.layer, { excludeTestServices: true })("Cloud proxy keep-alive", (it) => {
  for (const runtime of Object.keys(runtimes) as Array<keyof typeof runtimes>) {
    it.effect(
      `an early answer to an upload workerd stops reading keeps the connection (${runtime})`,
      () =>
        Effect.gen(function* () {
          const run = yield* scenario(runtime, "early-answer");
          expect(run.exited, "the probe exits by itself").toBe(true);
          expect(run.report).toEqual({
            uploadSent: true,
            answers: ["refused", "/next"],
            clientOpen: true,
          });
        }),
    );

    for (const name of ["untracked-held", "untracked-held-large"] as const) {
      it.effect(`an answer it cannot frame sends the held request on (${name}, ${runtime})`, () =>
        Effect.gen(function* () {
          const run = yield* scenario(runtime, name);
          expect(run.exited, "the probe exits by itself").toBe(true);
          expect(run.report).toEqual({
            workerdSaw: ["/a", "/b", "/c"],
            answers: ["/a", "/b", "/c"],
            clientOpen: true,
          });
        }),
      );
    }
  }
});
