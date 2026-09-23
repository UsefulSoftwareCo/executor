/** Bounded synthetic workload; a failed/ambiguous mutation is never retried. */
import assert from "node:assert/strict";
import { Schema } from "effect";

const Metrics = Schema.Struct({
  rowsRead: Schema.Number,
  rowsWritten: Schema.Number,
  statements: Schema.Number,
});
const Result = Schema.Struct({ ok: Schema.Boolean, value: Schema.Unknown, metrics: Metrics });
const samples = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    requests: values.length,
    p50ms: sorted[Math.floor(sorted.length * 0.5)],
    p95ms: sorted[Math.floor(sorted.length * 0.95)],
    maxMs: sorted.at(-1),
  };
};
/** Run tasks through a fixed client pool; collect every outcome before progressing. */
export const pool = async (
  count: number,
  concurrency: number,
  task: (index: number) => Promise<void>,
) => {
  let next = 0;
  let failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      while (next < count && !failed) {
        const index = next++;
        try {
          await task(index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0)
    throw new Error(`Workload failed: ${errors.length} requests; ${String(errors[0])}`);
};
/** One million records across 1,000 databases, then read and hot-app concurrency ramps. */
export const scale = async (
  send: (
    app: string,
    body: unknown,
  ) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>,
) => {
  const reports: unknown[] = [];
  const run = async (
    name: string,
    count: number,
    concurrency: number,
    request: (index: number) => { app: string; body: unknown },
    check: (value: unknown) => void,
  ) => {
    const durations: number[] = [];
    const total = { rowsRead: 0, rowsWritten: 0, statements: 0 };
    const start = performance.now();
    await pool(count, concurrency, async (index) => {
      const input = request(index);
      const begin = performance.now();
      const response = await send(input.app, input.body);
      assert.equal(
        response.status,
        200,
        `${name} request ${index} failed: ${response.status === 200 ? "" : (await response.text()).slice(0, 1200)}`,
      );
      const result = Schema.decodeUnknownSync(Result)(await response.json());
      assert.equal(result.ok, true);
      check(result.value);
      for (const key of ["rowsRead", "rowsWritten", "statements"] as const)
        total[key] += result.metrics[key];
      durations.push(performance.now() - begin);
    });
    const report = {
      name,
      concurrency,
      elapsedMs: performance.now() - start,
      ...samples(durations),
      ...total,
    };
    reports.push(report);
    console.log(JSON.stringify(report));
  };
  const insert = (count: number, app: string) => ({
    app,
    body: {
      write: true,
      metrics: true,
      summary: true,
      operations: Array.from({ length: count }, (_, score) => ({
        kind: "insert",
        table: "messages",
        value: { mailbox: app, score },
      })),
    },
  });
  const query = (app: string, terminal: unknown) => ({
    app,
    body: {
      write: false,
      metrics: true,
      operations: [
        {
          kind: "query",
          plan: {
            table: "messages",
            index: "by_mailbox",
            clauses: [{ field: "mailbox", op: "eq", value: app }],
            order: "asc",
          },
          terminal,
        },
      ],
    },
  });
  if (!process.argv.includes("--hot")) {
    await run(
      "seed-1000000",
      1000,
      10,
      (index) => insert(1000, `scale-${index}`),
      (value) => assert.equal(value, 1000),
    );
    await run(
      "verify-all-partitions",
      1000,
      20,
      (index) => query(`scale-${index}`, { kind: "count" }),
      (value) => assert.deepEqual(value, [1000]),
    );
    for (const concurrency of [1, 10, 50, 100]) {
      await run(
        `indexed-read-${concurrency}`,
        200,
        concurrency,
        (index) => query(`scale-${index}`, { kind: "take", count: 10 }),
        (value) => {
          const pages = Schema.decodeUnknownSync(
            Schema.Array(Schema.Array(Schema.Struct({ score: Schema.Number }))),
          )(value);
          assert.deepEqual(
            pages[0]?.map((row) => row.score),
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
          );
        },
      );
    }
  }
  await run(
    "hot-app-100",
    200,
    100,
    () => insert(5, "hot"),
    (value) => assert.equal(value, 5),
  );
  await run(
    "verify-hot-app",
    1,
    1,
    () => query("hot", { kind: "count" }),
    (value) => assert.deepEqual(value, [1000]),
  );
  return reports;
};
