/**
 * Measured scenario times, which `split` (e2e/scenario-parts.ts) weighs parts by.
 *
 *   node scripts/ci/scenario-times.ts record <run> <directory>...
 *
 * reads every Vitest `results.json` under the directories (a full CI run's `e2e-<target>-results-*`
 * artifacts, unpacked) and writes `e2e/scenario-times.json`: for each target, each scenario's time
 * in whole seconds, and the run they came from. A scenario that ran more than once on a target (a
 * Cloud scenario on several runtimes) counts its total. Keys are sorted, so the same results write
 * the same file, and `split` gives the same parts for a commit however often it runs.
 *
 * Refresh it from a recent full run on main, which runs every scenario:
 *   gh run download <run> --repo UsefulSoftwareCo/executor-next --pattern 'e2e-*-results-*' --dir <dir>
 *   node scripts/ci/scenario-times.ts record <run> <dir>
 * A branch's new scenarios need nothing: `split` gives a scenario it has no time for the target's
 * median.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Results = {
  readonly testResults?: ReadonlyArray<{
    readonly assertionResults?: ReadonlyArray<{
      readonly title?: string;
      readonly status?: string;
      readonly duration?: number | null;
    }>;
  }>;
};

const resultsFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return resultsFiles(path);
    return name === "results.json" ? [path] : [];
  });

/** The target a results file belongs to: `<stamp>-<target>-<hash>/<target>/report/diagnostics/`. */
const targetOf = (file: string) => file.split("/").at(-4);

const [command, run, ...directories] = process.argv.slice(2);
if (command !== "record" || run === undefined || directories.length === 0) {
  console.error("Usage: node scripts/ci/scenario-times.ts record <run> <directory>...");
  process.exit(2);
}
const totals = new Map<string, Map<string, number>>();
for (const file of directories.flatMap(resultsFiles)) {
  const target = targetOf(file);
  if (target !== "local" && target !== "self-host" && target !== "cloud") continue;
  const results = JSON.parse(readFileSync(file, "utf8")) as Results;
  const times = totals.get(target) ?? new Map<string, number>();
  totals.set(target, times);
  for (const suite of results.testResults ?? [])
    // Only scenarios that ran: a skipped or filtered one has no time, and would weigh 1 s.
    for (const { title, status, duration } of suite.assertionResults ?? [])
      if (
        title !== undefined &&
        (status === "passed" || status === "failed") &&
        typeof duration === "number" &&
        Number.isFinite(duration)
      )
        times.set(title, (times.get(title) ?? 0) + duration / 1000);
}
const seconds = Object.fromEntries(
  [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([target, times]) => [
      target,
      Object.fromEntries(
        [...times]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([title, time]) => [title, Math.max(1, Math.round(time))]),
      ),
    ]),
);
writeFileSync(
  "e2e/scenario-times.json",
  `${JSON.stringify({ run: Number(run), seconds }, null, 1)}\n`,
);
console.log(
  `Recorded ${Object.values(seconds).reduce((sum, times) => sum + Object.keys(times).length, 0)} scenario times from run ${run}.`,
);
