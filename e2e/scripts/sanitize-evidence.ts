// Prepare e2e/runs for CI artifact publication. The pass is intentionally
// destructive: private configs and credential stores are removed, text and
// JSON evidence is redacted in place, and unknown files are denied by the
// same allowlist used by the viewer server.
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomicSync, writeTextAtomicSync } from "../src/artifact-io";
import {
  isPublishedDirectory,
  publishedArtifactFor,
  sanitizePublishedCast,
  sanitizePublishedJson,
  sanitizePublishedText,
  type EvidencePublicationMetadata,
} from "../src/published-artifacts";
import {
  LANE_PROVENANCE_FILE,
  parseLaneProvenance,
  visualEvidencePublicationDecision,
  type VisualEvidencePublicationDecision,
} from "../src/evidence-provenance";
import {
  loadTrustedRunLanes,
  trustedRunLaneKey,
  trustedRunLaneMap,
  type TrustedRunLane,
  type TrustedRunLanes,
} from "../src/evidence-trust";
import { projectDefinition } from "../src/project-matrix";
import { buildManifest } from "../src/viewer/manifest";

interface CommandOptions {
  readonly runsDir: string;
  readonly canaries: ReadonlyArray<string>;
  readonly trustedProjectsByTarget: ReadonlyMap<string, string>;
  readonly trustedRuns?: TrustedRunLanes;
  readonly trustedRunsByKey?: ReadonlyMap<string, TrustedRunLane>;
}

const argumentsFor = (): CommandOptions => {
  const args = process.argv.slice(2);
  let runsDir = fileURLToPath(new URL("../runs/", import.meta.url));
  let trustedLanesFile: string | undefined;
  const trustedProjects: string[] = [];
  const canaries = [process.env.E2E_EVIDENCE_CANARY, process.env.E2E_EVIDENCE_CANARY_SECRET].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--runs-dir") {
      const value = args[index + 1];
      if (!value) throw new Error("sanitize-evidence: --runs-dir needs a path");
      runsDir = resolve(value);
      index += 1;
    } else if (argument?.startsWith("--runs-dir=")) {
      runsDir = resolve(argument.slice("--runs-dir=".length));
    } else if (argument === "--canary") {
      const value = args[index + 1];
      if (!value) throw new Error("sanitize-evidence: --canary needs a value");
      canaries.push(value);
      index += 1;
    } else if (argument?.startsWith("--canary=")) {
      canaries.push(argument.slice("--canary=".length));
    } else if (argument === "--trusted-project") {
      const value = args[index + 1];
      if (!value) throw new Error("sanitize-evidence: --trusted-project needs a project name");
      trustedProjects.push(value);
      index += 1;
    } else if (argument?.startsWith("--trusted-project=")) {
      trustedProjects.push(argument.slice("--trusted-project=".length));
    } else if (argument === "--trusted-lanes") {
      const value = args[index + 1];
      if (!value) throw new Error("sanitize-evidence: --trusted-lanes needs a path");
      trustedLanesFile = value;
      index += 1;
    } else if (argument?.startsWith("--trusted-lanes=")) {
      trustedLanesFile = argument.slice("--trusted-lanes=".length);
    } else {
      throw new Error(`sanitize-evidence: unknown argument ${argument}`);
    }
  }

  if (trustedLanesFile && trustedProjects.length > 0) {
    throw new Error("sanitize-evidence: choose trusted lanes or trusted projects, not both");
  }
  const trustedProjectsByTarget = new Map<string, string>();
  for (const projectName of new Set(trustedProjects)) {
    const project = projectDefinition(projectName);
    if (!project) throw new Error(`sanitize-evidence: unknown trusted project ${projectName}`);
    const existing = trustedProjectsByTarget.get(project.target);
    if (existing && existing !== projectName) {
      throw new Error(
        `sanitize-evidence: trusted projects ${existing} and ${projectName} share target ${project.target}`,
      );
    }
    trustedProjectsByTarget.set(project.target, projectName);
  }
  const trustedRuns = trustedLanesFile ? loadTrustedRunLanes(trustedLanesFile, runsDir) : undefined;
  return {
    runsDir,
    canaries: [...new Set(canaries)].filter((value) => value.length >= 4),
    trustedProjectsByTarget,
    ...(trustedRuns ? { trustedRuns, trustedRunsByKey: trustedRunLaneMap(trustedRuns) } : {}),
  };
};

const portablePath = (root: string, file: string): string =>
  relative(root, file).split(sep).join("/");

interface SanitizeStats {
  removed: number;
  redacted: number;
  retained: number;
  binaryArtifacts: string[];
  errors: string[];
}

interface EvidenceAttemptDirectory {
  readonly target: string;
  readonly slug: string;
  readonly directory: string;
}

const evidenceAttemptDirectories = (root: string): EvidenceAttemptDirectory[] => {
  const attempts: EvidenceAttemptDirectory[] = [];
  for (const target of readdirSync(root, { withFileTypes: true })) {
    if (
      !target.isDirectory() ||
      target.name === "assets" ||
      target.name === "trace-viewer" ||
      !isPublishedDirectory(target.name)
    ) {
      continue;
    }
    const targetDirectory = join(root, target.name);
    for (const slug of readdirSync(targetDirectory, { withFileTypes: true })) {
      const relativePath = `${target.name}/${slug.name}`;
      if (!slug.isDirectory() || !isPublishedDirectory(relativePath)) continue;
      attempts.push({
        target: target.name,
        slug: slug.name,
        directory: join(targetDirectory, slug.name),
      });
    }
  }
  return attempts;
};

const trustedProjectForAttempt = (options: CommandOptions, target: string, slug: string) =>
  options.trustedRunsByKey
    ? options.trustedRunsByKey.get(trustedRunLaneKey(target, slug))?.project
    : options.trustedProjectsByTarget.get(target);

const validateTrustedLaneBindings = (options: CommandOptions, errors: string[]): void => {
  const attempts = evidenceAttemptDirectories(options.runsDir);
  const actualKeys = new Set(
    attempts.map((attempt) => trustedRunLaneKey(attempt.target, attempt.slug)),
  );
  if (options.trustedRuns) {
    for (const trusted of options.trustedRuns.runs) {
      if (!actualKeys.has(trustedRunLaneKey(trusted.target, trusted.slug))) {
        errors.push(`trusted lane has no evidence directory: ${trusted.target}/${trusted.slug}`);
      }
    }
  }

  for (const attempt of attempts) {
    const relativePath = `${attempt.target}/${attempt.slug}`;
    const trustedProject = trustedProjectForAttempt(options, attempt.target, attempt.slug);
    if (!trustedProject) {
      errors.push(`evidence lane has no external trusted project: ${relativePath}`);
      continue;
    }
    try {
      const provenance: unknown = JSON.parse(
        readFileSync(join(attempt.directory, LANE_PROVENANCE_FILE), "utf8"),
      );
      if (!parseLaneProvenance(provenance, trustedProject, attempt.target)) {
        errors.push(
          `lane provenance does not match trusted project ${trustedProject}: ${relativePath}`,
        );
      }
    } catch {
      errors.push(`lane provenance is missing or unreadable: ${relativePath}`);
    }
  }
};

const visualEvidenceDecision = (
  root: string,
  file: string,
  options: CommandOptions,
): VisualEvidencePublicationDecision => {
  try {
    const result: unknown = JSON.parse(readFileSync(join(dirname(file), "result.json"), "utf8"));
    const provenance: unknown = JSON.parse(
      readFileSync(join(dirname(file), LANE_PROVENANCE_FILE), "utf8"),
    );
    const [target = "", slug = ""] = portablePath(root, file).split("/");
    const trustedProject = trustedProjectForAttempt(options, target, slug) ?? "";
    return visualEvidencePublicationDecision(result, provenance, target, trustedProject);
  } catch {
    return { publish: false, reason: "lane provenance is missing or unreadable" };
  }
};

const sanitizeFile = (
  root: string,
  file: string,
  canaries: ReadonlyArray<string>,
  stats: SanitizeStats,
  options: CommandOptions,
): void => {
  const relativePath = portablePath(root, file);
  const artifact = publishedArtifactFor(relativePath);
  if (!artifact) {
    rmSync(file, { force: true });
    stats.removed += 1;
    return;
  }

  if (artifact.kind === "json" || artifact.kind === "text") {
    try {
      const contents = readFileSync(file, "utf8");
      const publication = relativePath.endsWith("/result.json")
        ? {
            availableArtifacts: new Set(
              readdirSync(dirname(file), { withFileTypes: true })
                .filter((entry) => entry.isFile())
                .map((entry) => entry.name),
            ),
          }
        : {};
      const sanitized =
        artifact.kind === "json"
          ? sanitizePublishedJson(relativePath, contents, publication, { secrets: canaries })
          : relativePath.endsWith("/terminal.cast")
            ? sanitizePublishedCast(contents, { secrets: canaries })
            : sanitizePublishedText(contents, { secrets: canaries });
      writeTextAtomicSync(file, sanitized);
      stats.redacted += 1;
      return;
    } catch (error) {
      rmSync(file, { force: true });
      stats.removed += 1;
      stats.errors.push(
        `removed unreadable publication artifact ${relativePath}: ${String(error)}`,
      );
      return;
    }
  }

  if (artifact.unredactedVisual) {
    const decision = visualEvidenceDecision(root, file, options);
    if (!decision.publish) {
      rmSync(file, { force: true });
      stats.removed += 1;
      stats.errors.push(`removed unauthorized visual evidence ${relativePath}: ${decision.reason}`);
      return;
    }
    stats.binaryArtifacts.push(relativePath);
  }
  stats.retained += 1;
};

const sanitizeDirectory = (
  root: string,
  directory: string,
  canaries: ReadonlyArray<string>,
  stats: SanitizeStats,
  options: CommandOptions,
): void => {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => {
    if (left.name === "result.json") return 1;
    if (right.name === "result.json") return -1;
    return left.name.localeCompare(right.name);
  });
  for (const entry of entries) {
    const file = join(directory, entry.name);
    const relativePath = portablePath(root, file);
    const metadata = lstatSync(file);
    if (metadata.isSymbolicLink()) {
      rmSync(file, { recursive: true, force: true });
      stats.removed += 1;
      continue;
    }
    if (metadata.isDirectory()) {
      if (entry.name.endsWith(".lock")) {
        stats.errors.push(`active evidence lock prevents publication: ${relativePath}`);
        continue;
      }
      if (!isPublishedDirectory(relativePath)) {
        rmSync(file, { recursive: true, force: true });
        stats.removed += 1;
        continue;
      }
      sanitizeDirectory(root, file, canaries, stats, options);
      continue;
    }
    if (metadata.isFile()) sanitizeFile(root, file, canaries, stats, options);
    else {
      rmSync(file, { force: true });
      stats.removed += 1;
    }
  }
};

const fileContains = (file: string, canary: Buffer): boolean => {
  const handle = openSync(file, "r");
  const chunkSize = 64 * 1024;
  const chunk = Buffer.allocUnsafe(chunkSize);
  let carry = Buffer.alloc(0);
  try {
    for (;;) {
      const bytes = readSync(handle, chunk, 0, chunk.length, null);
      if (bytes === 0) return false;
      const combined = Buffer.concat([carry, chunk.subarray(0, bytes)]);
      if (combined.includes(canary)) return true;
      const overlap = Math.max(0, canary.length - 1);
      carry = overlap === 0 ? Buffer.alloc(0) : combined.subarray(-overlap);
    }
  } finally {
    closeSync(handle);
  }
};

const verifyDirectory = (
  root: string,
  directory: string,
  canaries: ReadonlyArray<string>,
  errors: string[],
): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    const relativePath = portablePath(root, file);
    const metadata = lstatSync(file);
    if (metadata.isSymbolicLink()) {
      errors.push(`symlink survived evidence sanitization: ${relativePath}`);
      continue;
    }
    if (metadata.isDirectory()) {
      if (!isPublishedDirectory(relativePath)) {
        errors.push(`private directory survived evidence sanitization: ${relativePath}`);
      } else {
        verifyDirectory(root, file, canaries, errors);
      }
      continue;
    }
    if (!metadata.isFile() || !publishedArtifactFor(relativePath)) {
      errors.push(`private artifact survived evidence sanitization: ${relativePath}`);
      continue;
    }
    for (const canary of canaries) {
      if (fileContains(file, Buffer.from(canary))) {
        errors.push(`canary secret survived evidence sanitization: ${relativePath}`);
      }
    }
  }
};

const selfCheck = (): void => {
  const canary = "executor-evidence-sanitizer-self-check";
  const sample = JSON.stringify({
    authorization: `Bearer ${canary}`,
    url: `http://127.0.0.1/?_token=${canary}`,
    artifacts: ["terminal.cast", "mcporter.json", "trace.zip"],
  });
  const sanitized = sanitizePublishedJson(
    "cloud/self-check/result.json",
    sample,
    {},
    { secrets: [canary] },
  );
  if (sanitized.includes(canary) || sanitized.includes("mcporter.json")) {
    throw new Error("sanitize-evidence: sanitizer self-check failed");
  }
};

const main = (): void => {
  selfCheck();
  const options = argumentsFor();
  if (!existsSync(options.runsDir)) {
    console.log(`sanitize-evidence: ${options.runsDir} does not exist; nothing to publish`);
    return;
  }

  const stats: SanitizeStats = {
    removed: 0,
    redacted: 0,
    retained: 0,
    binaryArtifacts: [],
    errors: [],
  };
  validateTrustedLaneBindings(options, stats.errors);
  sanitizeDirectory(options.runsDir, options.runsDir, options.canaries, stats, options);
  buildManifest(options.runsDir);
  verifyDirectory(options.runsDir, options.runsDir, options.canaries, stats.errors);

  const sourceRevision = process.env.GITHUB_SHA;
  const metadata: EvidencePublicationMetadata = {
    schemaVersion: 1,
    sanitizedAt: Date.now(),
    status: stats.errors.length === 0 ? "passed" : "failed",
    sanitizer: {
      source: "e2e/scripts/sanitize-evidence.ts",
      policyVersion: 1,
      ...(sourceRevision ? { sourceRevision } : {}),
    },
    policy: {
      unknownArtifacts: "removed",
      textAndJson: "redacted",
      binaryVisuals: "unredacted-synthetic-only",
      binarySecretDetection: "byte-canary-only",
    },
    runtime: {
      name: process.versions.bun ? "bun" : "node",
      version: process.versions.bun ?? process.version,
      platform: process.platform,
      arch: process.arch,
    },
    stats: {
      removed: stats.removed,
      redacted: stats.redacted,
      retained: stats.retained,
      canariesChecked: options.canaries.length,
    },
    binaryArtifacts: stats.binaryArtifacts.sort(),
    errors: stats.errors.map((error) =>
      sanitizePublishedText(error, { secrets: options.canaries }),
    ),
  };
  writeJsonAtomicSync(join(options.runsDir, "publication.json"), metadata);

  console.log(
    `sanitize-evidence: removed ${stats.removed}, redacted ${stats.redacted}, retained ${stats.retained}`,
  );
  for (const error of stats.errors) console.error(`sanitize-evidence: ${error}`);
  if (stats.errors.length > 0) process.exitCode = 1;
};

try {
  main();
} catch (error) {
  console.error(`sanitize-evidence: ${String(error)}`);
  process.exitCode = 1;
}
