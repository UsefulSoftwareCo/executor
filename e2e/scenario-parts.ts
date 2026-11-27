import { scenarios } from "./test-plan.ts";
import times from "./scenario-times.json" with { type: "json" };

const fileOf: ReadonlyMap<string, string> = new Map(
  Object.values(scenarios).map((scenario) => [scenario.title, scenario.file]),
);

const escape = (title: string) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const exactly = (titles: ReadonlyArray<string>) => `^(?:${titles.map(escape).join("|")})$`;

type Times = Readonly<Record<string, number>>;
const recorded = (times as { readonly seconds: Readonly<Record<string, Times>> }).seconds;

const medianOf = (target: string) => {
  const values = Object.values(recorded[target] ?? {}).toSorted((a, b) => a - b);
  return values.length === 0 ? defaultSeconds : values[Math.floor(values.length / 2)]!;
};
const defaultSeconds = 10;
const fileSeconds = 2;

export const split = (titles: Iterable<string>, count: number, target: string) => {
  const own = recorded[target] ?? {};
  const median = medianOf(target);
  const byFile = new Map<string, Array<string>>();
  for (const title of titles) {
    const file = fileOf.get(title)!;
    byFile.set(file, [...(byFile.get(file) ?? []), title]);
  }
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
    (a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  )) {
    const lightest = parts.reduce((least, part) => (part.weight < least.weight ? part : least));
    lightest.weight += weight;
    lightest.titles.push(...scenarios);
  }
  return parts.map((part) => part.titles);
};

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
