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

const start = ({ directory, version, program }: typeof StarterCommand.cases.Start.Type) =>
  ensure(directory, {
    version,
    program,
    onStart: (started) => report(StarterReport.cases.Starting.make(started)),
    onAttempt: reportAttempt,
  }).pipe(
    Effect.map((service) => StarterReport.cases.Ready.make(service)),
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
  yield* next;
  yield* Fiber.interrupt(work.value);
});

void Effect.runPromiseExit(starter.pipe(Effect.provide(NodeServices.layer))).then((exit) => {
  if (Exit.isFailure(exit)) console.error(Cause.pretty(exit.cause));
  process.exit(Exit.isSuccess(exit) ? 0 : 1);
});
