import { Effect, Queue, Schema, Stream, type Cause, type PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Target } from "./platform.ts";

export interface Statement {
  readonly sql: string;
  readonly params?: ReadonlyArray<string | number | boolean | null>;
}
const Rows = Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)));

export const cloudLocks = Effect.gen(function* () {
  const target = yield* Target,
    processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const commands = yield* Queue.unbounded<string, Cause.Done>();
  const child = yield* processes.spawn(
    ChildProcess.make(
      "node",
      [
        "apps/hosted/testing/cloud-locks-fixture.ts",
        "--configuration",
        `${target.directory}/sso-database.json`,
        "--container",
        `${target.directory}/postgres-container.json`,
      ],
      {
        env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
        extendEnv: false,
        stdin: Stream.fromQueue(commands).pipe(
          Stream.map((line) => `${line}\n`),
          Stream.encodeText,
        ),
        stderr: "inherit",
      },
    ),
  );
  yield* Effect.addFinalizer(() => Queue.end(commands));
  const replies = yield* Queue.unbounded<string, PlatformError.PlatformError | Cause.Done>();
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runIntoQueue(replies),
    Effect.forkScoped,
  );
  const send = (instruction: unknown) =>
    Queue.offer(commands, JSON.stringify(instruction)).pipe(
      Effect.andThen(Queue.take(replies)),
      Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
      Effect.timeout("30 seconds"),
      Effect.orDie,
    );
  const resume = (pid: number) => Effect.asVoid(send({ signal: { pid, stop: false } }));
  return {
    hold: (statement: Statement) => send({ hold: statement }),
    run: (statement: Statement) => send({ run: statement }),
    release: Effect.asVoid(send({ release: true })),
    stop: (pid: number) =>
      Effect.acquireRelease(Effect.asVoid(send({ signal: { pid, stop: true } })), () =>
        resume(pid),
      ),
    resume,
    refuseConnections: Effect.acquireRelease(Effect.asVoid(send({ connections: false })), () =>
      Effect.asVoid(send({ connections: true })),
    ),
  };
});
