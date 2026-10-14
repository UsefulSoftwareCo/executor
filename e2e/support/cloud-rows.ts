import { randomBytes } from "node:crypto";
import { Effect, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Target } from "./platform.ts";

export interface RowStatement {
  readonly sql: string;
  readonly params?: ReadonlyArray<string>;
}

/**
 * Apply statements in one transaction to a managed Cloud database: Cloud's own
 * (`sso-database.json`) or the emulated v1 database (`v1-database.json`). Returns each
 * statement's rows.
 */
export const writeRows = (
  database: "sso-database.json" | "v1-database.json",
  statements: ReadonlyArray<RowStatement>,
) =>
  Effect.gen(function* () {
    const target = yield* Target,
      fs = yield* FileSystem.FileSystem,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const file = `${target.directory}/v1-rows-${randomBytes(6).toString("hex")}.json`;
    yield* fs.writeFileString(file, JSON.stringify(statements), { mode: 0o600 });
    const output = yield* processes
      .string(
        ChildProcess.make(
          "node",
          [
            "apps/hosted/testing/cloud-rows-fixture.ts",
            "--configuration",
            `${target.directory}/${database}`,
            "--statements",
            file,
          ],
          { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, extendEnv: false },
        ),
      )
      .pipe(Effect.ensuring(fs.remove(file).pipe(Effect.ignore)));
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Schema.Array(Schema.Unknown))),
    )(output);
  });
