import { Option, Schema } from "effect";

import type { SkillCandidateRow, SkillRevisionRow, SkillSummaryRow } from "./core-schema";
import {
  ManagedSkillId,
  Owner,
  SkillName,
  SkillCandidateId,
  SkillPackageDigest,
  SkillRevisionId,
} from "./ids";
import {
  SkillDiagnostic,
  SkillPackageManifestFile,
  type SkillPackageFileInput,
} from "./skill-package";

export const SkillInvocation = Schema.Literals(["manual", "model"]);
export type SkillInvocation = typeof SkillInvocation.Type;

export const SkillDelivery = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("blocked"), diagnostics: Schema.Array(SkillDiagnostic) }),
  Schema.Struct({ kind: Schema.Literal("disabled") }),
  Schema.Struct({ kind: Schema.Literal("enabled"), invocation: SkillInvocation }),
]);
export type SkillDelivery = typeof SkillDelivery.Type;

export const GitHubSkillSource = Schema.Struct({
  kind: Schema.Literal("github"),
  repository: Schema.String,
  directory: Schema.String,
  requestedRef: Schema.String,
  resolvedCommit: Schema.String,
});
export const WellKnownSkillSource = Schema.Struct({
  kind: Schema.Literal("wellKnown"),
  indexUrl: Schema.String,
  entryId: Schema.String,
  packageUrl: Schema.String,
  advertisedRevision: Schema.NullOr(Schema.String),
});
export const McpSkillSource = Schema.Struct({
  kind: Schema.Literal("mcp"),
  connection: Schema.String,
  uri: Schema.String,
  digest: Schema.String,
});
export const LocalSkillSource = Schema.Struct({
  kind: Schema.Literal("local"),
  path: Schema.String,
  digest: SkillPackageDigest,
});
export const SkillSourceLocator = Schema.Union([
  GitHubSkillSource,
  WellKnownSkillSource,
  McpSkillSource,
  LocalSkillSource,
]);
export type SkillSourceLocator = typeof SkillSourceLocator.Type;

export const SkillTracking = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pinned"), upstreamRevision: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("tracked"),
    symbolicReference: Schema.String,
    resolvedRevision: Schema.String,
  }),
]);
export type SkillTracking = typeof SkillTracking.Type;

export const SkillSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("authored") }),
  Schema.Struct({
    kind: Schema.Literal("imported"),
    locator: SkillSourceLocator,
    tracking: SkillTracking,
    baselineRevisionId: SkillRevisionId,
  }),
]);
export type SkillSource = typeof SkillSource.Type;

export const SkillRequirement = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("integration"),
    integration: Schema.String,
    toolPatterns: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("connection"),
    integration: Schema.String,
    authMethod: Schema.NullOr(Schema.String),
    oauthScopes: Schema.Array(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("mcp"), integration: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("runtime"),
    command: Schema.String,
    version: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("skill"),
    name: Schema.String,
    owner: Schema.NullOr(Owner),
  }),
]);
export type SkillRequirement = typeof SkillRequirement.Type;

export const SkillRequirementStatus = Schema.Struct({
  requirement: SkillRequirement,
  status: Schema.Literals(["satisfied", "missing", "blocked", "needs-user-action", "unknown"]),
  evidence: Schema.NullOr(Schema.String),
});
export type SkillRequirementStatus = typeof SkillRequirementStatus.Type;

export const StagedSkillSource = Schema.Struct({
  locator: SkillSourceLocator,
  tracking: SkillTracking,
});
export type StagedSkillSource = typeof StagedSkillSource.Type;

export interface SkillRevision {
  readonly id: SkillRevisionId;
  readonly packageDigest: SkillPackageDigest;
  readonly name: SkillName | null;
  readonly description: string | null;
  readonly frontmatter: Readonly<Record<string, unknown>> | null;
  readonly files: readonly SkillPackageManifestFile[];
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly createdAt: Date;
}

export interface ManagedSkillSummary {
  readonly id: ManagedSkillId;
  readonly owner: Owner;
  readonly name: SkillName | null;
  readonly description: string | null;
  readonly activeRevisionId: SkillRevisionId;
  readonly delivery: SkillDelivery;
  readonly source: SkillSource;
  readonly requirements: readonly SkillRequirement[];
  readonly requirementStatuses: readonly SkillRequirementStatus[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ManagedSkill extends ManagedSkillSummary {
  readonly revisions: readonly SkillRevision[];
}

export interface CreateManagedSkillInput {
  readonly owner: Owner;
  readonly package: { readonly files: readonly SkillPackageFileInput[] };
  readonly delivery?:
    | { readonly kind: "disabled" }
    | { readonly kind: "enabled"; readonly invocation: SkillInvocation };
  readonly requirements?: readonly SkillRequirement[];
}

export interface StageSkillCandidateInput {
  readonly owner: Owner;
  readonly package: { readonly files: readonly SkillPackageFileInput[] };
  readonly source: StagedSkillSource;
}

export interface SkillCandidate {
  readonly id: SkillCandidateId;
  readonly owner: Owner;
  readonly source: StagedSkillSource;
  readonly upstreamRevision: string;
  readonly revision: Omit<SkillRevision, "id" | "createdAt">;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface ImportSkillCandidateInput {
  readonly candidateId: SkillCandidateId;
  readonly delivery?:
    | { readonly kind: "disabled" }
    | { readonly kind: "enabled"; readonly invocation: SkillInvocation };
}

export const SkillUpdateFileChange = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["added", "removed", "changed"]),
  conflict: Schema.Boolean,
  baselineDigest: Schema.NullOr(Schema.String),
  activeDigest: Schema.NullOr(Schema.String),
  candidateDigest: Schema.NullOr(Schema.String),
});
export type SkillUpdateFileChange = typeof SkillUpdateFileChange.Type;

export interface SkillUpdateReview {
  readonly skillId: ManagedSkillId;
  readonly candidateId: SkillCandidateId;
  readonly expectedActiveRevisionId: SkillRevisionId;
  readonly expectedBaselineRevisionId: SkillRevisionId;
  readonly changes: readonly SkillUpdateFileChange[];
  readonly conflicts: readonly string[];
}

export interface ReviewSkillCandidateInput {
  readonly skillId: ManagedSkillId;
  readonly candidateId: SkillCandidateId;
}

export type SkillUpdateConflictResolution =
  | { readonly path: string; readonly choice: "local" | "upstream" }
  | {
      readonly path: string;
      readonly choice: "custom";
      readonly bytes: Uint8Array;
      readonly mediaType?: string;
    };

export interface ApplySkillCandidateInput {
  readonly skillId: ManagedSkillId;
  readonly candidateId: SkillCandidateId;
  readonly expectedActiveRevisionId: SkillRevisionId;
  readonly expectedBaselineRevisionId: SkillRevisionId;
  readonly resolutions: readonly SkillUpdateConflictResolution[];
}

export interface EditManagedSkillInput {
  readonly skillId: ManagedSkillId;
  readonly owner?: Owner;
  readonly expectedActiveRevisionId: SkillRevisionId;
  readonly package: { readonly files: readonly SkillPackageFileInput[] };
}

export interface ReadManagedSkillFileInput {
  readonly skillId: ManagedSkillId;
  readonly revisionId?: SkillRevisionId;
  readonly path: string;
}

export interface RestoreManagedSkillRevisionInput {
  readonly skillId: ManagedSkillId;
  readonly expectedActiveRevisionId: SkillRevisionId;
  readonly revisionId: SkillRevisionId;
}

export interface RemoveManagedSkillInput {
  readonly skillId: ManagedSkillId;
}

export interface SetManagedSkillDeliveryInput {
  readonly skillId: ManagedSkillId;
  readonly delivery:
    | { readonly kind: "disabled" }
    | { readonly kind: "enabled"; readonly invocation: SkillInvocation };
}

export type ManagedSkillSourceChange =
  | { readonly kind: "detach" }
  | { readonly kind: "setTracking"; readonly tracking: SkillTracking };

export interface SetManagedSkillSourceInput {
  readonly skillId: ManagedSkillId;
  readonly change: ManagedSkillSourceChange;
}

export interface SetManagedSkillRequirementsInput {
  readonly skillId: ManagedSkillId;
  readonly requirements: readonly SkillRequirement[];
}

export interface ExportManagedSkillInput {
  readonly skillId: ManagedSkillId;
  readonly revisionId?: SkillRevisionId;
  readonly kind: "portable" | "backup";
}

export interface ManagedSkillFile {
  readonly manifest: SkillPackageManifestFile;
  readonly bytes: Uint8Array;
}

export interface ManagedSkillExportFile {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export type ManagedSkillExport =
  | {
      readonly kind: "portable";
      readonly revisionId: SkillRevisionId;
      readonly packageDigest: SkillPackageDigest;
      readonly name: SkillName;
      readonly files: readonly ManagedSkillExportFile[];
    }
  | {
      readonly kind: "backup";
      readonly skill: ManagedSkill;
      readonly revision: SkillRevision;
      readonly files: readonly ManagedSkillExportFile[];
    };

const decodeJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const jsonColumn = (value: unknown): Option.Option<unknown> =>
  typeof value === "string" ? decodeJsonString(value) : Option.some(value);
const decodeDelivery = Schema.decodeUnknownOption(SkillDelivery);
const decodeSource = Schema.decodeUnknownOption(SkillSource);
const decodeOwner = Schema.decodeUnknownOption(Owner);
const decodeFiles = Schema.decodeUnknownOption(Schema.Array(SkillPackageManifestFile));
const decodeDiagnostics = Schema.decodeUnknownOption(Schema.Array(SkillDiagnostic));
const decodeStagedSource = Schema.decodeUnknownOption(StagedSkillSource);
const decodeRequirements = Schema.decodeUnknownOption(Schema.Array(SkillRequirement));

const asDate = (value: Date | number | string): Date =>
  value instanceof Date ? value : new Date(value);

export const managedSkillSummaryFromRow = (
  row: SkillSummaryRow,
): Option.Option<ManagedSkillSummary> =>
  Option.gen(function* () {
    const owner = yield* decodeOwner(row.owner);
    const delivery = yield* Option.flatMap(jsonColumn(row.delivery), decodeDelivery);
    const source = yield* Option.flatMap(jsonColumn(row.source), decodeSource);
    const requirements = Option.getOrElse(
      Option.flatMap(jsonColumn(row.requirements), decodeRequirements),
      () => [],
    );
    return {
      id: ManagedSkillId.make(row.id),
      owner,
      name: row.name === null ? null : SkillName.make(row.name),
      description: row.description,
      activeRevisionId: SkillRevisionId.make(row.active_revision_id),
      delivery,
      source,
      requirements,
      requirementStatuses: requirements.map((requirement) => ({
        requirement,
        status: "unknown" as const,
        evidence: null,
      })),
      createdAt: asDate(row.created_at),
      updatedAt: asDate(row.updated_at),
    };
  });

export const skillRevisionFromRow = (row: SkillRevisionRow): Option.Option<SkillRevision> =>
  Option.gen(function* () {
    const files = yield* Option.flatMap(jsonColumn(row.files), decodeFiles);
    const diagnostics = yield* Option.flatMap(jsonColumn(row.diagnostics), decodeDiagnostics);
    const frontmatterValue = yield* jsonColumn(row.frontmatter);
    const frontmatter =
      typeof frontmatterValue === "object" &&
      frontmatterValue !== null &&
      !Array.isArray(frontmatterValue)
        ? Object.fromEntries(Object.entries(frontmatterValue))
        : null;
    return {
      id: SkillRevisionId.make(row.id),
      packageDigest: SkillPackageDigest.make(row.package_digest),
      name: row.name === null ? null : SkillName.make(row.name),
      description: row.description,
      frontmatter,
      files,
      diagnostics,
      createdAt: asDate(row.created_at),
    };
  });

export const skillCandidateFromRow = (row: SkillCandidateRow): Option.Option<SkillCandidate> =>
  Option.gen(function* () {
    const owner = yield* decodeOwner(row.owner);
    const source = yield* Option.flatMap(jsonColumn(row.source), decodeStagedSource);
    const files = yield* Option.flatMap(jsonColumn(row.files), decodeFiles);
    const diagnostics = yield* Option.flatMap(jsonColumn(row.diagnostics), decodeDiagnostics);
    const frontmatterValue = yield* jsonColumn(row.frontmatter);
    const frontmatter =
      typeof frontmatterValue === "object" &&
      frontmatterValue !== null &&
      !Array.isArray(frontmatterValue)
        ? Object.fromEntries(Object.entries(frontmatterValue))
        : null;
    return {
      id: SkillCandidateId.make(row.id),
      owner,
      source,
      upstreamRevision:
        source.tracking.kind === "pinned"
          ? source.tracking.upstreamRevision
          : source.tracking.resolvedRevision,
      revision: {
        packageDigest: SkillPackageDigest.make(row.package_digest),
        name: row.name === null ? null : SkillName.make(row.name),
        description: row.description,
        frontmatter,
        files,
        diagnostics,
      },
      createdAt: asDate(row.created_at),
      expiresAt: asDate(row.expires_at),
    };
  });
