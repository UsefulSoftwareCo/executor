import { describe, expect, it } from "vitest";
import { scenarios } from "../test-plan.ts";
import times from "../scenario-times.json" with { type: "json" };
import { split } from "../scenario-parts.ts";

const targets = ["local", "self-host", "cloud"] as const;
const recorded = (times as { readonly seconds: Readonly<Record<string, Record<string, number>>> })
  .seconds;
const scheduled = (target: (typeof targets)[number]) =>
  Object.values(scenarios)
    .filter((scenario) => scenario.targets[target].status === "scheduled")
    .map((scenario) => scenario.title);
const fileOf = new Map(Object.values(scenarios).map((scenario) => [scenario.title, scenario.file]));

const expectPartition = (titles: ReadonlyArray<string>, parts: ReadonlyArray<Array<string>>) => {
  expect(parts.flat().toSorted()).toEqual([...titles].toSorted());
  const partOf = new Map<string, number>();
  parts.forEach((part, index) => {
    for (const title of part) {
      const file = fileOf.get(title)!;
      expect(partOf.get(file) ?? index, file).toBe(index);
      partOf.set(file, index);
    }
  });
};

describe("Splitting scenarios into parts by measured time", () => {
  for (const target of targets)
    for (const count of [1, 3, 12])
      it(`every ${target} scenario runs exactly once over ${count} parts, each file in one part`, () => {
        const titles = scheduled(target);
        const parts = split(titles, count, target);
        expect(parts).toHaveLength(Math.min(count, new Set(titles.map((t) => fileOf.get(t))).size));
        expectPartition(titles, parts);
      });

  it("a selection, in any order, splits the same way every time", () => {
    const titles = scheduled("self-host").filter((_, index) => index % 3 === 0);
    const first = split(titles, 5, "self-host");
    expect(split([...titles].reverse(), 5, "self-host")).toEqual(first);
    expect(split(titles, 5, "self-host")).toEqual(first);
    expectPartition(titles, first);
  });

  it("no part outweighs the lightest by more than the heaviest file", () => {
    const own = recorded["self-host"]!;
    const values = Object.values(own).toSorted((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)]!;
    const weigh = (part: ReadonlyArray<string>) =>
      part.reduce((sum, title) => sum + (own[title] ?? median), 0) +
      2 * new Set(part.map((title) => fileOf.get(title))).size;
    const titles = scheduled("self-host");
    const parts = split(titles, 12, "self-host");
    const byFile = new Map<string, Array<string>>();
    for (const title of titles)
      byFile.set(fileOf.get(title)!, [...(byFile.get(fileOf.get(title)!) ?? []), title]);
    const heaviest = Math.max(...[...byFile.values()].map(weigh));
    const weights = parts.map(weigh);
    expect(Math.max(...weights) - Math.min(...weights)).toBeLessThanOrEqual(heaviest);
  });

  it("a slow file with few scenarios gets a part of its own, where counting would not give it one", () => {
    const own = recorded["self-host"]!;
    const byFile = new Map<string, Array<string>>();
    for (const title of scheduled("self-host"))
      if (own[title] !== undefined)
        byFile.set(fileOf.get(title)!, [...(byFile.get(fileOf.get(title)!) ?? []), title]);
    const seconds = (titles: ReadonlyArray<string>) =>
      titles.reduce((sum, title) => sum + own[title]!, 0);
    const [slow, slowTitles] = [...byFile].toSorted(([, a], [, b]) => seconds(b) - seconds(a))[0]!;
    const quick: Array<string> = [];
    for (const [file, titles] of [...byFile].toSorted(([, a], [, b]) => seconds(a) - seconds(b))) {
      if (file === slow) continue;
      if (seconds([...quick, ...titles]) >= seconds(slowTitles) / 2) break;
      quick.push(...titles);
    }
    expect(quick.length).toBeGreaterThan(slowTitles.length + 1);
    const parts = split([...slowTitles, ...quick], 2, "self-host");
    expect(parts.map((part) => part.toSorted())).toEqual([slowTitles.toSorted(), quick.toSorted()]);
  });

  it("a target with no recorded times still runs every scenario once", () => {
    const titles = scheduled("local");
    const parts = split(titles, 3, "no-such-target");
    expect(parts).toHaveLength(3);
    expectPartition(titles, parts);
  });
});
