import type { EvidencePublicationMetadata } from "../../src/published-artifacts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

export const parsePublicationMetadata = (value: unknown): EvidencePublicationMetadata | null => {
  if (!record(value) || value.schemaVersion !== 1 || !finiteNumber(value.sanitizedAt)) return null;
  if (value.status !== "passed" && value.status !== "failed") return null;
  if (!record(value.sanitizer) || !record(value.policy) || !record(value.runtime)) return null;
  if (!record(value.stats)) return null;
  if (
    value.sanitizer.source !== "e2e/scripts/sanitize-evidence.ts" ||
    value.sanitizer.policyVersion !== 1 ||
    value.policy.unknownArtifacts !== "removed" ||
    value.policy.textAndJson !== "redacted" ||
    value.policy.binaryVisuals !== "unredacted-synthetic-only" ||
    value.policy.binarySecretDetection !== "byte-canary-only"
  ) {
    return null;
  }
  const { runtime, stats } = value;
  if (
    typeof runtime.name !== "string" ||
    typeof runtime.version !== "string" ||
    typeof runtime.platform !== "string" ||
    typeof runtime.arch !== "string" ||
    !finiteNumber(stats.removed) ||
    !finiteNumber(stats.redacted) ||
    !finiteNumber(stats.retained) ||
    !finiteNumber(stats.canariesChecked)
  ) {
    return null;
  }
  const sourceRevision = value.sanitizer.sourceRevision;
  return {
    schemaVersion: 1,
    sanitizedAt: value.sanitizedAt,
    status: value.status,
    sanitizer: {
      source: "e2e/scripts/sanitize-evidence.ts",
      policyVersion: 1,
      ...(typeof sourceRevision === "string" ? { sourceRevision } : {}),
    },
    policy: {
      unknownArtifacts: "removed",
      textAndJson: "redacted",
      binaryVisuals: "unredacted-synthetic-only",
      binarySecretDetection: "byte-canary-only",
    },
    runtime: {
      name: runtime.name,
      version: runtime.version,
      platform: runtime.platform,
      arch: runtime.arch,
    },
    stats: {
      removed: stats.removed,
      redacted: stats.redacted,
      retained: stats.retained,
      canariesChecked: stats.canariesChecked,
    },
    binaryArtifacts: strings(value.binaryArtifacts),
    errors: strings(value.errors),
  };
};

export const PublicationBanner = ({
  metadata,
}: {
  readonly metadata: EvidencePublicationMetadata | null | undefined;
}) => {
  if (metadata === undefined) return null;
  if (metadata === null) {
    return (
      <aside className="publication-banner local" role="status">
        <strong>Local evidence, sanitizer provenance unavailable</strong>
        <span>Do not publish this directory until the evidence sanitizer has passed.</span>
      </aside>
    );
  }
  const visualCount = metadata.binaryArtifacts.length;
  return (
    <aside
      className={"publication-banner " + metadata.status}
      role={metadata.status === "failed" ? "alert" : "status"}
    >
      <strong>
        {metadata.status === "passed" ? "Sanitized evidence publication" : "Sanitizer failed"}
      </strong>
      <span>
        Text and JSON were redacted. {visualCount} visual{" "}
        {visualCount === 1 ? "artifact" : "artifacts"} remain unredacted under the synthetic-only
        policy. Byte canaries checked: {metadata.stats.canariesChecked}.
      </span>
    </aside>
  );
};

export default PublicationBanner;
