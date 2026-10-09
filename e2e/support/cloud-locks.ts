/**
 * Row locks in the managed Cloud's own database, so a scenario can hold one of the server's
 * statements at a chosen moment and watch the server meanwhile, and stop the database backend
 * serving one of the server's connections. Runs the local lock fixture,
 * which ends with the scenario and rolls back what it still holds. Statements must be scoped to
 * rows the scenario created: the Cloud database is shared by every scenario of the run.
 */
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
  // Ending its input rolls back the held transaction before the fixture exits.
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
    /** Run a statement in the transaction the fixture keeps open until `release`. */
    hold: (statement: Statement) => send({ hold: statement }),
    /** Run a statement on another connection, outside the held transaction. */
    run: (statement: Statement) => send({ run: statement }),
    /** Commit the held transaction, releasing its locks. */
    release: Effect.asVoid(send({ release: true })),
    /**
     * Stop a database backend process: its connection stops answering until `resume` or until
     * the caller's scope closes, which resumes it. The fixture also resumes it when it exits.
     */
    stop: (pid: number) =>
      Effect.acquireRelease(Effect.asVoid(send({ signal: { pid, stop: true } })), () =>
        resume(pid),
      ),
    /** Resume a backend process `stop` stopped; any other process is left alone. */
    resume,
  };
});
