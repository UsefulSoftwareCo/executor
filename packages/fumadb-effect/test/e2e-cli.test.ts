/**
 * End-to-end: the CLI drives the real SQL migrator on a real database.
 */
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect } from "vitest";
import { makeCli } from "../src/implementation/cli.ts";
import { fumadb } from "../src/index.ts";
import { sqlAdapter } from "../src/implementation/sql/index.ts";
import { providers, withProvider } from "./support/databases.ts";
import { migrateV1, migrateV2 } from "./support/schemas.ts";

const TestDB = fumadb({ namespace: "clitest", schemas: [migrateV1, migrateV2] });

for (const provider of providers) {
  it.live(
    `cli end to end: ${provider}`,
    () =>
      Effect.gen(function* () {
        yield* withProvider(
          provider,
          Effect.gen(function* () {
            const client = TestDB.client(sqlAdapter({ provider }));
            const cli = makeCli({ db: client, command: "clitest", version: "0.0.0" });
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fumadb-cli-"));
            const output = path.join(dir, "out", "migration.sql");

            yield* cli.run(["migrate:up"]);
            expect(yield* client.version).toBe("1.0.0");

            yield* cli.run(["generate", "2.0.0", "--output", output]);
            const script = fs.readFileSync(output, "utf8");
            expect(script.length).toBeGreaterThan(0);
            // generate must not apply anything
            expect(yield* client.version).toBe("1.0.0");

            // Round-tripping 2.0.0 -> 1.0.0 needs the column 2.0.0 removed to
            // be gone, so both steps ask for the destructive operations.
            yield* cli.run(["migrate:to", "latest", "--unsafe"]);
            expect(yield* client.version).toBe("2.0.0");

            yield* cli.run(["migrate:down", "--unsafe"]);
            expect(yield* client.version).toBe("1.0.0");

            const sql = yield* SqlClient.SqlClient;
            void sql;
            const migrator = yield* client.createMigrator;
            expect(Option.isSome(yield* migrator.next)).toBe(true);
            fs.rmSync(dir, { recursive: true, force: true });
          }).pipe(Effect.provide(NodeServices.layer)),
        );
      }),
    { timeout: 120_000 },
  );
}
