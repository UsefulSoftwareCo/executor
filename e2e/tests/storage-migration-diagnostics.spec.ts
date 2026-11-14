import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Version = Schema.Tuple([Schema.Struct({ value: Schema.String })]);
const readVersion = { sql: "SELECT value FROM private_executor_settings WHERE key = 'version'" };

layer(TestLive, { excludeTestServices: true })("Storage migration diagnostics", (it) => {
  it.effect(scenarios.storageMigrationDiagnostics.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const fs = yield* FileSystem.FileSystem;
        const [current] = yield* legacyStorage([readVersion]);
        const [{ value: version }] = Schema.decodeUnknownSync(Version)(current);
        // The journal is put back as it was, whatever version this release records.
        yield* Effect.addFinalizer(() =>
          legacyStorage([
            {
              sql: "UPDATE private_executor_settings SET value = $1 WHERE key = 'version'",
              params: [version],
            },
          ]).pipe(Effect.andThen(serverControl("start")), Effect.orDie),
        );
        // An interrupted upgrade can leave the column present while its journal needs repair.
        yield* legacyStorage([
          { sql: "UPDATE private_executor_settings SET value = '4.0.1' WHERE key = 'version'" },
        ]);
        yield* serverControl("start", 500);
        const log = yield* fs.readFileString(`${target.directory}/server.log`);
        expect(log).toContain("StorageMigrationFailed");
        expect(log).toContain("at executor version 4.0.2:");
        expect(log).toContain("(SQLSTATE 42701)");
        // Neither the statement nor the driver's message, which names the table, is kept.
        expect(log).not.toContain("Failed to execute migration statement:");
        expect(log.toLowerCase()).not.toContain('add column "generation"');
        expect(log.toLowerCase()).not.toContain('column "generation"');
        const [rows] = yield* legacyStorage([readVersion]);
        expect(rows).toEqual([{ value: "4.0.1" }]);
      }),
    ),
  );
});
