/**
 * The self-host product runs every statement through PGlite, 60-125 a second under the soak's
 * background load. PGlite parses each result with the instance's type parsers, 318 of them.
 * Copying that map for every result was 40% of what the product isolate allocated.
 *
 * The probe runs in its own Node process against the PGlite the self-host product installs, so
 * this checks the shipped dependency as a black box.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const probe = `
import { PGlite } from "@electric-sql/pglite";
const pg = new PGlite({ parsers: { 1114: (value) => value } });
try {
  await pg.waitReady;
  let copies = 0;
  pg.parsers = new Proxy(pg.parsers, {
    ownKeys: (target) => {
      copies += 1;
      return Reflect.ownKeys(target);
    },
  });
  const rows = [];
  for (let index = 0; index < 20; index++) {
    const result = await pg.query(
      "select $1::int4 as n, '{\\"a\\":1}'::jsonb as j, '2026-01-01 00:00:00'::timestamp as t",
      [index],
    );
    rows.push(result.rows[0]);
  }
  const copied = copies;
  const overridden = await pg.query("select 7::int4 as n, 8::int4 as m", [], {
    parsers: { 23: (value) => "int:" + value },
  });
  const after = await pg.query("select 7::int4 as n");
  console.log(JSON.stringify({ copies: copied, row: rows[3], overridden: overridden.rows[0], after: after.rows[0] }));
} finally {
  await pg.close();
}
`;

const Report = Schema.Struct({
  copies: Schema.Number,
  row: Schema.Json,
  overridden: Schema.Json,
  after: Schema.Json,
});

it.live("PGlite results parse with the instance's type parsers without copying them", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* processes.string(
      ChildProcess.make("node", ["--input-type=module", "--eval", probe], {
        cwd: path.resolve("apps/hosted/self-host"),
      }),
    );
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Report))(
      output.trim().split("\n").at(-1),
    );
    expect(report.copies, "copies of the type parser map").toBe(0);
    expect(report.row).toEqual({ n: 3, j: { a: 1 }, t: "2026-01-01 00:00:00" });
    // Parsers given for one query still override the instance's for that query only.
    expect(report.overridden).toEqual({ n: "int:7", m: "int:8" });
    expect(report.after).toEqual({ n: 7 });
  }).pipe(Effect.provide(NodeServices.layer)),
);
