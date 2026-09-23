/** Standalone Executor collector. Native Effect owns the socket, workers and database. */
import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Logger } from "effect";
import { HttpServer } from "effect/unstable/http";
import { ServerLive } from "./localServer.ts";

// The parent's pipe closes even if its process crashes or is killed.
const parentClosed = Effect.callback((resume) => {
  const close = () => resume(Effect.void);
  process.stdin.once("end", close);
  process.stdin.resume();
  return Effect.sync(() => {
    process.stdin.removeListener("end", close);
    process.stdin.pause();
  });
});

BunRuntime.runMain(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    if (server.address._tag !== "TcpAddress")
      return yield* Effect.die(new Error("Expected a loopback TCP collector"));
    yield* Console.log(
      JSON.stringify({ version: 1, url: `http://127.0.0.1:${server.address.port}` }),
    );
    yield* parentClosed;
  }).pipe(
    Effect.provide(ServerLive),
    Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatJson)])),
  ),
);
