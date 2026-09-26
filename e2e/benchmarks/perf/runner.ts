/** Run scenarios against one target, or interleave two targets for before/after comparisons. */
import { Clock, Console, Effect, FileSystem, Path } from "effect";
import type { PerfRequestFailed } from "./client.ts";
import type { PerfTarget, Sample, Scenario } from "./scenarios.ts";

export interface Summary {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

/** Nearest-rank percentiles over successful samples. */
export const summarize = (values: readonly number[]): Summary | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    n: sorted.length,
    p50: round(rank(0.5)),
    p95: round(rank(0.95)),
    max: round(sorted[sorted.length - 1]!),
    mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
  };
};

export interface ScenarioResult {
  readonly id: string;
  readonly group: string;
  readonly description: string;
  readonly target: string;
  readonly warmup: number;
  readonly client: Summary | null;
  readonly server: Summary | null;
  readonly metrics: Record<string, Summary | null>;
  readonly errors: number;
  readonly samples: readonly (Sample & { readonly at: string })[];
  readonly warmupSamples: readonly (Sample & { readonly at: string })[];
  /** Representative (closest to p50) and slowest successful trace IDs. */
  readonly traces: { readonly median?: string; readonly slowest?: string };
}

/** Slow scenario families take fewer samples: lifecycle writes 5, browser and cold paths 10. */
export const sampleCount = (scenario: Scenario, requested: number) =>
  scenario.group === "lifecycle"
    ? Math.min(requested, 5)
    : scenario.group === "browser" || scenario.id.endsWith(".cold")
      ? Math.min(requested, 10)
      : requested;

const failure = (error: PerfRequestFailed): Sample => ({
  ok: false,
  status: error.status ?? 0,
  clientMs: 0,
  error: `${error.operation}: ${error.detail}`.slice(0, 300),
});

export const sampleOnce = (scenario: Scenario, target: PerfTarget) =>
  Effect.gen(function* () {
    const at = new Date(yield* Clock.currentTimeMillis).toISOString();
    const sample = yield* scenario.run(target).pipe(
      Effect.catch((error) => Effect.succeed(failure(error))),
      Effect.catchDefect((defect) =>
        Effect.succeed({ ok: false, status: 0, clientMs: 0, error: String(defect).slice(0, 300) }),
      ),
    );
    return { ...sample, at };
  });

export const result = (
  scenario: Scenario,
  samples: readonly (Sample & { readonly at: string })[],
  warmupSamples: readonly (Sample & { readonly at: string })[],
): ScenarioResult => {
  const ok = samples.filter((sample) => sample.ok);
  const keys = [...new Set(ok.flatMap((sample) => Object.keys(sample.metrics ?? {})))];
  const client = summarize(ok.map((sample) => sample.clientMs));
  const median =
    client === null
      ? undefined
      : [...ok].sort(
          (a, b) => Math.abs(a.clientMs - client.p50) - Math.abs(b.clientMs - client.p50),
        )[0]?.traceId;
  const slowest = [...ok].sort((a, b) => b.clientMs - a.clientMs)[0]?.traceId;
  return {
    id: scenario.id,
    group: scenario.group,
    description: scenario.description,
    target: scenario.target,
    warmup: scenario.warmup,
    client,
    server: summarize(
      ok.flatMap((sample) => (sample.serverMs === undefined ? [] : [sample.serverMs])),
    ),
    metrics: Object.fromEntries(
      keys.map((key) => [
        key,
        summarize(
          ok.flatMap((sample) =>
            sample.metrics?.[key] === undefined ? [] : [sample.metrics[key]],
          ),
        ),
      ]),
    ),
    errors: samples.length - ok.length,
    samples,
    warmupSamples,
    traces: {
      ...(median === undefined ? {} : { median }),
      ...(slowest === undefined ? {} : { slowest }),
    },
  };
};

const line = (label: string, value: ScenarioResult) =>
  `${label.padEnd(40)} n=${String(value.client?.n ?? 0).padStart(3)} client p50=${String(value.client?.p50 ?? "-").padStart(7)} p95=${String(value.client?.p95 ?? "-").padStart(7)} server p50=${String(value.server?.p50 ?? "-").padStart(7)} p95=${String(value.server?.p95 ?? "-").padStart(7)}${value.errors ? ` errors=${value.errors}` : ""}`;

/** Sequential single-target run. */
export const runScenarios = (
  target: PerfTarget,
  selected: readonly Scenario[],
  samples: number,
  gapMs: number,
) =>
  Effect.gen(function* () {
    const results: ScenarioResult[] = [];
    for (const scenario of selected) {
      const warm = [];
      for (let index = 0; index < scenario.warmup; index++)
        warm.push(yield* sampleOnce(scenario, target));
      const measured = [];
      const count = sampleCount(scenario, samples);
      for (let index = 0; index < count; index++) {
        measured.push(yield* sampleOnce(scenario, target));
        if (gapMs > 0) yield* Effect.sleep(`${gapMs} millis`);
      }
      const value = result(scenario, measured, warm);
      results.push(value);
      yield* Console.log(line(scenario.id, value));
    }
    return results;
  }).pipe(Effect.ensuring(target.close));

/**
 * Interleaved comparison: warm both, then alternate A/B per round (ABAB, then BABA) so drift and
 * shared noise affect both targets equally.
 */
export const compareScenarios = (
  a: PerfTarget,
  b: PerfTarget,
  selected: readonly Scenario[],
  rounds: number,
) =>
  Effect.gen(function* () {
    const output: { id: string; a: ScenarioResult; b: ScenarioResult; deltaP50: number | null }[] =
      [];
    for (const scenario of selected) {
      const warmA = [],
        warmB = [];
      for (let index = 0; index < scenario.warmup; index++) {
        warmA.push(yield* sampleOnce(scenario, a));
        warmB.push(yield* sampleOnce(scenario, b));
      }
      const samplesA = [],
        samplesB = [];
      const count = sampleCount(scenario, rounds);
      for (let round = 0; round < count; round++) {
        if (round % 2 === 0) {
          samplesA.push(yield* sampleOnce(scenario, a));
          samplesB.push(yield* sampleOnce(scenario, b));
        } else {
          samplesB.push(yield* sampleOnce(scenario, b));
          samplesA.push(yield* sampleOnce(scenario, a));
        }
      }
      const ra = result(scenario, samplesA, warmA),
        rb = result(scenario, samplesB, warmB);
      const deltaP50 =
        ra.client !== null && rb.client !== null
          ? Math.round((rb.client.p50 - ra.client.p50) * 10) / 10
          : null;
      output.push({ id: scenario.id, a: ra, b: rb, deltaP50 });
      yield* Console.log(line(`${scenario.id} [${a.label}]`, ra));
      yield* Console.log(line(`${scenario.id} [${b.label}]`, rb));
    }
    return output;
  }).pipe(Effect.ensuring(Effect.all([a.close, b.close])));

/**
 * Spaced interleaved comparison for results kept for a bounded time: each round samples every
 * scenario once per target (alternating which goes first), then waits until `spacingMs` has
 * passed since the round began, so every sample finds its previous result expired. One discarded
 * round warms connections. Choose scenarios whose reads do not share a kept result.
 */
export const compareSpaced = (
  a: PerfTarget,
  b: PerfTarget,
  selected: readonly Scenario[],
  rounds: number,
  spacingMs: number,
) =>
  Effect.gen(function* () {
    const samples = new Map(
      selected.map((scenario) => [
        scenario.id,
        {
          a: [] as (Sample & { readonly at: string })[],
          b: [] as (Sample & { readonly at: string })[],
          warmA: [] as (Sample & { readonly at: string })[],
          warmB: [] as (Sample & { readonly at: string })[],
        },
      ]),
    );
    for (let round = 0; round <= rounds; round++) {
      const started = yield* Clock.currentTimeMillis;
      for (const scenario of selected) {
        const kept = samples.get(scenario.id);
        if (kept === undefined) continue;
        const [first, second] = round % 2 === 0 ? [a, b] : [b, a];
        const one = yield* sampleOnce(scenario, first);
        const two = yield* sampleOnce(scenario, second);
        const [sampleA, sampleB] = first === a ? [one, two] : [two, one];
        if (round === 0) {
          kept.warmA.push(sampleA);
          kept.warmB.push(sampleB);
        } else {
          kept.a.push(sampleA);
          kept.b.push(sampleB);
        }
      }
      yield* Console.log(`round ${round}/${rounds} done`);
      const elapsed = (yield* Clock.currentTimeMillis) - started;
      if (round < rounds && elapsed < spacingMs)
        yield* Effect.sleep(`${spacingMs - elapsed} millis`);
    }
    const output: { id: string; a: ScenarioResult; b: ScenarioResult; deltaP50: number | null }[] =
      [];
    for (const scenario of selected) {
      const kept = samples.get(scenario.id);
      if (kept === undefined) continue;
      const ra = result(scenario, kept.a, kept.warmA),
        rb = result(scenario, kept.b, kept.warmB);
      const deltaP50 =
        ra.client !== null && rb.client !== null
          ? Math.round((rb.client.p50 - ra.client.p50) * 10) / 10
          : null;
      output.push({ id: scenario.id, a: ra, b: rb, deltaP50 });
      yield* Console.log(line(`${scenario.id} [${a.label}]`, ra));
      yield* Console.log(line(`${scenario.id} [${b.label}]`, rb));
    }
    return output;
  }).pipe(Effect.ensuring(Effect.all([a.close, b.close])));

export const writeJson = (file: string, value: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, JSON.stringify(value, null, 2));
    yield* Console.log(`Wrote ${file}`);
  });

/** Filter by comma-separated regular expressions over scenario ids. */
export const select = (all: readonly Scenario[], filter: string) => {
  if (filter.trim() === "") return all;
  const patterns = filter.split(",").map((part) => new RegExp(part.trim()));
  return all.filter((scenario) => patterns.some((pattern) => pattern.test(scenario.id)));
};

const cell = (summary: Summary | null | undefined, key: "p50" | "p95" | "max") =>
  summary === null || summary === undefined ? "-" : String(Math.round(summary[key]));

/** Markdown table for a run or comparison result file. */
export const markdown = (file: { readonly kind: string; readonly results: readonly unknown[] }) => {
  if (file.kind === "perf-run") {
    const rows = file.results as readonly ScenarioResult[];
    return [
      "| Scenario | n | Client p50 | p95 | max | Server p50 | p95 | Extra (p50) | Errors | Target | Median trace |",
      "| --- | --: | --: | --: | --: | --: | --: | --- | --: | --- | --- |",
      ...rows.map(
        (row) =>
          `| ${row.id} | ${row.client?.n ?? 0} | ${cell(row.client, "p50")} | ${cell(row.client, "p95")} | ${cell(row.client, "max")} | ${cell(row.server, "p50")} | ${cell(row.server, "p95")} | ${Object.entries(
            row.metrics,
          )
            .filter(([key]) =>
              ["executorAddedMs", "upstreamMs", "callMs", "apiRequests"].includes(key),
            )
            .map(([key, value]) => `${key} ${cell(value, "p50")}`)
            .join(", ")} | ${row.errors} | ${row.target} | ${row.traces.median ?? "-"} |`,
      ),
    ].join("\n");
  }
  const rows = file.results as readonly {
    id: string;
    a: ScenarioResult;
    b: ScenarioResult;
    deltaP50: number | null;
  }[];
  return [
    "| Scenario | A client p50 | A p95 | B client p50 | B p95 | Δ p50 | A server p50 | B server p50 | Errors A/B |",
    "| --- | --: | --: | --: | --: | --: | --: | --: | --: |",
    ...rows.map(
      (row) =>
        `| ${row.id} | ${cell(row.a.client, "p50")} | ${cell(row.a.client, "p95")} | ${cell(row.b.client, "p50")} | ${cell(row.b.client, "p95")} | ${row.deltaP50 ?? "-"} | ${cell(row.a.server, "p50")} | ${cell(row.b.server, "p50")} | ${row.a.errors}/${row.b.errors} |`,
    ),
  ].join("\n");
};
