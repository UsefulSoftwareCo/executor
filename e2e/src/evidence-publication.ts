import { lstatSync, readFileSync, readdirSync, type Stats } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
  isPublishedDirectory,
  publishedArtifactFor,
  type PublishedArtifact,
} from "./published-artifacts";
import { parseLaneProvenance } from "./evidence-provenance";
import { trustedRunLaneKey, trustedRunLaneMap, type TrustedRunLanes } from "./evidence-trust";

const PREFIX_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const OBJECT_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const MAX_SUMMARY_RUNS = 500;

interface PublicationGate {
  readonly schemaVersion: 1;
  readonly status: "passed";
  readonly sanitizer: {
    readonly source: "e2e/scripts/sanitize-evidence.ts";
    readonly policyVersion: 1;
    readonly sourceRevision: string;
  };
  readonly policy: {
    readonly unknownArtifacts: "removed";
    readonly textAndJson: "redacted";
    readonly binaryVisuals: "unredacted-synthetic-only";
    readonly binarySecretDetection: "byte-canary-only";
  };
  readonly binaryArtifacts: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

export interface EvidenceBundleFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly artifact: PublishedArtifact;
  readonly stats: Stats;
}

export interface EvidenceSummaryRun {
  readonly scenario: string;
  readonly target: string;
  readonly slug: string;
  readonly ok: boolean;
  readonly endedAt?: number;
}

export interface PublicEvidenceVerificationOptions {
  readonly viewerUrl: string;
  readonly files: ReadonlyArray<EvidenceBundleFile>;
  readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  readonly attempts?: number;
  readonly retryDelayMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const hasControlCharacter = (value: string) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });

const parsePublicationGate = (value: unknown) => {
  if (!isRecord(value)) throw new Error("publication.json must contain an object");
  const sanitizer = value.sanitizer;
  const policy = value.policy;
  if (!isRecord(sanitizer) || !isRecord(policy)) {
    throw new Error("publication.json is missing sanitizer policy metadata");
  }
  if (
    value.schemaVersion !== 1 ||
    value.status !== "passed" ||
    sanitizer.source !== "e2e/scripts/sanitize-evidence.ts" ||
    sanitizer.policyVersion !== 1 ||
    typeof sanitizer.sourceRevision !== "string" ||
    policy.unknownArtifacts !== "removed" ||
    policy.textAndJson !== "redacted" ||
    policy.binaryVisuals !== "unredacted-synthetic-only" ||
    policy.binarySecretDetection !== "byte-canary-only" ||
    !stringArray(value.binaryArtifacts) ||
    !stringArray(value.errors) ||
    value.errors.length > 0
  ) {
    throw new Error("publication.json does not describe a passing supported sanitizer policy");
  }
  return {
    schemaVersion: 1,
    status: "passed",
    sanitizer: {
      source: "e2e/scripts/sanitize-evidence.ts",
      policyVersion: 1,
      sourceRevision: sanitizer.sourceRevision,
    },
    policy: {
      unknownArtifacts: "removed",
      textAndJson: "redacted",
      binaryVisuals: "unredacted-synthetic-only",
      binarySecretDetection: "byte-canary-only",
    },
    binaryArtifacts: value.binaryArtifacts,
    errors: value.errors,
  } satisfies PublicationGate;
};

const portablePath = (root: string, file: string) => relative(root, file).split(sep).join("/");

const collectBundleFiles = (root: string, directory: string, files: EvidenceBundleFile[]): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    const relativePath = portablePath(root, file);
    const stats = lstatSync(file);
    if (stats.isSymbolicLink()) {
      throw new Error(`publication bundle contains a symlink: ${relativePath}`);
    }
    if (stats.isDirectory()) {
      if (!isPublishedDirectory(relativePath)) {
        throw new Error(`publication bundle contains a private directory: ${relativePath}`);
      }
      collectBundleFiles(root, file, files);
      continue;
    }
    const artifact = stats.isFile() ? publishedArtifactFor(relativePath) : undefined;
    if (!artifact) {
      throw new Error(`publication bundle contains a private artifact: ${relativePath}`);
    }
    files.push({ absolutePath: file, relativePath, artifact, stats });
  }
};

const parseJsonFile = (file: string) => {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  return value;
};

const safeRunPath = (target: string, slug: string) =>
  publishedArtifactFor(`${target}/${slug}/result.json`) !== undefined;

export const summaryRunsFromManifest = (value: unknown) => {
  if (!isRecord(value) || !Array.isArray(value.runs)) {
    throw new Error("manifest.json must contain a runs array");
  }
  return value.runs.map((entry, index): EvidenceSummaryRun => {
    if (
      !isRecord(entry) ||
      typeof entry.scenario !== "string" ||
      entry.scenario.length === 0 ||
      hasControlCharacter(entry.scenario) ||
      typeof entry.target !== "string" ||
      typeof entry.slug !== "string" ||
      typeof entry.ok !== "boolean" ||
      !safeRunPath(entry.target, entry.slug) ||
      (entry.endedAt !== undefined &&
        (typeof entry.endedAt !== "number" || !Number.isFinite(entry.endedAt)))
    ) {
      throw new Error(`manifest.json contains an invalid run at index ${index}`);
    }
    return {
      scenario: entry.scenario,
      target: entry.target,
      slug: entry.slug,
      ok: entry.ok,
      ...(typeof entry.endedAt === "number" ? { endedAt: entry.endedAt } : {}),
    };
  });
};

export const latestSummaryRuns = (runs: ReadonlyArray<EvidenceSummaryRun>) => {
  const latest = new Map<string, EvidenceSummaryRun>();
  for (const run of runs) {
    const key = `${run.scenario}\u0000${run.target}`;
    const current = latest.get(key);
    if (!current || (run.endedAt ?? 0) > (current.endedAt ?? 0)) latest.set(key, run);
  }
  return [...latest.values()].sort(
    (left, right) =>
      left.scenario.localeCompare(right.scenario) || left.target.localeCompare(right.target),
  );
};

const validatedHttpsUrl = (input: string, label: string) => {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${label} must be an HTTPS URL without credentials, query, or fragment`);
  }
  return url;
};

export const validateObjectPrefix = (prefix: string) => {
  const segments = prefix.split("/");
  if (segments.length === 0 || segments.some((segment) => !PREFIX_SEGMENT.test(segment))) {
    throw new Error("R2 object prefix contains an unsafe segment");
  }
  return segments.join("/");
};

export const evidenceViewerUrl = (publicBaseUrl: string, prefix: string) => {
  const base = validatedHttpsUrl(publicBaseUrl, "public evidence base URL");
  const normalizedPrefix = validateObjectPrefix(prefix);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL(`${normalizedPrefix}/index.html`, base).toString();
};

export const evidenceRunUrl = (viewerUrl: string, target: string, slug: string) => {
  const viewer = validatedHttpsUrl(viewerUrl, "evidence viewer URL");
  if (!viewer.pathname.endsWith("/index.html") || !safeRunPath(target, slug)) {
    throw new Error("evidence run URL contains an invalid viewer, target, or slug");
  }
  return `${viewer.toString()}#/run/${encodeURIComponent(target)}/${encodeURIComponent(slug)}`;
};

export const r2ObjectUrl = (
  endpoint: string,
  bucket: string,
  prefix: string,
  relativePath: string,
) => {
  const url = validatedHttpsUrl(endpoint, "R2 endpoint");
  if (url.pathname !== "/" || !BUCKET_NAME.test(bucket)) {
    throw new Error("R2 endpoint or bucket name is invalid");
  }
  const normalizedPrefix = validateObjectPrefix(prefix);
  const pathSegments = relativePath.split("/");
  if (
    pathSegments.length === 0 ||
    pathSegments.some((segment) => !OBJECT_SEGMENT.test(segment)) ||
    !publishedArtifactFor(relativePath)
  ) {
    throw new Error(`R2 object path is not publication-allowlisted: ${relativePath}`);
  }
  url.pathname = `/${bucket}/${normalizedPrefix}/${pathSegments.join("/")}`;
  return url.toString();
};

export const validateEvidenceBundle = (
  runsDir: string,
  sourceRevision: string,
  trustedRuns: TrustedRunLanes,
) => {
  if (!sourceRevision) throw new Error("source revision is required for evidence publication");
  const root = resolve(runsDir);
  const files: EvidenceBundleFile[] = [];
  collectBundleFiles(root, root, files);
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  for (const required of ["index.html", "manifest.json", "publication.json"]) {
    if (!byPath.has(required)) throw new Error(`publication bundle is missing ${required}`);
  }

  const publication = parsePublicationGate(parseJsonFile(join(root, "publication.json")));
  if (publication.sanitizer.sourceRevision !== sourceRevision) {
    throw new Error("publication sanitizer revision does not match the workflow revision");
  }

  const actualAttempts = new Map<string, { readonly target: string; readonly slug: string }>();
  for (const file of files) {
    const [target, slug, name, extra] = file.relativePath.split("/");
    if (
      !target ||
      !slug ||
      !name ||
      extra !== undefined ||
      target === "assets" ||
      target === "trace-viewer"
    ) {
      continue;
    }
    actualAttempts.set(trustedRunLaneKey(target, slug), { target, slug });
  }
  const trustedAttempts = trustedRunLaneMap(trustedRuns);
  if (actualAttempts.size !== trustedAttempts.size) {
    throw new Error("publication evidence directories do not match external trusted lane metadata");
  }
  for (const [key, attempt] of actualAttempts) {
    const trusted = trustedAttempts.get(key);
    if (!trusted) {
      throw new Error(
        `publication evidence has no external trusted lane: ${attempt.target}/${attempt.slug}`,
      );
    }
    const provenanceFile = byPath.get(`${attempt.target}/${attempt.slug}/lane-provenance.json`);
    if (
      !provenanceFile ||
      !parseLaneProvenance(
        parseJsonFile(provenanceFile.absolutePath),
        trusted.project,
        attempt.target,
      )
    ) {
      throw new Error(
        `publication lane provenance does not match external trusted project ${trusted.project}: ${attempt.target}/${attempt.slug}`,
      );
    }
    const resultFile = byPath.get(`${attempt.target}/${attempt.slug}/result.json`);
    const skippedFile = byPath.get(`${attempt.target}/${attempt.slug}/skipped.json`);
    if ((resultFile ? 1 : 0) + (skippedFile ? 1 : 0) !== 1) {
      throw new Error(
        `publication evidence needs exactly one result or skip marker: ${attempt.target}/${attempt.slug}`,
      );
    }
    const marker = parseJsonFile((resultFile ?? skippedFile)?.absolutePath ?? "");
    if (!isRecord(marker) || marker.target !== attempt.target) {
      throw new Error(
        `publication evidence marker target does not match its directory: ${attempt.target}/${attempt.slug}`,
      );
    }
  }

  const visualArtifacts = files
    .filter((file) => file.artifact.unredactedVisual)
    .map((file) => file.relativePath)
    .sort();
  const declaredVisualArtifacts = [...new Set(publication.binaryArtifacts)].sort();
  if (
    visualArtifacts.length !== declaredVisualArtifacts.length ||
    visualArtifacts.some((file, index) => file !== declaredVisualArtifacts[index])
  ) {
    throw new Error("publication binary artifact inventory does not match the bundle");
  }

  const runs = summaryRunsFromManifest(parseJsonFile(join(root, "manifest.json")));
  for (const run of runs) {
    const resultPath = `${run.target}/${run.slug}/result.json`;
    if (!byPath.has(resultPath)) {
      throw new Error(`manifest run is missing its publication result: ${resultPath}`);
    }
  }
  return { root, files, publication, runs };
};

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const publicControlFileUrl = (viewerUrl: string, relativePath: string) => {
  const viewer = validatedHttpsUrl(viewerUrl, "evidence viewer URL");
  if (!viewer.pathname.endsWith("/index.html")) {
    throw new Error("evidence viewer URL must end in index.html");
  }
  return relativePath === "index.html"
    ? viewer.toString()
    : new URL(relativePath, viewer).toString();
};

const verifyPublicFile = async (
  url: string,
  file: EvidenceBundleFile,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  attempts: number,
  retryDelayMs: number,
) => {
  const expected = readFileSync(file.absolutePath);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetcher(url, { headers: { "cache-control": "no-cache" } });
      if (!response.ok) throw new Error(`public read returned HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      const expectedType = file.artifact.mime.split(";", 1)[0]?.trim();
      if (contentType !== expectedType) {
        throw new Error(`public read returned content-type ${contentType || "missing"}`);
      }
      const actual = Buffer.from(await response.arrayBuffer());
      if (!actual.equals(expected)) throw new Error("public read did not match the uploaded file");
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await delay(retryDelayMs * (attempt + 1));
    }
  }
  throw new Error(`public verification failed for ${url}: ${String(lastError)}`);
};

export const verifyPublishedEvidence = async (options: PublicEvidenceVerificationOptions) => {
  const attempts = options.attempts ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 500;
  if (!Number.isInteger(attempts) || attempts <= 0 || retryDelayMs < 0) {
    throw new Error("public evidence verification retry settings are invalid");
  }
  const fetcher = options.fetcher ?? fetch;
  const controlFiles = ["manifest.json", "publication.json", "index.html"].map((relativePath) => {
    const file = options.files.find((candidate) => candidate.relativePath === relativePath);
    if (!file) throw new Error(`public evidence verification is missing ${relativePath}`);
    return file;
  });
  for (const file of controlFiles) {
    await verifyPublicFile(
      publicControlFileUrl(options.viewerUrl, file.relativePath),
      file,
      fetcher,
      attempts,
      retryDelayMs,
    );
  }
  return { verifiedFiles: controlFiles.length };
};

const markdownText = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");

export const evidenceSummaryMarkdown = (
  viewerUrl: string,
  runs: ReadonlyArray<EvidenceSummaryRun>,
) => {
  const currentRuns = latestSummaryRuns(runs);
  const visibleRuns = currentRuns.slice(0, MAX_SUMMARY_RUNS);
  const lines = [
    "## End-to-end evidence",
    "",
    `- [Open the hosted evidence matrix](${viewerUrl})`,
    "- This is an immutable, sanitizer-approved bundle for this workflow attempt.",
    "",
    "| Scenario | Target | Result | Direct run |",
    "| --- | --- | --- | --- |",
    ...visibleRuns.map(
      (run) =>
        `| ${markdownText(run.scenario)} | ${markdownText(run.target)} | ${run.ok ? "passed" : "failed"} | [open run](${evidenceRunUrl(viewerUrl, run.target, run.slug)}) |`,
    ),
  ];
  if (visibleRuns.length < currentRuns.length) {
    lines.push(
      "",
      `${currentRuns.length - visibleRuns.length} additional current matrix cells are linked from the hosted matrix.`,
    );
  }
  return `${lines.join("\n")}\n`;
};
