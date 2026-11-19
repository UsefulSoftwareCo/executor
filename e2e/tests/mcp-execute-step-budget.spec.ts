/**
 * Execute runs programs in an interpreter on the product's own thread. A program that only computes
 * used to run until its five-minute wall-time budget, keeping the product busy all that time: on
 * production one program spent 203 s in the interpreter and other requests slowed until clients
 * gave up. The step budget stops such a program with `TimeoutExceeded` long before its wall time,
 * whatever its own `catch` does, while other requests keep answering and an ordinary program that
 * calls tools and loops still completes. Native calls are charged for the data they read and
 * return, so a loop of large `split` calls, one step each, stops in seconds too, and so are
 * operators that walk or coerce a whole value. A value a call returns that the program already
 * holds, such as a group `Map.get` returns, is not charged, so grouping many rows into few groups
 * completes. Storing a value walks it once to reject cycles; that walk is charged, and a value
 * whose graph was walked is not walked again until something changes inside it, so attaching one
 * shared value to every row completes, even one of 1,000 records, while storing a row into that
 * shared value is still rejected as a cycle.
 * Storing the value a property already holds skips that walk, so grouping row objects with
 * `g[k] = g[k] || []` completes. Joining strings with `+` or a template is charged by the length
 * of the result, so a loop that joins a megabyte string stops in seconds.
 */
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";

/** The products' default `maxSteps` (`defaultMcpLimits` in packages/mcp). */
const defaultMaxSteps = 5_000_000;
/** The products' default wall-time budget, which the runaway program must end well inside. */
const defaultTimeoutMs = 5 * 60_000;

const Executed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
    toolCalls: Schema.Array(Schema.Struct({ name: Schema.String, outcome: Schema.String })),
  }),
});

type Connected = Effect.Success<ReturnType<Effect.Success<typeof McpClient>["connect"]>>;

const execute = (client: Connected, name: string, code: string) =>
  Effect.gen(function* () {
    const [took, { execution }] = yield* client
      .use(`Run the ${name} program`, (client, signal) =>
        client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
      )
      .pipe(
        Effect.flatMap((result) => Schema.decodeUnknownEffect(Executed)(result.structuredContent)),
        Effect.timed,
      );
    const ms = Math.round(Duration.toMillis(took));
    yield* (yield* Evidence).json(`${name}.json`, { ms, execution });
    return { ms, execution };
  });

/** Connects to hosted MCP execute with a new API key for the owner, deleted when the case ends. */
const connectHosted = (label: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      mcp = yield* McpClient;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", { name: label }),
    );
    yield* Effect.addFinalizer(() =>
      api
        .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    return yield* mcp.connect(key.key, label, { organization: actors.organization.id });
  });

/** Calls a tool every product serves without setup, then loops briefly, as ordinary programs do. */
const ordinary = `
const found = await tools.search({ query: 'executor', limit: 1 });
let sum = 0;
for (let i = 0; i < 1000; i++) sum += i;
return { items: Array.isArray(found.items), sum };`;
const ordinaryValue = { items: true, sum: 499_500 };

/**
 * Never returns on its own, and tries to outlast the budget: each iteration catches what it
 * throws and runs a finally block, and the program returns from its outer catch.
 */
const runaway = `
let n = 0;
try {
  while (true) {
    try { n++; if (n % 1000 === 0) throw new Error('again'); } catch (e) { n++; } finally { n++; }
  }
} catch (e) {
  return 'caught: ' + String(e);
}`;

/**
 * The review's proof that native calls escaped the budget: each `split` is one step, but builds a
 * million-element array. Uncharged, it ran 83 s and outlasted a 60 s wall-time budget.
 */
const nativeRunaway = `
const s = "x".repeat(1000000);
let n = 0;
for (let i = 0; i < 100000; i++) { n += s.split("").length }
return n;`;

/**
 * The review's proof that operators escaped the budget: comparing a million-element array to a
 * string coerces the whole array each time, in one step. Uncharged, it ran to the wall clock.
 */
const operatorRunaway = `
const a = Array.from({ length: 1000000 }, (_, i) => i);
let n = 0;
for (let i = 0; i < 100000; i++) { if (a == "x") n++ }
return n;`;

/**
 * The review's realistic operator proof: merging 20,000 records into an index of 20,000 by checking
 * `id in index`. `in` walked the whole index on every check and this ran to the 120 s wall
 * clock; it reads one key now.
 */
const dedupeWithIn = `
const a = Array.from({ length: 20000 }, (_, i) => ({ id: 'r' + i, name: 'n' + i, tags: ['x', 'y'] }));
const b = Array.from({ length: 20000 }, (_, i) => ({ id: 'r' + i * 2, name: 'm' + i, tags: ['z'] }));
const byId = {};
for (const r of a) byId[r.id] = r;
let added = 0;
for (const r of b) { if (!(r.id in byId)) { byId[r.id] = r; added++ } }
return added;`;

/**
 * Groups 50,000 rows into a few groups with `Map.get`, which returns a group of thousands of rows
 * every time. Charging that group as if copied stopped it in under a second.
 */
const groupBy = (groups: number) => `
const rows = Array.from({ length: 50000 }, (_, i) => ({ k: 'k' + (i % ${groups}), v: i }));
const g = new Map();
for (const r of rows) { const a = g.get(r.k) ?? []; a.push(r.v); g.set(r.k, a) }
return g.size;`;

/**
 * The same grouping into an object, reassigning each group after the push. Storing a group walked
 * it to reject cycles, thousands of rows every time, uncharged; the walk now stops at groups
 * already known to hold no objects.
 */
const groupByObject = `
const rows = Array.from({ length: 50000 }, (_, i) => ({ k: 'k' + (i % 10), v: i }));
const g = {};
for (const r of rows) { const a = g[r.k] || []; a.push(r.v); g[r.k] = a }
return Object.keys(g).length;`;

/**
 * Attaches one shared value of 50,000 columns to each of 20,000 rows. Each store walked all
 * 50,000 columns, uncharged, and ran for minutes.
 */
const sharedMeta = `
const meta = { columns: Array.from({ length: 50000 }, (_, i) => 'c' + i) };
const rows = Array.from({ length: 20000 }, (_, i) => ({ id: i }));
for (const r of rows) { r.meta = meta }
return rows.length;`;

/**
 * Attaches one shared value of 1,000 records, each an object, to each of 20,000 rows. Each store
 * walked all 1,000 records, about 500 steps, and the program stopped at the budget halfway.
 */
const sharedRecordsMeta = `
const meta = { records: Array.from({ length: 1000 }, (_, i) => ({ id: 'm' + i, label: 'L' + i, w: i })) };
const rows = [];
for (let i = 0; i < 20000; i++) rows.push({ id: i, meta });
return rows.length;`;

/**
 * Stores rows holding the shared value, then a row into one of its records: the walk must not stop
 * at the shared value it walked before, because the record it changes is inside it.
 */
const sharedMetaCycle = `
const meta = { records: Array.from({ length: 1000 }, (_, i) => ({ id: 'm' + i })) };
const rows = [];
for (let i = 0; i < 10; i++) rows.push({ id: i, meta });
try { meta.records[5].back = rows[3]; return 'stored'; } catch (e) { return String(e) }`;

/**
 * The review's proof that string `+` escaped the budget: joining a megabyte string to a number is
 * one step, and reading the result copies the megabyte. Uncharged, it ran to the wall clock.
 */
const concatRunaway = `
const s = "x".repeat(1000000);
let n = 0;
for (let i = 0; i < 1000000; i++) { const t = s + i; n += t.charCodeAt(500000) }
return n;`;

/**
 * Groups 50,000 row objects into 10 groups by storing each group back into itself before the push.
 * The store walked the whole group, every row in it, on every row, and stopped at the budget.
 */
const groupRowsOrPush = `
const rows = Array.from({ length: 50000 }, (_, i) => ({ k: 'k' + (i % 10), v: i, name: 'n' + i }));
const g = {};
for (const r of rows) { g[r.k] = g[r.k] || []; g[r.k].push(r) }
return Object.keys(g).length;`;

/** The same grouping in the `reduce` form. */
const groupRowsReduce = `
const rows = Array.from({ length: 50000 }, (_, i) => ({ k: 'k' + (i % 10), v: i, name: 'n' + i }));
const g = rows.reduce((acc, r) => { (acc[r.k] = acc[r.k] || []).push(r); return acc }, {});
return Object.keys(g).length;`;

/**
 * The review's proof that templates escaped the budget: interpolating a megabyte string is one
 * step, and reading the result copies the megabyte. Uncharged, it ran to the wall clock.
 */
const templateRunaway = `
const s = "x".repeat(1000000);
let n = 0;
for (let i = 0; i < 1000000; i++) { const t = \`\${s}\${i}\`; n += t.charCodeAt(500000) }
return n;`;

/** Filters and maps 10,000 records, as programs do with a large tool result. */
const recordsTransform = `
const records = Array.from({ length: 10000 }, (_, i) => ({ id: 'r' + i, price: i % 100, tags: ['a', 'b'] }));
const cheap = records.filter((record) => record.price < 50).map((record) => ({ id: record.id, price: record.price * 2 }));
return { kept: cheap.length, json: JSON.stringify(cheap).length > 0 };`;

/**
 * Three tool calls with a 200,000-iteration loop between them: several times the interpreter work
 * of the programs agents send, which spend well under a second before their first call.
 */
const heavyButFine = `
const first = await tools.search({ query: 'executor', limit: 1 });
let total = 0;
for (let i = 0; i < 200000; i++) total = (total + i) % 1000003;
const second = await tools.search({ query: 'github', limit: 1 });
const third = await tools.search({ query: 'slack', limit: 1 });
return { total, calls: [first, second, third].length };`;

layer(HostedLive, { excludeTestServices: true })("Hosted MCP execute step budget", (it) => {
  it.effect(
    scenarios.mcpExecuteStepBudget.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const evidence = yield* Evidence;
          const runner = yield* connectHosted("execute-step-budget-runaway");
          const other = yield* connectHosted("execute-step-budget-other");

          // How long the ordinary program takes on this server when nothing else runs.
          const quiet: Array<number> = [];
          for (let round = 0; round < 3; round++) {
            const { ms, execution } = yield* execute(other, `ordinary-quiet-${round}`, ordinary);
            expect(execution).toMatchObject({ ok: true, value: ordinaryValue });
            quiet.push(ms);
          }

          // The runaway program runs while the other caller keeps sending ordinary programs.
          const running = yield* Effect.forkChild(execute(runner, "runaway", runaway));
          const finished = Effect.sync(() => running.pollUnsafe() !== undefined);
          const busy: Array<number> = [];
          while (!(yield* finished)) {
            const { ms, execution } = yield* execute(
              other,
              `ordinary-busy-${busy.length}`,
              ordinary,
            );
            expect(execution).toMatchObject({ ok: true, value: ordinaryValue });
            // Only rounds that ended while the runaway program still ran count as beside it.
            if (!(yield* finished)) busy.push(ms);
          }
          const stopped = yield* Fiber.join(running);

          // It fails as a timeout that names the budget, although its own catch tried to return.
          expect(stopped.execution).toMatchObject({
            ok: false,
            error: {
              kind: "TimeoutExceeded",
              message: expect.stringContaining(
                `Execution exceeded its compute budget of ${defaultMaxSteps} interpreter steps`,
              ),
            },
            toolCalls: [],
          });
          expect(stopped.execution.error?.message).toContain("move heavy computation");
          // Far inside the five-minute wall-time budget it would otherwise have run to.
          expect(stopped.ms).toBeLessThan(defaultTimeoutMs / 5);

          // Other callers kept being answered while it ran, and promptly.
          expect(busy.length).toBeGreaterThanOrEqual(3);
          const slowestQuiet = Math.max(...quiet);
          expect(Math.max(...busy)).toBeLessThan(Math.max(5_000, slowestQuiet * 20));

          // An ordinary program that calls tools between longer loops still completes.
          const fine = yield* execute(runner, "heavy-but-fine", heavyButFine);
          expect(fine.execution).toMatchObject({
            ok: true,
            value: { total: expect.any(Number), calls: 3 },
          });
          expect(fine.execution.toolCalls.map((call) => call.outcome)).toEqual([
            "success",
            "success",
            "success",
          ]);

          // A loop of large native calls stops at the same budget, in seconds.
          const native = yield* execute(runner, "native-runaway", nativeRunaway);
          expect(native.execution).toMatchObject({
            ok: false,
            error: {
              kind: "TimeoutExceeded",
              message: expect.stringContaining(
                `Execution exceeded its compute budget of ${defaultMaxSteps} interpreter steps`,
              ),
            },
          });
          expect(native.ms).toBeLessThan(20_000);

          // So does a loop of operators that coerce a whole array.
          const operator = yield* execute(runner, "operator-runaway", operatorRunaway);
          expect(operator.execution).toMatchObject({
            ok: false,
            error: {
              kind: "TimeoutExceeded",
              message: expect.stringContaining(
                `Execution exceeded its compute budget of ${defaultMaxSteps} interpreter steps`,
              ),
            },
          });
          expect(operator.ms).toBeLessThan(20_000);

          // Checking membership with `in` against a large index stays fast and inside it.
          const dedupe = yield* execute(runner, "dedupe-with-in", dedupeWithIn);
          expect(dedupe.execution).toMatchObject({ ok: true, value: 10000 });
          expect(dedupe.ms).toBeLessThan(20_000);

          // Grouping 50,000 rows into 10 or 50 groups completes.
          const grouped10 = yield* execute(runner, "group-by-10", groupBy(10));
          expect(grouped10.execution).toMatchObject({ ok: true, value: 10 });
          const grouped50 = yield* execute(runner, "group-by-50", groupBy(50));
          expect(grouped50.execution).toMatchObject({ ok: true, value: 50 });

          // Grouping into an object and attaching a shared value to every row complete promptly.
          const groupedObject = yield* execute(runner, "group-by-object", groupByObject);
          expect(groupedObject.execution).toMatchObject({ ok: true, value: 10 });
          expect(groupedObject.ms).toBeLessThan(20_000);
          const shared = yield* execute(runner, "shared-meta", sharedMeta);
          expect(shared.execution).toMatchObject({ ok: true, value: 20000 });
          expect(shared.ms).toBeLessThan(20_000);
          // Also when that value holds 1,000 records, each an object.
          const sharedRecords = yield* execute(runner, "shared-records-meta", sharedRecordsMeta);
          expect(sharedRecords.execution).toMatchObject({ ok: true, value: 20000 });
          expect(sharedRecords.ms).toBeLessThan(5_000);
          // Storing a row into the shared value it already walked is still a cycle.
          const cycle = yield* execute(runner, "shared-meta-cycle", sharedMetaCycle);
          expect(cycle.execution).toMatchObject({
            ok: true,
            value: expect.stringContaining("contains a circular value"),
          });

          // Grouping row objects by storing each group back into itself completes, in both forms.
          const groupedRows = yield* execute(runner, "group-rows-or-push", groupRowsOrPush);
          expect(groupedRows.execution).toMatchObject({ ok: true, value: 10 });
          expect(groupedRows.ms).toBeLessThan(20_000);
          const reducedRows = yield* execute(runner, "group-rows-reduce", groupRowsReduce);
          expect(reducedRows.execution).toMatchObject({ ok: true, value: 10 });
          expect(reducedRows.ms).toBeLessThan(20_000);

          // A loop that interpolates a megabyte string stops at the budget, in seconds.
          const template = yield* execute(runner, "template-runaway", templateRunaway);
          expect(template.execution).toMatchObject({
            ok: false,
            error: {
              kind: "TimeoutExceeded",
              message: expect.stringContaining(
                `Execution exceeded its compute budget of ${defaultMaxSteps} interpreter steps`,
              ),
            },
          });
          expect(template.ms).toBeLessThan(20_000);

          // A loop that joins a megabyte string stops at the budget, in seconds.
          const concat = yield* execute(runner, "concat-runaway", concatRunaway);
          expect(concat.execution).toMatchObject({
            ok: false,
            error: {
              kind: "TimeoutExceeded",
              message: expect.stringContaining(
                `Execution exceeded its compute budget of ${defaultMaxSteps} interpreter steps`,
              ),
            },
          });
          expect(concat.ms).toBeLessThan(20_000);

          // Transforming 10,000 records with native calls stays well inside it.
          const records = yield* execute(runner, "records-transform", recordsTransform);
          expect(records.execution).toMatchObject({ ok: true, value: { kept: 5000, json: true } });

          yield* evidence.measure("runaway-ms", stopped.ms);
          yield* evidence.measure("ordinary-quiet-max-ms", slowestQuiet);
          yield* evidence.measure("ordinary-busy-max-ms", Math.max(...busy));
          yield* evidence.json("summary.json", {
            stepsPerSecond: Math.round(defaultMaxSteps / (stopped.ms / 1000)),
            busyRounds: busy.length,
            quiet,
            busy,
          });
          yield* evidence.measure("heavy-but-fine-ms", fine.ms);
          yield* evidence.measure("native-runaway-ms", native.ms);
          yield* evidence.measure("records-transform-ms", records.ms);
          yield* evidence.measure("operator-runaway-ms", operator.ms);
          yield* evidence.measure("dedupe-with-in-ms", dedupe.ms);
          yield* evidence.measure("group-by-10-ms", grouped10.ms);
          yield* evidence.measure("group-by-50-ms", grouped50.ms);
          yield* evidence.measure("group-by-object-ms", groupedObject.ms);
          yield* evidence.measure("shared-meta-ms", shared.ms);
          yield* evidence.measure("shared-records-meta-ms", sharedRecords.ms);
          yield* evidence.measure("concat-runaway-ms", concat.ms);
          yield* evidence.measure("group-rows-or-push-ms", groupedRows.ms);
          yield* evidence.measure("group-rows-reduce-ms", reducedRows.ms);
          yield* evidence.measure("template-runaway-ms", template.ms);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 180_000 },
  );
});
