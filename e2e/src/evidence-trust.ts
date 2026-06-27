import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { projectDefinition } from "./project-matrix";
import { publishedArtifactFor } from "./published-artifacts";

export const TRUSTED_RUN_LANES_SOURCE = "e2e/scripts/merge-evidence.ts";

export interface TrustedRunLane {
  readonly target: string;
  readonly slug: string;
  readonly project: string;
}

export interface TrustedRunLanes {
  readonly schemaVersion: 1;
  readonly source: typeof TRUSTED_RUN_LANES_SOURCE;
  readonly runAttempt: string;
  readonly runs: ReadonlyArray<TrustedRunLane>;
}

const ARTIFACT_PROJECTS = {
  harness: ["harness"],
  clients: ["clients"],
  "cloud-hermetic": ["cloud-hermetic"],
  "selfhost-hermetic": ["selfhost-hermetic"],
  "cloudflare-hermetic": ["cloudflare-hermetic"],
  local: ["local"],
  "selfhost-production": ["selfhost-docker-hermetic"],
  "desktop-linux": ["desktop", "desktop-packaged"],
  "desktop-linux-kvm": ["desktop-kvm"],
  "live-cloud": ["cloud"],
  "live-selfhost": ["selfhost"],
  "live-cloudflare": ["cloudflare"],
  "tart-macos": ["cli-macos"],
  "tart-linux": ["cli-linux"],
  "windows-service-vm": ["cli-windows"],
} as const satisfies Readonly<Record<string, ReadonlyArray<string>>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validRunAttempt = (value: string) => /^[1-9][0-9]*$/.test(value);

export const trustedProjectsForArtifact = (artifact: string, runAttempt: string) => {
  if (!validRunAttempt(runAttempt))
    throw new Error("trusted run attempt must be a positive integer");
  const suffix = `-${runAttempt}`;
  if (!artifact.startsWith("e2e-") || !artifact.endsWith(suffix)) return undefined;
  const lane = artifact.slice("e2e-".length, -suffix.length);
  return ARTIFACT_PROJECTS[lane as keyof typeof ARTIFACT_PROJECTS];
};

export const trustedProjectForArtifactTarget = (
  artifact: string,
  runAttempt: string,
  target: string,
) => {
  const projects = trustedProjectsForArtifact(artifact, runAttempt);
  if (!projects) throw new Error(`evidence artifact has no trusted lane binding: ${artifact}`);
  const matching = projects.filter((project) => projectDefinition(project)?.target === target);
  if (matching.length !== 1) {
    throw new Error(`evidence artifact ${artifact} has no unique trusted project for ${target}`);
  }
  return matching[0];
};

export const trustedRunLaneKey = (target: string, slug: string) => `${target}\u0000${slug}`;

export const parseTrustedRunLanes = (value: unknown): TrustedRunLanes => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.source !== TRUSTED_RUN_LANES_SOURCE ||
    typeof value.runAttempt !== "string" ||
    !validRunAttempt(value.runAttempt) ||
    !Array.isArray(value.runs)
  ) {
    throw new Error("trusted run lanes file is invalid");
  }

  const seen = new Set<string>();
  const runs = value.runs.map((entry, index): TrustedRunLane => {
    if (
      !isRecord(entry) ||
      typeof entry.target !== "string" ||
      typeof entry.slug !== "string" ||
      typeof entry.project !== "string" ||
      !publishedArtifactFor(`${entry.target}/${entry.slug}/result.json`) ||
      projectDefinition(entry.project)?.target !== entry.target
    ) {
      throw new Error(`trusted run lanes file has an invalid entry at index ${index}`);
    }
    const key = trustedRunLaneKey(entry.target, entry.slug);
    if (seen.has(key))
      throw new Error(`trusted run lanes file repeats ${entry.target}/${entry.slug}`);
    seen.add(key);
    return { target: entry.target, slug: entry.slug, project: entry.project };
  });

  return {
    schemaVersion: 1,
    source: TRUSTED_RUN_LANES_SOURCE,
    runAttempt: value.runAttempt,
    runs,
  };
};

const isWithin = (parent: string, child: string) => child.startsWith(`${parent}${sep}`);

export const loadTrustedRunLanes = (file: string, runsDir: string) => {
  const trustedFile = realpathSync(resolve(file));
  const untrustedRuns = realpathSync(resolve(runsDir));
  if (trustedFile === untrustedRuns || isWithin(untrustedRuns, trustedFile)) {
    throw new Error("trusted run lanes file must be outside the evidence runs directory");
  }
  const value: unknown = JSON.parse(readFileSync(trustedFile, "utf8"));
  return parseTrustedRunLanes(value);
};

export const trustedRunLaneMap = (trusted: TrustedRunLanes) =>
  new Map(trusted.runs.map((run) => [trustedRunLaneKey(run.target, run.slug), run]));
