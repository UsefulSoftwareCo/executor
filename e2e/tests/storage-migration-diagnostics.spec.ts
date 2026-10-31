import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Storage migration diagnostics", (it) => {
  it.effect(scenarios.storageMigrationDiagnostics.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const fs = yield* FileSystem.FileSystem;
        // An interrupted upgrade can leave the column present while its journal needs repair.
        yield* legacyStorage([
          { sql: "UPDATE private_executor_settings SET value = '4.0.1' WHERE key = 'version'" },
        ]);
        yield* Effect.addFinalizer(() =>
          legacyStorage([
            { sql: "UPDATE private_executor_settings SET value = '4.0.16' WHERE key = 'version'" },
          ]).pipe(Effect.andThen(serverControl("start")), Effect.orDie),
        );
        yield* serverControl("start", 500);
        const log = yield* fs.readFileString(`${target.directory}/server.log`);
        expect(log).toContain("StorageMigrationFailed");
        expect(log).toContain("4.0.2");
        expect(log).toContain("42701");
        expect(log).not.toContain("Failed to execute migration statement:");
        expect(log).not.toContain('ADD COLUMN "generation"');
        const [rows] = yield* legacyStorage([
          { sql: "SELECT value FROM private_executor_settings WHERE key = 'version'" },
        ]);
        expect(rows).toEqual([{ value: "4.0.1" }]);
      }),
    ),
  );
});
