/**
 * Local-only: expire one evaluated result kept in the managed Cloud's app data supervisors, as a
 * day passing does, so the supervisor's next command removes it and a read of it misses. The
 * supervisors are Alchemy's local Durable Objects, each a SQLite file under `directory`; only rows
 * of the exact `key` are changed. Prints how many rows were expired. Never installed in a server.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DatabaseSync } from "node:sqlite";
import { Config, Console, Effect, FileSystem, Schema } from "effect";
import { Command, Flag } from "effect/cli";

const command = Command.make("cloud-evaluated-fixture", {
  directory: Flag.String("directory"),
  key: Flag.String("key"),
}).pipe(
  Command.withHandler((args) =>
    Effect.gen(function* () {
      yield* Config.String("NODE_ENV").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literal("test"))),
      );
      const fs = yield* FileSystem.FileSystem;
      const supervisors = (yield* fs.readDirectory(args.directory)).filter((name) =>
        name.endsWith("-AppDataSupervisor"),
      );
      let expired = 0;
      for (const supervisor of supervisors)
        for (const name of yield* fs.readDirectory(`${args.directory}/${supervisor}`)) {
          if (!name.endsWith(".sqlite")) continue;
          const database = new DatabaseSync(`${args.directory}/${supervisor}/${name}`, {
            timeout: 2_000,
          });
          try {
            const table = database
              .prepare("SELECT 1 FROM sqlite_master WHERE name = 'executor_evaluated'")
              .get();
            if (table !== undefined)
              expired += Number(
                database
                  .prepare("UPDATE executor_evaluated SET until = 0 WHERE key = ?")
                  .run(args.key).changes,
              );
          } finally {
            database.close();
          }
        }
      yield* Console.log(JSON.stringify({ expired }));
    }),
  ),
);

NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
);
