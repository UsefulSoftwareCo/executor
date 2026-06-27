import { resolve, sep } from "node:path";

import { writeJsonAtomicSync } from "../src/artifact-io";
import { mergeEvidenceArtifacts } from "../src/evidence-merge";
import { TRUSTED_RUN_LANES_SOURCE } from "../src/evidence-trust";

const argumentValue = (name: string) => {
  const args = process.argv.slice(2);
  const equals = args.find((argument) => argument.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const inputDir = argumentValue("--input-dir");
const outputDir = argumentValue("--output-dir");
const runAttempt = argumentValue("--run-attempt");
const trustedRunsOutput = argumentValue("--trusted-runs-output");

if (!inputDir || !outputDir || !runAttempt || !trustedRunsOutput) {
  console.error(
    "usage: bun e2e/scripts/merge-evidence.ts --input-dir <path> --output-dir <path> --run-attempt <number> --trusted-runs-output <path>",
  );
  process.exitCode = 1;
} else {
  try {
    const resolvedInput = resolve(inputDir);
    const resolvedOutput = resolve(outputDir);
    const resolvedTrust = resolve(trustedRunsOutput);
    if (
      resolvedTrust === resolvedInput ||
      resolvedTrust.startsWith(`${resolvedInput}${sep}`) ||
      resolvedTrust === resolvedOutput ||
      resolvedTrust.startsWith(`${resolvedOutput}${sep}`)
    ) {
      throw new Error("trusted run metadata must be outside downloaded artifacts and merged runs");
    }
    const result = mergeEvidenceArtifacts({
      inputDir: resolvedInput,
      outputDir: resolvedOutput,
      runAttempt,
    });
    writeJsonAtomicSync(resolvedTrust, {
      schemaVersion: 1,
      source: TRUSTED_RUN_LANES_SOURCE,
      runAttempt,
      runs: result.trustedRuns,
    });
    console.log(
      `evidence merge: ${result.attemptCount} attempts from ${result.artifactCount} artifacts (${result.collisionCount} collisions preserved)`,
    );
  } catch (error) {
    console.error(`evidence merge: ${String(error)}`);
    process.exitCode = 1;
  }
}
