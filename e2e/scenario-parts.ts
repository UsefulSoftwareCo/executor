/**
 * Splitting a suite's scenarios into parts that run on separate runners, and the `--test-name`
 * pattern that selects one part. CI's E2E jobs (`e2e/ci-selection.ts`) and the release workflow's
 * installed CLI suite (`e2e/run.ts --part`) split the same way.
 */
import { scenarios } from "./test-plan.ts";

const fileOf: ReadonlyMap<string, string> = new Map(
  Object.values(scenarios).map((scenario) => [scenario.title, scenario.file]),
);

const escape = (title: string) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern that matches exactly these titles. */
export const exactly = (titles: ReadonlyArray<string>) => `^(?:${titles.map(escape).join("|")})$`;

/**
 * Scenarios split into at most `count` parts, by spec file: a file's scenarios share its setup, so
 * they stay in one part. Each file goes, most scenarios first, to the part with the least weight
 * so far, weighing a file as its scenarios plus one for its setup. Over four full self-host runs,
 * the slowest of three parts took 2-9% longer than an even split of the measured time; Vitest's
 * --shard, which splits by a hash of the path, left one part up to 33% over. With five parts the
 * suite has fewer files per part, so a few slow files decide more: in two full runs the slowest
 * part ran 22% more test time than the next slowest, and 49% more than one with as many scenarios.
 */
export const split = (titles: Iterable<string>, count: number) => {
  const byFile = new Map<string, Array<string>>();
  for (const title of titles) {
    const file = fileOf.get(title)!;
    byFile.set(file, [...(byFile.get(file) ?? []), title]);
  }
  const parts = Array.from({ length: Math.min(count, byFile.size) }, () => ({
    weight: 0,
    titles: new Array<string>(),
  }));
  for (const [, scenarios] of [...byFile].sort(
    ([a, x], [b, y]) => y.length - x.length || a.localeCompare(b),
  )) {
    const lightest = parts.reduce((least, part) => (part.weight < least.weight ? part : least));
    lightest.weight += scenarios.length + 1;
    lightest.titles.push(...scenarios);
  }
  return parts.map((part) => part.titles);
};
