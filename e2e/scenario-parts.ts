/**
 * Splitting a suite's scenarios into parts that run on separate runners, and the `--test-name`
 * pattern that selects one part. CI's E2E jobs (`e2e/ci-selection.ts`) and the release workflow's
 * installed CLI suite (`e2e/run.ts --part`) split the same way.
 */
import { scenarios } from "./test-plan.ts";
import times from "./scenario-times.json" with { type: "json" };

const fileOf: ReadonlyMap<string, string> = new Map(
  Object.values(scenarios).map((scenario) => [scenario.title, scenario.file]),
);

const escape = (title: string) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern that matches exactly these titles. */
export const exactly = (titles: ReadonlyArray<string>) => `^(?:${titles.map(escape).join("|")})$`;

/** A target's measured scenario times, in seconds (`scripts/ci/scenario-times.ts` records them). */
type Times = Readonly<Record<string, number>>;
const recorded = (times as { readonly seconds: Readonly<Record<string, Times>> }).seconds;

/** The median of a target's recorded times: what a scenario with no time of its own weighs. */
const medianOf = (target: string) => {
  const values = Object.values(recorded[target] ?? {}).toSorted((a, b) => a - b);
  return values.length === 0 ? defaultSeconds : values[Math.floor(values.length / 2)]!;
};
/** A scenario's weight when its target has no recorded times at all. */
const defaultSeconds = 10;
/** What each spec file adds to its part besides its scenarios: its setup, a little. */
const fileSeconds = 2;

/**
 * Scenarios split into at most `count` parts, by spec file: a file's scenarios run one after
 * another on one worker and share its setup, so they stay in one part. Each file weighs its
 * scenarios' measured times on `target` (e2e/scenario-times.json; a scenario with none weighs the
 * target's median) plus a little for its setup, and goes, heaviest first, to the part with the
 * least weight so far. The weights are a file in the commit, so a commit always splits the same way.
 *
 * Splitting by scenario count instead left the slowest part far above an even split wherever a few
 * files hold slow scenarios: the Apps V2 lane's three local parts took 758, 1,918 and 1,747 s
 * where an even split was about 690 s. No split can end a part before its slowest file.
 */
export const split = (titles: Iterable<string>, count: number, target: string) => {
  const own = recorded[target] ?? {};
  const median = medianOf(target);
  const byFile = new Map<string, Array<string>>();
  for (const title of titles) {
    const file = fileOf.get(title)!;
    byFile.set(file, [...(byFile.get(file) ?? []), title]);
  }
  // Sorted, so the parts' patterns depend only on which titles were given, not their order.
  const files = [...byFile].map(([file, scenarios]) => ({
    file,
    scenarios: scenarios.toSorted(),
    weight: fileSeconds + scenarios.reduce((sum, title) => sum + (own[title] ?? median), 0),
  }));
  const parts = Array.from({ length: Math.min(count, files.length) }, () => ({
    weight: 0,
    titles: new Array<string>(),
  }));
  for (const { scenarios, weight } of files.sort(
    // A code-unit comparison: the runner's locale never changes the order.
    (a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  )) {
    const lightest = parts.reduce((least, part) => (part.weight < least.weight ? part : least));
    lightest.weight += weight;
    lightest.titles.push(...scenarios);
  }
  return parts.map((part) => part.titles);
};

/**
 * Scenarios split into at most `count` parts by how many there are, not how long they take, for a
 * split whose limit is what one part can hold: each Cloud part starts its own local Cloud, whose
 * memory bounds how many scenarios it serves (`localCloudScenarios` in e2e/ci-selection.ts). A file
 * stays in one part, and goes, most scenarios first, to the part with the fewest so far.
 */
export const splitByCount = (titles: Iterable<string>, count: number) => {
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
    ([a, x], [b, y]) => y.length - x.length || (a < b ? -1 : a > b ? 1 : 0),
  )) {
    const lightest = parts.reduce((least, part) => (part.weight < least.weight ? part : least));
    lightest.weight += scenarios.length + 1;
    lightest.titles.push(...scenarios.toSorted());
  }
  return parts.map((part) => part.titles);
};
