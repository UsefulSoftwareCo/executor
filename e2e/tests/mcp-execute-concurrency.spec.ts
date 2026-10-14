/**
 * JavaScript runs one job at a time: an async function's code between two awaits finishes before
 * another job starts. Programs that run async functions together with Promise.all and update
 * shared state between awaits must get exactly the values JavaScript gives. Before the fix the
 * interpreter interleaved those jobs mid-statement and silently lost updates. Jobs also run in
 * JavaScript's order: a promise settles when it is resolved, a combinator in a reaction job on the
 * member that decides it, and an async generator settles each request before it takes the next.
 * Runaway async recursion fails with the nesting-depth error instead of hanging, a call that fails
 * at the depth limit leaves the program's objects usable, and deep generator chains return.
 */
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, Option, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { runInNode } from "../support/native-javascript.ts";
import { Target } from "../support/platform.ts";

/**
 * Each program awaits `tools.search`, which every product serves without setup, and returns
 * values that standard JavaScript fixes exactly, however the tool calls are timed.
 */
const programs = [
  {
    name: "reporter",
    // The reported program: read-modify-write of a binding, a string, a property and Map entries.
    code: `
let counter = 0; let text = ''; const record = { n: 0 }; const byKey = new Map();
async function extract() {
  await tools.search({ query: 'executor', limit: 1 });
  for (let i = 0; i < 3000; i++) {
    counter += 1; text += 'x'; record.n++;
    const entry = byKey.get(i % 50) || { n: 0 }; entry.n++; byKey.set(i % 50, entry);
  }
  await tools.search({ query: 'github', limit: 1 });
  for (let i = 0; i < 3000; i++) { counter += 1; text += 'y'; }
}
await Promise.all([extract(), extract(), extract()]);
let entries = 0;
for (const entry of byKey.values()) entries += entry.n;
return { counter, text: text.length, property: record.n, entries };`,
    calls: 6,
    expected: { counter: 18_000, text: 18_000, property: 9000, entries: 9000 },
  },
  {
    name: "closures",
    // A closure's own state, read and written by nested functions within one job.
    code: `
function makeCounter() {
  let n = 0;
  return { add: (k) => { const before = n; for (let i = 0; i < k; i++) n = n + 1; return n - before; }, read: () => n };
}
const shared = makeCounter();
let text = '';
async function worker() {
  await tools.search({ query: 'executor', limit: 1 });
  const step = () => { let added = 0; for (let j = 0; j < 400; j++) { added += shared.add(3); text += 'ab'; } return added; };
  const first = step();
  await tools.search({ query: 'github', limit: 1 });
  return first + step();
}
const added = await Promise.all([1, 2, 3, 4, 5].map(() => worker()));
return { added, total: shared.read(), text: text.length };`,
    calls: 10,
    expected: { added: [2400, 2400, 2400, 2400, 2400], total: 12_000, text: 8000 },
  },
  {
    name: "call-runs-to-first-await",
    // Calling an async function runs its body up to the first await before the caller continues.
    code: `
let counter = 0;
async function job() {
  for (let i = 0; i < 20000; i++) counter++;
  await tools.search({ query: 'executor', limit: 1 });
  for (let i = 0; i < 20000; i++) counter++;
}
const first = job();
const afterFirst = counter;
const second = job();
const afterSecond = counter;
await Promise.all([first, second]);
return { afterFirst, afterSecond, total: counter };`,
    calls: 2,
    expected: { afterFirst: 20_000, afterSecond: 40_000, total: 80_000 },
  },
  {
    name: "many-tasks",
    // Forty extraction tasks append rows and CSV lines across tool calls and microtask awaits.
    code: `
const rows = []; const totals = { rows: 0, cells: 0 }; let csv = 'id,round\\n';
async function extract(id) {
  for (let round = 0; round < 3; round++) {
    if (round === 1) await tools.search({ query: 'app ' + id, limit: 1 });
    else await null;
    for (let i = 0; i < 1000; i++) totals.cells = totals.cells + 1;
    totals.rows += 1;
    csv += id + ',' + round + '\\n';
    rows.push(id);
  }
}
await Promise.all(Array.from({ length: 40 }, (_, id) => extract(id)));
return { rows: rows.length, totalRows: totals.rows, cells: totals.cells, csvLines: csv.trim().split('\\n').length - 1 };`,
    calls: 40,
    expected: { rows: 120, totalRows: 120, cells: 120_000, csvLines: 120 },
  },
  {
    name: "generators-and-reactions",
    // Generator steps, for await over async generators and then handlers are whole jobs too.
    code: `
function* numbers(n) { for (let i = 0; i < n; i++) yield i; }
async function* pages() { for (let p = 0; p < 3; p++) { await tools.search({ query: 'page', limit: 1 }); yield p; } }
let sum = 0; let seen = 0; let handled = 0;
async function consume() {
  await tools.search({ query: 'executor', limit: 1 });
  for (const value of numbers(2000)) sum = sum + value;
  for await (const page of pages()) { for (let i = 0; i < 500; i++) seen = seen + 1; }
}
const reactions = [1, 2, 3].map(() => tools.search({ query: 'github', limit: 1 }).then(() => {
  for (let i = 0; i < 2000; i++) handled = handled + 1;
}));
await Promise.all([consume(), consume(), consume(), ...reactions]);
return { sum, seen, handled };`,
    calls: 15,
    expected: { sum: 5_997_000, seen: 4500, handled: 6000 },
  },
  {
    name: "job-order",
    // Jobs still run in JavaScript's order: synchronous code, then reactions and continuations.
    code: `
const log = [];
async function tick(name, n) { for (let i = 0; i < n; i++) { log.push(name + i); await null; } }
const reaction = Promise.resolve().then(() => log.push('then1')).then(() => log.push('then2'));
const ticks = Promise.all([tick('a', 3), tick('b', 2)]);
log.push('sync');
await Promise.all([ticks, reaction]);
return log;`,
    calls: 0,
    expected: ["a0", "b0", "sync", "then1", "a1", "b1", "then2", "a2"],
  },
] as const;

/**
 * A combinator settles in a reaction job on the member that decides it, so its result's reaction
 * runs after a continuation that another job queued first, even when the interpreter preempts that
 * job: each loop runs longer than Effect's 2,048-operation budget.
 */
const combinatorPrograms = (["race", "any", "all", "allSettled"] as const).flatMap((combinator) => [
  {
    name: `${combinator}-order`,
    code: `function burn() { for (let i = 0; i < 400; i++) {} } const log = []; const a = Promise.${combinator}([{ then(resolve) { burn(); resolve(1); } }]).then(() => log.push('result')); const b = (async () => { await null; burn(); log.push('b0'); await null; log.push('b1'); })(); await Promise.all([a, b]); return log;`,
  },
  {
    name: `${combinator}-value`,
    code: `function burn() { for (let i = 0; i < 400; i++) {} } let x = 0; const a = Promise.${combinator}([{ then(resolve) { burn(); resolve(1); } }]).then(() => x); const b = (async () => { await null; burn(); await null; x = 1; })(); return [await a, await b, x];`,
  },
]);

/**
 * Programs whose result depends on when promises settle and in which order reactions,
 * continuations, combinators and async generator steps run. The expected result is Node's own:
 * the test runs the same source natively.
 */
const orderPrograms = [
  {
    name: "resolve",
    // A promise resolved in its executor queues the reaction before the await's continuation.
    code: `let x = 0; new Promise((resolve) => resolve()).then(() => { x = 1; }); await null; return x;`,
  },
  {
    name: "reject",
    code: `let x = 0; new Promise((resolve, reject) => reject(new Error('no'))).catch(() => { x = 1; }); await null; return x;`,
  },
  {
    name: "captured-resolver",
    // A resolver called later in the same job settles the promise at that call.
    code: `let resolve; let x = 0; const p = new Promise((r) => { resolve = r; }); resolve(); p.then(() => { x = 1; }); await null; return x;`,
  },
  {
    name: "captured-reject",
    code: `let reject; let x = 0; const p = new Promise((_, r) => { reject = r; }); p.catch(() => { x = 1; }); reject(new Error('no')); await null; return x;`,
  },
  {
    name: "reaction-order",
    code: `const log = []; const p = new Promise((resolve) => resolve(1)); Promise.resolve().then(() => log.push('a')); p.then(() => log.push('p')); Promise.resolve().then(() => log.push('b')); await null; log.push('main'); return log;`,
  },
  {
    name: "generator-next",
    // The first step's reaction runs before the generator returns, so it reads x = 9.
    code: `let x = 0; async function* g() { yield 1; yield 2; return x; } const it = g(); const a = it.next().then((result) => { x = 9; return result; }); const b = it.next(); const c = it.next(); return await Promise.all([a, b, c]);`,
  },
  {
    name: "generator-return",
    // A queued return() runs the finally block after the first step's reaction.
    code: `let x = 0; async function* g() { try { yield 1; } finally { x = 1; } } const it = g(); const a = it.next().then(() => x); const b = it.return(2); return [await a, await b];`,
  },
  {
    name: "generator-throw",
    code: `let x = 0; async function* g() { try { yield 1; } catch { await null; return x; } } const it = g(); const a = it.next().then((result) => { x = 9; return result; }); const b = it.throw(new Error('no')); return [await a, await b];`,
  },
  {
    name: "generator-order",
    code: `const log = []; async function* g() { log.push('g1'); yield 1; log.push('g2'); yield 2; log.push('g3'); } const it = g(); const steps = [1, 2, 3].map((n) => it.next().then(() => log.push('r' + n))); log.push('sync'); await Promise.all(steps); return log;`,
  },
  ...combinatorPrograms,
] as const;

const nestingDepth = "Execution exceeded the maximum nesting depth.";

/**
 * Async functions that call themselves before their first await nest every call, as JavaScript's
 * call stack does, so runaway recursion must fail promptly with the nesting-depth error. Each
 * call's fiber holds the turn while it runs, and the patched interpreter once overflowed the host
 * stack there and hung with the turn held. A deep chain that ends must still return.
 */
const recursionPrograms = [
  {
    name: "recursion-caught",
    code: `async function f(n) { return await f(n + 1); } try { await f(0); } catch (e) { return String(e); }`,
    expected: `RangeError: ${nestingDepth}`,
  },
  {
    name: "recursion-depth",
    code: `let d = 0; const f = async (n) => { d = n; return f(n + 1); }; try { await f(0); } catch (e) { return [String(e), d]; }`,
    expected: [`RangeError: ${nestingDepth}`, expect.any(Number)],
  },
  {
    name: "recursion-uncaught",
    code: `const f = async (n) => f(n + 1); return await f(0);`,
    expected: { kind: "ExecutionFailure", message: nestingDepth },
  },
  {
    name: "deep-chain",
    code: `const f = async (n) => (n === 0 ? 0 : 1 + (await f(n - 1))); return await f(1500);`,
    expected: 1500,
  },
] as const;

/**
 * The call depth limit counts program calls: async function calls, generator steps and combinators.
 * A call that fails there must leave the program's objects as they were. Each generator program
 * recurses until a call fails, then steps the generator in the catch of every frame on the way out,
 * so the step fails once at the limit and must work one frame up. The patched interpreter once
 * failed such a step after marking the generator started (or after taking its parked body's wake),
 * so the next step waited forever. It also once counted a generator's request and body as two
 * calls, so 1,000 levels of `yield*` failed; a chain of generators exactly at the limit must return.
 */
const callDepthPrograms = [
  {
    name: "generator-after-failed-step",
    code: `function* g() { yield 1; return 2; } const it = g(); async function f() { try { return await f(); } catch (e) { return it.next(); } } const first = await f(); return [first, it.next()];`,
    expected: [
      { value: 1, done: false },
      { value: 2, done: true },
    ],
  },
  {
    name: "async-generator-after-failed-step",
    code: `async function* g() { yield 1; return 2; } const it = g(); async function f() { try { return await f(); } catch (e) { return it.next(); } } const first = await f(); return [first, await it.next()];`,
    expected: [
      { value: 1, done: false },
      { value: 2, done: true },
    ],
  },
  {
    name: "resumed-async-generator-after-failed-step",
    code: `async function* g() { yield 1; yield 2; return 3; } const it = g(); await it.next(); async function f() { try { return await f(); } catch (e) { return it.next(); } } const first = await f(); return [first, await it.next()];`,
    expected: [
      { value: 2, done: false },
      { value: 3, done: true },
    ],
  },
  {
    name: "yield-star-1000",
    // Review's program: the loop runs long enough at each level for Effect to preempt it.
    code: `async function* g(n) { for (let i = 0; i < 300; i++) {} if (n === 0) return 42; return yield* g(n - 1); } return (await g(1000).next()).value;`,
    expected: 42,
  },
  {
    name: "yield-star-at-limit",
    // 2,000 generator bodies nested by `yield*`: the deepest chain the limit allows.
    code: `async function* g(n) { if (n === 0) return 42; return yield* g(n - 1); } return (await g(1999).next()).value;`,
    expected: 42,
  },
] as const;

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
    const { execution } = yield* client
      .use(`Run the ${name} program`, (client, signal) =>
        client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
      )
      .pipe(
        Effect.flatMap((result) => Schema.decodeUnknownEffect(Executed)(result.structuredContent)),
      );
    yield* (yield* Evidence).json(`${name}.json`, execution);
    return {
      value: execution.ok ? execution.value : execution.error,
      calls: execution.toolCalls.map((call) => call.outcome),
    };
  });

/** Runs every program, then compares them all, so a failure shows each program's result. */
const runPrograms = (client: Connected) =>
  Effect.gen(function* () {
    const actual: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const program of programs) {
      actual[program.name] = yield* execute(client, program.name, program.code);
      expected[program.name] = {
        value: program.expected,
        calls: Array.from({ length: program.calls }, () => "success"),
      };
    }
    for (const program of orderPrograms) {
      actual[program.name] = yield* execute(client, program.name, program.code);
      expected[program.name] = { value: yield* runInNode(program.code), calls: [] };
    }
    expect(actual).toEqual(expected);
  });

/**
 * Runs every program, then compares them all. A program that hangs is recorded after 10 seconds,
 * well past the few seconds these take, so the others still report and the case ends within its
 * minute.
 */
const runBoundedPrograms = (
  client: Connected,
  programs: ReadonlyArray<{ name: string; code: string; expected: unknown }>,
) =>
  Effect.gen(function* () {
    const actual: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const program of programs) {
      const result = yield* execute(client, program.name, program.code).pipe(
        Effect.timeoutOption(Duration.seconds(10)),
      );
      actual[program.name] = Option.match(result, {
        onNone: () => "no answer within 10 seconds",
        onSome: (executed) => executed.value,
      });
      expected[program.name] = program.expected;
    }
    expect(actual).toEqual(expected);
    return actual;
  });

const runRecursionPrograms = (client: Connected) =>
  Effect.gen(function* () {
    const actual = yield* runBoundedPrograms(client, recursionPrograms);
    // The recursion goes about as deep as the host stack allowed before the fix, not a few calls.
    const [, depth] = Schema.decodeUnknownSync(Schema.Tuple([Schema.String, Schema.Number]))(
      actual["recursion-depth"],
    );
    expect(depth).toBeGreaterThan(1000);
  });

/** Connects to hosted MCP execute with a new API key for the owner, deleted when the case ends. */
const connectHosted = (label: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      mcp = yield* McpClient;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
        name: "Execute concurrency",
      }),
    );
    yield* Effect.addFinalizer(() =>
      api
        .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    return yield* mcp.connect(key.key, label, { organization: actors.organization.id });
  });

layer(HostedLive, { excludeTestServices: true })("Hosted MCP execute concurrency", (it) => {
  it.effect(scenarios.mcpExecuteConcurrency.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        yield* runPrograms(yield* connectHosted("execute-concurrency"));
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpExecuteRecursion.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        yield* runRecursionPrograms(yield* connectHosted("execute-recursion"));
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpExecuteCallDepth.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        yield* runBoundedPrograms(yield* connectHosted("execute-call-depth"), callDepthPrograms);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("Local MCP execute concurrency", (it) => {
  it.effect(scenarios.localMcpExecuteConcurrency.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          mcp = yield* McpClient;
        yield* runPrograms(yield* mcp.connect(target.apiKey, "local-execute-concurrency"));
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.localMcpExecuteRecursion.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          mcp = yield* McpClient;
        yield* runRecursionPrograms(yield* mcp.connect(target.apiKey, "local-execute-recursion"));
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.localMcpExecuteCallDepth.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          mcp = yield* McpClient;
        yield* runBoundedPrograms(
          yield* mcp.connect(target.apiKey, "local-execute-call-depth"),
          callDepthPrograms,
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
