/**
 * Local-only lock holder for scenarios that pause one of the managed Cloud's own statements at a
 * chosen moment. Reads one JSON command per line on stdin and answers each with one JSON line of
 * rows: `{"hold": statement}` runs a statement in a transaction it keeps open, such as a
 * `select ... for update` of a row the scenario created; `{"run": statement}` runs one on a second
 * connection, outside that transaction; `{"release": true}` commits; `{"signal": {"pid", "stop"}}`
 * stops (`true`) or resumes (`false`) one database backend process, so its connection stops
 * answering, as a stalled server or network would. Resuming a backend the fixture did not stop
 * does nothing. Closing stdin rolls back what is still held and resumes every backend still
 * stopped, as does any other exit of the fixture.
 * Never installed in the HTTP server; scenarios must scope their statements to rows they created
 * and signal only backends serving their own requests.
 */
import { createInterface } from "node:readline";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Pool, type PoolClient } from "pg";
import { Config, Effect, FileSystem, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { LocalDatabaseUrl } from "../cloud/src/contracts/database.ts";

const Statement = Schema.Struct({
  sql: Schema.NonEmptyString,
  params: Schema.optional(
    Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])),
  ),
});
const Instruction = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ hold: Statement }),
    Schema.Struct({ run: Statement }),
    Schema.Struct({ release: Schema.Literal(true) }),
    Schema.Struct({ signal: Schema.Struct({ pid: Schema.Int, stop: Schema.Boolean }) }),
  ]),
);
const Container = Schema.fromJsonString(
  Schema.Struct({
    container: Schema.NonEmptyString,
    dockerHost: Schema.NonEmptyString,
    dockerConfig: Schema.NonEmptyString,
  }),
);

const command = Command.make("cloud-locks-fixture", {
  configuration: Flag.String("configuration"),
  container: Flag.String("container"),
}).pipe(
  Command.withHandler((args) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Config.String("NODE_ENV").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literal("test"))),
        );
        const fs = yield* FileSystem.FileSystem;
        const configuration = yield* fs
          .readFileString(args.configuration)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.Struct({ database: Schema.String })),
              ),
            ),
          );
        const database = yield* Schema.decodeUnknownEffect(LocalDatabaseUrl)(
          Redacted.make(configuration.database),
        );
        const postgres = yield* fs
          .readFileString(args.container)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Container)));
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const signal = (pid: number, stop: boolean) =>
          processes
            .exitCode(
              ChildProcess.make(
                "docker",
                ["exec", postgres.container, "kill", stop ? "-STOP" : "-CONT", String(pid)],
                {
                  env: {
                    PATH: process.env.PATH ?? "",
                    DOCKER_HOST: postgres.dockerHost,
                    DOCKER_CONFIG: postgres.dockerConfig,
                  },
                  extendEnv: false,
                  stdout: "ignore",
                  stderr: "inherit",
                },
              ),
            )
            .pipe(
              Effect.flatMap((code) =>
                code === 0 ? Effect.void : Effect.die(new Error(`Cannot signal backend ${pid}`)),
              ),
              Effect.runPromise,
            );
        const pool = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: Redacted.value(database), max: 2 })),
          (pool) => Effect.promise(() => pool.end()),
        );
        const holder = yield* Effect.acquireRelease(
          Effect.promise(() => pool.connect()),
          (client) =>
            Effect.promise(async () => {
              await client.query("rollback");
              client.release();
            }),
        );
        // Each stopped backend with its stop signal, tracked before the signal is sent, so an exit
        // at any point resumes the backend once that signal has finished. Acquired last, so it is
        // released first.
        const stopped = yield* Effect.acquireRelease(
          Effect.sync(() => new Map<number, Promise<void>>()),
          (pids) =>
            Effect.promise(() =>
              Promise.allSettled(
                [...pids].map(([pid, stopping]) =>
                  stopping.catch(() => undefined).then(() => signal(pid, false)),
                ),
              ).then(() => pids.clear()),
            ),
        );
        const decode = Schema.decodeUnknownSync(Instruction);
        yield* Effect.promise(async () => {
          let open = false;
          const run = (client: Pool | PoolClient, { sql, params }: typeof Statement.Type) =>
            client.query(sql, [...(params ?? [])]).then((result) => result.rows);
          for await (const line of createInterface({ input: process.stdin })) {
            const instruction = decode(line);
            let rows: ReadonlyArray<unknown> = [];
            if ("hold" in instruction) {
              if (!open) await holder.query("begin");
              open = true;
              rows = await run(holder, instruction.hold);
            } else if ("run" in instruction) {
              rows = await run(pool, instruction.run);
            } else if ("signal" in instruction) {
              const { pid, stop } = instruction.signal;
              if (stop) {
                const stopping = signal(pid, true);
                stopped.set(pid, stopping);
                await stopping;
              } else if (stopped.has(pid)) {
                await signal(pid, false);
                stopped.delete(pid);
              }
            } else {
              await holder.query("commit");
              open = false;
            }
            process.stdout.write(`${JSON.stringify(rows)}\n`);
          }
        });
      }),
    ),
  ),
);

NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
);
