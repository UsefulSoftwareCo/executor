import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { OBSERVED_TEST_DURATIONS_MS, UNKNOWN_TEST_DURATION_MS } from "./ci-shard-durations";

/** CI e2e targets whose files can be distributed across independent runners. */
export type CiTarget = "cloud" | "local" | "selfhost";

/** The supported targets in stable display order. */
export const CI_TARGETS: readonly CiTarget[] = ["cloud", "selfhost", "local"];

/**
 * Shard counts sized so the recorded test workload plus runner setup stays
 * close to two minutes without weakening coverage or enabling retries.
 */
export const CI_SHARD_COUNTS: Readonly<Record<CiTarget, number>> = {
  cloud: 16,
  selfhost: 10,
  local: 2,
};

/** A test file and its estimated runtime used by the shard planner. */
export interface WeightedTestFile {
  readonly path: string;
  readonly durationMs: number;
}

/** A complete one-based shard assignment and its estimated total runtime. */
export interface CiShardAssignment {
  readonly index: number;
  readonly estimatedDurationMs: number;
  readonly files: readonly string[];
}

/** A parsed request for one target shard. */
export interface CiShardRequest {
  readonly target: CiTarget;
  readonly index: number;
  readonly count: number;
}

/** A safe failure returned when command-line shard input cannot be parsed. */
export class CiShardInputError extends Error {
  readonly _tag = "CiShardInputError";

  /** Creates an input error containing only safe command syntax information. */
  constructor(message: string) {
    super(message);
    this.name = "CiShardInputError";
  }
}

/** The result of parsing an external shard request. */
export type ParseCiShardRequestResult =
  | { readonly ok: true; readonly value: CiShardRequest }
  | { readonly ok: false; readonly error: CiShardInputError };

const testDirectories: Readonly<Record<CiTarget, readonly string[]>> = {
  cloud: ["scenarios", "cloud"],
  selfhost: ["scenarios", "selfhost"],
  local: ["local"],
};

// A file this long already consumes most of the two-minute budget after the
// target stack boots. Keep it alone instead of balancing unrelated work onto it.
const ISOLATED_TEST_DURATION_MS = 45_000;

const comparePaths = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const parseTarget = (input: string): CiTarget | undefined =>
  CI_TARGETS.find((target) => target === input);

const parseIndex = (input: string): number | undefined => {
  if (!/^\d+$/.test(input)) return undefined;
  const value = Number(input);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

const discoverTestFilesInDirectory = async (
  e2eRoot: string,
  relativeDirectory: string,
): Promise<readonly string[]> => {
  const entries = await readdir(resolve(e2eRoot, relativeDirectory), {
    withFileTypes: true,
  });
  const discovered = await Promise.all(
    entries.map(async (entry): Promise<readonly string[]> => {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        return discoverTestFilesInDirectory(e2eRoot, relativePath);
      }
      return entry.isFile() && entry.name.endsWith(".test.ts") ? [relativePath] : [];
    }),
  );
  return discovered.flat();
};

/**
 * Parses `[target, oneBasedIndex]`, deriving the target's fixed shard count.
 * Invalid input is returned as a typed value and never reaches the planner.
 */
export const parseCiShardRequest = (args: readonly string[]): ParseCiShardRequestResult => {
  if (args.length !== 2) {
    return {
      ok: false,
      error: new CiShardInputError(
        "usage: bun scripts/run-ci-shard.ts <cloud|selfhost|local> <shard-index>",
      ),
    };
  }

  const target = parseTarget(args[0]);
  if (target === undefined) {
    return {
      ok: false,
      error: new CiShardInputError(`unsupported e2e target: ${args[0]}`),
    };
  }

  const index = parseIndex(args[1]);
  const count = CI_SHARD_COUNTS[target];
  if (index === undefined || index > count) {
    return {
      ok: false,
      error: new CiShardInputError(
        `shard index for ${target} must be an integer from 1 through ${count}`,
      ),
    };
  }

  return { ok: true, value: { target, index, count } };
};

/**
 * Discovers the complete set of test files owned by a target, relative to the
 * supplied e2e root. Results are deduplicated and byte-order sorted.
 */
export const discoverTargetTestFiles = async (
  target: CiTarget,
  e2eRoot: string,
): Promise<readonly string[]> => {
  const discovered = await Promise.all(
    testDirectories[target].map((directory) => discoverTestFilesInDirectory(e2eRoot, directory)),
  );
  const files = new Set(discovered.flat());
  return [...files].sort(comparePaths);
};

/**
 * Returns the observed duration for a known slow file or a conservative
 * default for new and historically fast files.
 */
export const durationForTestFile = (target: CiTarget, path: string): number =>
  OBSERVED_TEST_DURATIONS_MS[target][path] ?? UNKNOWN_TEST_DURATION_MS;

/**
 * Plans every shard with deterministic longest-processing-time bin packing.
 *
 * @throws Error for internal defects such as duplicate files, invalid weights,
 * or more shards than files. External CLI values must be parsed first.
 */
export const planCiShards = (
  files: readonly WeightedTestFile[],
  shardCount: number,
): readonly CiShardAssignment[] => {
  if (!Number.isSafeInteger(shardCount) || shardCount <= 0) {
    throw new Error("shard count must be a positive safe integer");
  }
  if (files.length < shardCount) {
    throw new Error("every configured shard must receive at least one test file");
  }

  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("test file paths must be unique");
  }
  for (const file of files) {
    if (file.path.length === 0 || !Number.isFinite(file.durationMs) || file.durationMs <= 0) {
      throw new Error("test files must have a path and positive finite duration");
    }
  }

  const bins = Array.from({ length: shardCount }, (_, index) => ({
    index: index + 1,
    estimatedDurationMs: 0,
    files: [] as string[],
    isolated: false,
  }));
  const longestFirst = [...files].sort(
    (left, right) => right.durationMs - left.durationMs || comparePaths(left.path, right.path),
  );

  for (const file of longestFirst) {
    const mustIsolate = file.durationMs >= ISOLATED_TEST_DURATION_MS;
    const candidates = bins.filter((bin) => (mustIsolate ? bin.files.length === 0 : !bin.isolated));
    const firstCandidate = candidates[0];
    if (firstCandidate === undefined) {
      throw new Error("configured shard count cannot isolate every long-running test file");
    }

    let lightest = firstCandidate;
    for (const candidate of candidates.slice(1)) {
      if (candidate.estimatedDurationMs < lightest.estimatedDurationMs) {
        lightest = candidate;
      }
    }
    lightest.files.push(file.path);
    lightest.estimatedDurationMs += file.durationMs;
    lightest.isolated = mustIsolate;
  }

  return bins.map((bin) => ({
    index: bin.index,
    estimatedDurationMs: bin.estimatedDurationMs,
    files: [...bin.files].sort(comparePaths),
  }));
};

/** Discovers and plans all shards for one configured target. */
export const planTargetShards = async (
  target: CiTarget,
  e2eRoot: string,
): Promise<readonly CiShardAssignment[]> => {
  const paths = await discoverTargetTestFiles(target, e2eRoot);
  const weighted = paths.map((path) => ({
    path,
    durationMs: durationForTestFile(target, path),
  }));
  return planCiShards(weighted, CI_SHARD_COUNTS[target]);
};
