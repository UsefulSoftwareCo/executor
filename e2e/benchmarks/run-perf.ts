/** Performance harness CLI: perf stages, emulator upstreams, seeding, scenarios and flamecharts. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Layer, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { readStageControl, serveStage } from "./perf/stage.ts";
import { readReceipt, seedStage } from "./perf/seed.ts";
import { makeTarget, scenarios } from "./perf/scenarios.ts";
import { renderResults, sideBySide, spansFor, waterfall, writeChart } from "./perf/flamechart.ts";
import {
  compareScenarios,
  compareSpaced,
  markdown,
  runScenarios,
  select,
  writeJson,
} from "./perf/runner.ts";
import { productionShape, pullShape } from "./perf/shape.ts";
import { deployEmulator, serveEmulator } from "./perf/emulator-host.ts";
import { compareLoad, loadTable, runLoad, type LoadWindow } from "./perf/load.ts";
import { Observation, observe, summarizeObservations } from "./perf/observer.ts";
import { sqlStats } from "./perf/sql-stats.ts";

const stage = Command.make(
  "stage",
  {
    slug: Flag.String("slug"),
    control: Flag.String("control"),
    database: Flag.Literals("database", ["neon", "planetscale"]).pipe(
      Flag.withDefault("planetscale"),
    ),
  },
  (input) => Effect.scoped(serveStage({ ...input, deploy: true })),
);

const emulatorServe = Command.make(
  "serve",
  {
    port: Flag.Int("port").pipe(Flag.withDefault(0)),
    host: Flag.String("host").pipe(Flag.withDefault("127.0.0.1")),
  },
  ({ port, host }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const origin = yield* serveEmulator(port, host);
        yield* Console.log(JSON.stringify({ origin }));
        return yield* Effect.never;
      }),
    ),
);
const emulatorDeploy = Command.make(
  "deploy",
  { name: Flag.String("name").pipe(Flag.withDefault("perf-emulator-0925")) },
  ({ name }) => deployEmulator(name),
);
const emulator = Command.make("emulator").pipe(
  Command.withSubcommands([emulatorServe, emulatorDeploy]),
);

const defaultEmulator = "https://perf-emulator-0925.rhys-669.workers.dev";
const seed = Command.make(
  "seed",
  {
    control: Flag.String("control"),
    receipt: Flag.String("receipt"),
    seed: Flag.Int("seed").pipe(Flag.withDefault(925)),
    emulator: Flag.String("emulator").pipe(Flag.withDefault(defaultEmulator)),
    only: Flag.String("only").pipe(Flag.withDefault("")),
    concurrency: Flag.Int("concurrency").pipe(Flag.withDefault(4)),
  },
  (input) =>
    Effect.gen(function* () {
      const control = yield* readStageControl(input.control);
      yield* seedStage({
        control,
        receipt: input.receipt,
        seed: input.seed,
        emulator: input.emulator,
        only: input.only === "" ? [] : input.only.split(","),
        concurrency: input.concurrency,
      });
    }),
);
const shape = Command.make(
  "shape",
  {
    pull: Flag.Boolean("pull").pipe(Flag.withDefault(false)),
    dataset: Flag.String("dataset").pipe(Flag.withDefault("executor-next-v2-traces")),
    hours: Flag.Int("hours").pipe(Flag.withDefault(36)),
  },
  (input) =>
    Effect.gen(function* () {
      const value = input.pull ? yield* pullShape(input.dataset, input.hours) : productionShape;
      yield* Console.log(JSON.stringify(value, null, 2));
    }),
);

const filter = Flag.String("scenarios").pipe(Flag.withDefault(""));
const list = Command.make("list", { scenarios: filter }, (input) =>
  Effect.forEach(select(scenarios, input.scenarios), (scenario) =>
    Console.log(`${scenario.id.padEnd(36)} ${scenario.target.padEnd(32)} ${scenario.description}`),
  ),
);
const run = Command.make(
  "run",
  {
    control: Flag.String("control"),
    receipt: Flag.String("receipt"),
    output: Flag.String("output"),
    scenarios: filter,
    samples: Flag.Int("samples").pipe(Flag.withDefault(20)),
    gap: Flag.Int("gap-ms").pipe(Flag.withDefault(100)),
  },
  (input) =>
    Effect.gen(function* () {
      const control = yield* readStageControl(input.control);
      const receipt = yield* readReceipt(input.receipt);
      const target = yield* makeTarget(control.slug, control, receipt);
      const startedAt = new Date().toISOString();
      const results = yield* runScenarios(
        target,
        select(scenarios, input.scenarios),
        input.samples,
        input.gap,
      );
      yield* writeJson(input.output, {
        kind: "perf-run",
        origin: control.origin,
        slug: control.slug,
        commit: control.commit,
        startedAt,
        finishedAt: new Date().toISOString(),
        samples: input.samples,
        results,
      });
    }),
);
const compare = Command.make(
  "compare",
  {
    control: Flag.String("control"),
    receipt: Flag.String("receipt"),
    controlB: Flag.String("control-b"),
    receiptB: Flag.String("receipt-b"),
    output: Flag.String("output"),
    scenarios: filter,
    rounds: Flag.Int("rounds").pipe(Flag.withDefault(20)),
    spacing: Flag.Int("spacing-ms").pipe(Flag.withDefault(0)),
  },
  (input) =>
    Effect.gen(function* () {
      const controlA = yield* readStageControl(input.control);
      const controlB = yield* readStageControl(input.controlB);
      const a = yield* makeTarget(controlA.slug, controlA, yield* readReceipt(input.receipt));
      const b = yield* makeTarget(controlB.slug, controlB, yield* readReceipt(input.receiptB));
      const startedAt = new Date().toISOString();
      const selected = select(scenarios, input.scenarios);
      const results =
        input.spacing > 0
          ? yield* compareSpaced(a, b, selected, input.rounds, input.spacing)
          : yield* compareScenarios(a, b, selected, input.rounds);
      yield* writeJson(input.output, {
        kind: "perf-compare",
        a: { origin: controlA.origin, slug: controlA.slug, commit: controlA.commit },
        b: { origin: controlB.origin, slug: controlB.slug, commit: controlB.commit },
        startedAt,
        finishedAt: new Date().toISOString(),
        rounds: input.rounds,
        spacingMs: input.spacing,
        results,
      });
    }),
);

const flamechart = Command.make(
  "flamechart",
  {
    output: Flag.String("output"),
    from: Flag.String("from").pipe(Flag.withDefault("")),
    scenarios: filter,
    which: Flag.String("which").pipe(Flag.withDefault("median,slowest")),
    slug: Flag.String("slug").pipe(Flag.withDefault("")),
    trace: Flag.String("trace").pipe(Flag.withDefault("")),
    slugB: Flag.String("slug-b").pipe(Flag.withDefault("")),
    traceB: Flag.String("trace-b").pipe(Flag.withDefault("")),
    at: Flag.String("at").pipe(Flag.withDefault("")),
  },
  (input) =>
    Effect.gen(function* () {
      if (input.from !== "") {
        yield* renderResults({
          file: input.from,
          output: input.output,
          scenarios: input.scenarios,
          which: input.which
            .split(",")
            .filter(
              (value): value is "median" | "slowest" => value === "median" || value === "slowest",
            ),
        });
        return;
      }
      const at = input.at === "" ? new Date() : new Date(input.at);
      // Without a sample time, search the preceding six hours.
      const minutes = input.at === "" ? 360 : 15;
      const left = yield* spansFor(input.slug, input.trace, at, minutes);
      if (input.traceB === "") {
        yield* writeChart(
          input.output,
          waterfall({ title: `test-${input.slug} trace ${input.trace}`, spans: left, width: 1400 })
            .svg,
        );
        return;
      }
      const right = yield* spansFor(input.slugB || input.slug, input.traceB, at, minutes);
      yield* writeChart(
        input.output,
        sideBySide(
          { title: `test-${input.slug} ${input.trace}`, spans: left },
          { title: `test-${input.slugB || input.slug} ${input.traceB}`, spans: right },
        ),
      );
    }),
);

const table = Command.make("table", { from: Flag.String("from") }, (input) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs
      .readFileString(input.from)
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({ kind: Schema.String, results: Schema.Array(Schema.Unknown) }),
            ),
          ),
        ),
      );
    yield* Console.log(markdown(file));
  }),
);

const loadFlags = {
  seconds: Flag.Int("seconds").pipe(Flag.withDefault(60)),
  executeWorkers: Flag.Int("execute-workers").pipe(Flag.withDefault(8)),
  readWorkers: Flag.Int("read-workers").pipe(Flag.withDefault(4)),
  callWorkers: Flag.Int("call-workers").pipe(Flag.withDefault(2)),
  probeWorkers: Flag.Int("probe-workers").pipe(Flag.withDefault(1)),
};
const load = Command.make(
  "load",
  {
    control: Flag.String("control"),
    receipt: Flag.String("receipt"),
    output: Flag.String("output"),
    ...loadFlags,
  },
  (input) =>
    Effect.gen(function* () {
      const control = yield* readStageControl(input.control);
      const target = yield* makeTarget(control.slug, control, yield* readReceipt(input.receipt));
      const window = yield* runLoad(target, input).pipe(Effect.ensuring(target.close));
      yield* writeJson(input.output, {
        kind: "perf-load",
        commit: control.commit,
        windows: [window],
        pooled: { [control.slug]: window.summary },
      });
    }),
);
const loadCompare = Command.make(
  "load-compare",
  {
    control: Flag.String("control"),
    receipt: Flag.String("receipt"),
    controlB: Flag.String("control-b"),
    receiptB: Flag.String("receipt-b"),
    output: Flag.String("output"),
    rounds: Flag.Int("rounds").pipe(Flag.withDefault(2)),
    pause: Flag.Int("pause-seconds").pipe(Flag.withDefault(20)),
    ...loadFlags,
  },
  (input) =>
    Effect.gen(function* () {
      const controlA = yield* readStageControl(input.control);
      const controlB = yield* readStageControl(input.controlB);
      const a = yield* makeTarget(controlA.slug, controlA, yield* readReceipt(input.receipt));
      const b = yield* makeTarget(controlB.slug, controlB, yield* readReceipt(input.receiptB));
      const result = yield* compareLoad(a, b, input, input.rounds, input.pause);
      yield* writeJson(input.output, {
        kind: "perf-load",
        a: { slug: controlA.slug, commit: controlA.commit },
        b: { slug: controlB.slug, commit: controlB.commit },
        ...result,
      });
    }),
);
const LoadFile = Schema.Struct({
  kind: Schema.Literal("perf-load"),
  windows: Schema.Array(Schema.Unknown),
  pooled: Schema.Record(Schema.String, Schema.Unknown),
});
const readLoad = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file);
    yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LoadFile))(text);
    return JSON.parse(text) as {
      windows: readonly LoadWindow[];
      pooled: Parameters<typeof loadTable>[0];
    };
  });
const loadTableCommand = Command.make("load-table", { from: Flag.String("from") }, (input) =>
  readLoad(input.from).pipe(Effect.flatMap((file) => Console.log(loadTable(file.pooled)))),
);
const sqlstats = Command.make(
  "sqlstats",
  { from: Flag.String("from"), output: Flag.String("output") },
  (input) =>
    Effect.gen(function* () {
      const file = yield* readLoad(input.from);
      const windows = [];
      for (const window of file.windows) {
        const stats = yield* sqlStats({
          slug: window.slug,
          from: new Date(Date.parse(window.startedAt) - 5_000),
          to: new Date(Date.parse(window.finishedAt) + 130_000),
          traceIds: window.samples.flatMap((sample) =>
            sample.traceId === undefined ? [] : [sample.traceId],
          ),
        });
        const execute = stats.foreground["sql.execute"];
        yield* Console.log(
          `${window.label.padEnd(22)} ${window.startedAt} fg sql.execute n=${execute?.n ?? 0} >1s=${execute?.over1s ?? 0} (${((stats.foregroundExecuteOver1sRate ?? 0) * 100).toFixed(2)}%) >300=${execute?.over300 ?? 0} p99=${execute?.p99 ?? "-"} max=${execute?.max ?? "-"} | connects/trace=${stats.connectsPerForegroundTrace?.toFixed(2) ?? "-"} | wire first>1s=${stats.foreground["sql.wire"]?.firstOver1s ?? 0}`,
        );
        // Dashboard reads and tool calls are judged separately from discovery-heavy executes.
        const byKind: Record<string, unknown> = {};
        for (const kind of ["read", "toolcall", "execute"] as const) {
          const traceIds = window.samples.flatMap((sample) =>
            sample.kind === kind && sample.traceId !== undefined ? [sample.traceId] : [],
          );
          if (traceIds.length === 0) continue;
          const part = yield* sqlStats({
            slug: window.slug,
            from: new Date(Date.parse(window.startedAt) - 5_000),
            to: new Date(Date.parse(window.finishedAt) + 130_000),
            traceIds,
          });
          const statements = part.foreground["sql.execute"];
          byKind[kind] = {
            traces: traceIds.length,
            statements: statements?.n ?? 0,
            over300: statements?.over300 ?? 0,
            over1s: statements?.over1s ?? 0,
            over1sRate: part.foregroundExecuteOver1sRate,
            p99: statements?.p99 ?? null,
            max: statements?.max ?? null,
          };
          yield* Console.log(
            `  ${kind.padEnd(9)} statements=${statements?.n ?? 0} >1s=${statements?.over1s ?? 0} >300=${statements?.over300 ?? 0} p99=${statements?.p99 ?? "-"} max=${statements?.max ?? "-"}`,
          );
        }
        windows.push({ label: window.label, startedAt: window.startedAt, ...stats, byKind });
      }
      yield* writeJson(input.output, { kind: "perf-sqlstats", windows });
    }),
);
const observeCommand = Command.make(
  "observe",
  {
    slug: Flag.String("slug"),
    output: Flag.String("output"),
    seconds: Flag.Int("seconds").pipe(Flag.withDefault(120)),
    interval: Flag.Int("interval-ms").pipe(Flag.withDefault(200)),
  },
  (input) => observe({ ...input, intervalMs: input.interval }),
);
const observeSummary = Command.make(
  "observe-summary",
  { from: Flag.String("from"), output: Flag.String("output") },
  (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lines = (yield* fs.readFileString(input.from))
        .split("\n")
        .filter((line) => line !== "");
      const observations = yield* Effect.forEach(lines, (line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Observation))(line),
      );
      const summary = summarizeObservations(observations);
      yield* Console.log(JSON.stringify({ ...summary, blocked: summary.blocked.length }, null, 2));
      yield* writeJson(input.output, summary);
    }),
);

const root = Command.make("perf").pipe(
  Command.withSubcommands([
    stage,
    emulator,
    shape,
    seed,
    list,
    run,
    compare,
    flamechart,
    table,
    load,
    loadCompare,
    loadTableCommand,
    sqlstats,
    observeCommand,
    observeSummary,
  ]),
);
NodeRuntime.runMain(
  Command.run(root, { version: "1" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
