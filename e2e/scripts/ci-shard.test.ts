import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "@effect/vitest";
import {
  CI_SHARD_COUNTS,
  CI_TARGETS,
  discoverTargetTestFiles,
  durationForTestFile,
  parseCiShardRequest,
  planCiShards,
  planTargetShards,
} from "./ci-shard";
import { UNKNOWN_TEST_DURATION_MS } from "./ci-shard-durations";

describe("CI shard request parsing", () => {
  test("parses a supported target and one-based index", () => {
    expect(parseCiShardRequest(["cloud", "16"])).toEqual({
      ok: true,
      value: { target: "cloud", index: 16, count: 16 },
    });
  });

  test.each([
    { args: [] },
    { args: ["cloud"] },
    { args: ["unknown", "1"] },
    { args: ["cloud", "0"] },
    { args: ["cloud", "1.5"] },
    { args: ["cloud", "17"] },
  ])("rejects invalid external input: $args", ({ args }) => {
    const result = parseCiShardRequest(args);
    expect(result.ok).toBe(false);
  });
});

describe("CI shard planning", () => {
  test("is deterministic and assigns every file exactly once", () => {
    const files = Array.from({ length: 12 }, (_, index) => ({
      path: `test-${String(index).padStart(2, "0")}.test.ts`,
      durationMs: (index + 1) * 1_000,
    }));

    const first = planCiShards(files, 4);
    const second = planCiShards([...files].reverse(), 4);
    expect(second).toEqual(first);

    const assigned = first.flatMap((shard) => shard.files).sort();
    expect(assigned).toEqual(files.map((file) => file.path).sort());
    expect(new Set(assigned).size).toBe(files.length);
    expect(Math.max(...first.map((shard) => shard.estimatedDurationMs))).toBe(21_000);
  });

  test("rejects duplicate paths and empty shards as planner defects", () => {
    expect(() =>
      planCiShards(
        [
          { path: "same.test.ts", durationMs: 1 },
          { path: "same.test.ts", durationMs: 1 },
        ],
        1,
      ),
    ).toThrow("unique");
    expect(() => planCiShards([{ path: "only.test.ts", durationMs: 1 }], 2)).toThrow(
      "at least one",
    );
  });

  test("isolates irreducibly long files from unrelated work", () => {
    const plan = planCiShards(
      [
        { path: "slowest.test.ts", durationMs: 60_000 },
        { path: "slow.test.ts", durationMs: 50_000 },
        ...Array.from({ length: 8 }, (_, index) => ({
          path: `fast-${index}.test.ts`,
          durationMs: 5_000,
        })),
      ],
      4,
    );

    expect(plan.find((shard) => shard.files.includes("slowest.test.ts"))?.files).toEqual([
      "slowest.test.ts",
    ]);
    expect(plan.find((shard) => shard.files.includes("slow.test.ts"))?.files).toEqual([
      "slow.test.ts",
    ]);
  });

  test("gives unrecorded files conservative scheduling weight", () => {
    expect(durationForTestFile("cloud", "cloud/new.test.ts")).toBe(UNKNOWN_TEST_DURATION_MS);
    expect(durationForTestFile("cloud", "scenarios/health-checks-ui.test.ts")).toBe(71_165);
  });

  test("covers every currently discovered target file exactly once", async () => {
    const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
    for (const target of CI_TARGETS) {
      const discovered = await discoverTargetTestFiles(target, e2eRoot);
      const plan = await planTargetShards(target, e2eRoot);
      const assigned = plan.flatMap((shard) => shard.files).sort();

      expect(plan).toHaveLength(CI_SHARD_COUNTS[target]);
      expect(plan.every((shard) => shard.files.length > 0)).toBe(true);
      expect(assigned).toEqual([...discovered].sort());
      expect(new Set(assigned).size).toBe(discovered.length);
    }
  });

  test("keeps the workflow matrix synchronized with configured shard counts", async () => {
    const workflow = await readFile(
      resolve(fileURLToPath(new URL("../..", import.meta.url)), ".github/workflows/ci.yml"),
      "utf8",
    );

    for (const target of CI_TARGETS) {
      const entries = workflow.matchAll(
        new RegExp(`-\\s*\\{[^}]*target:\\s*${target},[^}]*shard-index:\\s*(\\d+)`, "g"),
      );
      const indexes = [...entries].map((entry) => entry[1]);

      expect(indexes).toEqual(
        Array.from({ length: CI_SHARD_COUNTS[target] }, (_, index) => String(index + 1)),
      );
    }
  });
});
