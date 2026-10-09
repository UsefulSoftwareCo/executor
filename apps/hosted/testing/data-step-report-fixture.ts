/**
 * Local-only restart of one data step's Cloud report run, as a deploy that sets a new
 * `CLOUD_DATA_STEPS_REPORT` label restarts it: the old run's rows keep their outcomes under an
 * archived label, and the Worker's next tick starts the step's first pass over every app that
 * exists then. A scenario can then observe a run whose items include its own apps, which a run
 * the managed Cloud started before the scenario never does. Only report runs are restarted, and
 * only while no pass holds the run; otherwise it restarts nothing and says whether a pass holds it.
 * Never installed in the HTTP server.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Pool } from "pg";
import { Config, Console, Effect, FileSystem, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { LocalDatabaseUrl } from "../cloud/src/contracts/database.ts";

/**
 * In one statement: lock the run unless a pass holds its lease, then move its outcomes and its
 * journal row to the archived label. A tick that claims the run meanwhile waits for the lock and
 * then finds no row under the Worker's label, so the next tick starts a first pass.
 */
const restart = `
WITH held AS (
  SELECT name, run FROM private_hosted_data_steps
  WHERE name = $1 AND run = $2 AND (lease_until IS NULL OR lease_until < now())
  FOR UPDATE
), items AS (
  UPDATE private_hosted_data_step_items AS item SET run = $3 FROM held
  WHERE item.name = held.name AND item.run = held.run
)
UPDATE private_hosted_data_steps AS step SET run = $3 FROM held
WHERE step.name = held.name AND step.run = held.run
RETURNING step.name`;

const command = Command.make("data-step-report-fixture", {
  configuration: Flag.String("configuration"),
  step: Flag.String("step"),
  run: Flag.String("run"),
}).pipe(
  Command.withHandler((args) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Config.String("NODE_ENV").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literal("test"))),
        );
        // An apply run writes to apps; only a report, which writes nothing, may start over.
        if (!/^\d+_[a-z0-9_]+$/.test(args.step) || !/^report:[\w.-]+$/.test(args.run))
          return yield* Effect.die("Expected a data step name and one of its report runs");
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
        const pool = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: Redacted.value(database), max: 1 })),
          (pool) => Effect.promise(() => pool.end()),
        );
        const archived = `${args.run}:restarted-${Date.now()}`;
        const restarted = yield* Effect.promise(() =>
          pool.query(restart, [args.step, args.run, archived]),
        );
        const held = yield* Effect.promise(() =>
          pool.query(
            `SELECT count(*)::int AS held FROM private_hosted_data_steps
             WHERE name = $1 AND run = $2 AND lease_until >= now()`,
            [args.step, args.run],
          ),
        );
        const [state] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ held: Schema.Number })]),
        )(held.rows);
        yield* Console.log(
          JSON.stringify({ restarted: restarted.rowCount === 1, held: state.held > 0 }),
        );
      }),
    ),
  ),
);

NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
);
