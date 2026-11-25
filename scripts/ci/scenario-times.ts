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
