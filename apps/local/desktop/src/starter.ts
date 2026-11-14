/**
 * The desktop's server starter, run in an Electron utility process. It starts or joins the
 * background Executor for the desktop as the CLI does, reports the server over its parent port,
 * and exits when the desktop says so.
 *
 * The desktop starts its server from here so that the server keeps none of the app's streams open.
 * Electron's main process keeps its standard streams inheritable, and on Windows libuv starts each
 * child with every inheritable handle of its parent. A server started from the main process would
 * keep the desktop's stdout and stderr open after the desktop quits, so whatever waits for them to
 * close, such as a launcher or a shell pipe, would wait until the server stopped. Chromium starts a
 * utility process with only the handles it names, and Node there makes its standard streams
 * non-inheritable. On Windows a server started here still inherits this process's end of its
 * channel to the desktop, which Chromium creates inheritable; Electron still reports this process's
 * exit. The desktop gives this process a deadline in case it hangs (see `starterDeadline` in
 * `runtime.ts`). On Linux this process also holds descriptors from Chromium without close-on-exec,
 * which Bash closes before the server starts, and which a server keeps where there is no /bin/bash
 * (see `withoutInherited`); macOS starts each child with only the descriptors it names.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, Fiber, Option, Queue, Schema } from "effect";
import { ensure } from "../../server/src/implementation/service-client.ts";
import {
  StarterAttempt,
  StarterCommand,
  StarterDirectoryFailed,
  StarterReport,
} from "./contracts/desktop.ts";

const post = (encoded: unknown) => Effect.sync(() => process.parentPort.postMessage(encoded));

const report = (message: StarterReport) =>
  Schema.encodeEffect(StarterReport)(message).pipe(Effect.flatMap(post), Effect.orDie);

const tell = (message: StarterAttempt) =>
  Schema.encodeEffect(StarterAttempt)(message).pipe(Effect.flatMap(post), Effect.orDie);

/** Say that a start attempt began, and later that it exited, for as long as this process runs. */
const reportAttempt = ({
  pid,
  exited,
}: {
  readonly pid: number;
  readonly exited: Effect.Effect<void>;
}) =>
  tell(StarterAttempt.cases.AttemptStarted.make({ pid })).pipe(
    Effect.andThen(
      Effect.forkDetach(
        Effect.andThen(exited, tell(StarterAttempt.cases.AttemptExited.make({ pid }))),
      ),
    ),
    Effect.asVoid,
  );

/** Start or join the server and report the outcome; a failure is reported, not raised. */
const start = ({ directory, version, program }: typeof StarterCommand.cases.Start.Type) =>
  ensure(directory, {
    version,
    program,
    onStart: (started) => report(StarterReport.cases.Starting.make(started)),
    onAttempt: reportAttempt,
  }).pipe(
    Effect.map((service) => StarterReport.cases.Ready.make(service)),
    // The program names its version, so `ensure` never reads it from the configuration.
    Effect.catchTag("ConfigError", Effect.die),
    Effect.catchTag("PlatformError", () => Effect.fail(new StarterDirectoryFailed())),
    Effect.catch((error) => Effect.succeed(StarterReport.cases.Failed.make({ error }))),
    Effect.flatMap(report),
  );

const starter = Effect.gen(function* () {
  const commands = yield* Queue.unbounded<unknown>();
  process.parentPort.on("message", ({ data }) => {
    Queue.offerUnsafe(commands, data);
  });
  const next = Queue.take(commands).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(StarterCommand)),
  );
  const work = yield* StarterCommand.match(yield* next, {
    Start: (request) => Effect.map(Effect.forkChild(start(request)), Option.some),
    Stop: () => Effect.succeed(Option.none()),
  });
  if (Option.isNone(work)) return;
  // Every later command ends the starter. The desktop sends one once it has the outcome, or when
  // it no longer needs one; interrupting `ensure` asks the attempts it began to exit.
  yield* next;
  yield* Fiber.interrupt(work.value);
});

void Effect.runPromiseExit(starter.pipe(Effect.provide(NodeServices.layer))).then((exit) => {
  if (Exit.isFailure(exit)) console.error(Cause.pretty(exit.cause));
  process.exit(Exit.isSuccess(exit) ? 0 : 1);
});
