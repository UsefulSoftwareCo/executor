import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";

import { trustedProjectForArtifactTarget, type TrustedRunLane } from "./evidence-trust";

const GENERATED_DIRECTORIES = new Set(["assets", "trace-viewer"]);

export interface EvidenceMergeOptions {
  readonly inputDir: string;
  readonly outputDir: string;
  readonly runAttempt: string;
}

export interface EvidenceMergeEntry {
  readonly artifact: string;
  readonly target: string;
  readonly sourceSlug: string;
  readonly mergedSlug: string;
}

export interface EvidenceMergeResult {
  readonly artifactCount: number;
  readonly attemptCount: number;
  readonly collisionCount: number;
  readonly entries: ReadonlyArray<EvidenceMergeEntry>;
  readonly trustedRuns: ReadonlyArray<TrustedRunLane>;
}

const isWithin = (parent: string, child: string) => child.startsWith(`${parent}${sep}`);

const safeSuffix = (value: string) => {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.slice(0, 80) || "artifact";
};

const attemptIdFor = (directory: string) => {
  const file = join(directory, "evidence.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "attemptId" in parsed &&
      typeof parsed.attemptId === "string" &&
      parsed.attemptId.length > 0
    ) {
      return safeSuffix(parsed.attemptId);
    }
  } catch {
    // The rebuilt manifest will ignore malformed evidence metadata. A source
    // artifact still gets a collision-safe name derived from its artifact.
  }
  return undefined;
};

const assertCopyableTree = (directory: string) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
      throw new Error(`evidence merge refuses symbolic link: ${path}`);
    }
    if (entry.isDirectory()) assertCopyableTree(path);
  }
};

const destinationSlug = (
  destinationTarget: string,
  sourceSlug: string,
  sourceArtifact: string,
  sourceDirectory: string,
) => {
  if (!existsSync(join(destinationTarget, sourceSlug))) return sourceSlug;

  const suffix = attemptIdFor(sourceDirectory) ?? safeSuffix(sourceArtifact);
  const sourcePrefix = sourceSlug.slice(0, Math.max(1, 180 - suffix.length));
  const base = `${sourcePrefix}--${suffix}`;
  if (!existsSync(join(destinationTarget, base))) return base;

  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existsSync(join(destinationTarget, candidate))) return candidate;
  }
  throw new Error(`evidence merge exhausted collision suffixes for ${sourceSlug}`);
};

/**
 * Merge independently uploaded `runs/` trees without allowing one job to
 * overwrite another job's attempt directory. Generated viewer files are
 * intentionally discarded because the aggregate job rebuilds them once.
 */
export const mergeEvidenceArtifacts = (options: EvidenceMergeOptions): EvidenceMergeResult => {
  const inputDir = resolve(options.inputDir);
  const outputDir = resolve(options.outputDir);
  if (inputDir === outputDir || isWithin(inputDir, outputDir) || isWithin(outputDir, inputDir)) {
    throw new Error("evidence merge input and output directories must not overlap");
  }
  if (parse(outputDir).root === outputDir) {
    throw new Error("evidence merge output must not be a filesystem root");
  }
  if (!existsSync(inputDir)) throw new Error(`evidence merge input does not exist: ${inputDir}`);

  if (existsSync(outputDir) && readdirSync(outputDir).length > 0) {
    throw new Error(`evidence merge output must be empty: ${outputDir}`);
  }
  mkdirSync(outputDir, { recursive: true });

  const artifacts = readdirSync(inputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const entries: EvidenceMergeEntry[] = [];
  const trustedRuns: TrustedRunLane[] = [];
  let collisionCount = 0;

  for (const artifact of artifacts) {
    const artifactDir = join(inputDir, artifact.name);
    const targets = readdirSync(artifactDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !GENERATED_DIRECTORIES.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const target of targets) {
      const sourceTarget = join(artifactDir, target.name);
      const destinationTarget = join(outputDir, target.name);
      const trustedProject = trustedProjectForArtifactTarget(
        artifact.name,
        options.runAttempt,
        target.name,
      );
      mkdirSync(destinationTarget, { recursive: true });
      const attempts = readdirSync(sourceTarget, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name));

      for (const attempt of attempts) {
        const sourceDirectory = join(sourceTarget, attempt.name);
        assertCopyableTree(sourceDirectory);
        const mergedSlug = destinationSlug(
          destinationTarget,
          attempt.name,
          artifact.name,
          sourceDirectory,
        );
        if (mergedSlug !== attempt.name) collisionCount += 1;
        cpSync(sourceDirectory, join(destinationTarget, mergedSlug), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
        entries.push({
          artifact: artifact.name,
          target: target.name,
          sourceSlug: attempt.name,
          mergedSlug,
        });
        trustedRuns.push({ target: target.name, slug: mergedSlug, project: trustedProject });
      }
    }
  }

  if (entries.length === 0) {
    throw new Error(`evidence merge found no attempt directories in ${inputDir}`);
  }

  return {
    artifactCount: artifacts.length,
    attemptCount: entries.length,
    collisionCount,
    entries,
    trustedRuns,
  };
};
