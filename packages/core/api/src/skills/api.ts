import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  InternalError,
  ManagedSkillId,
  ManagedSkillNotFoundError,
  OrgWriteDeniedError,
  Owner,
  PortableSkillExportRejectedError,
  SkillDelivery,
  SkillCandidateId,
  SkillCandidateExpiredError,
  SkillCandidateNotFoundError,
  SkillCandidateMismatchError,
  SkillDiagnostic,
  SkillInvalidTransitionError,
  SkillNameConflictError,
  SkillPackageDigest,
  SkillPackageManifestFile,
  SkillPackageRejectedError,
  SkillRevisionConflictError,
  SkillRevisionId,
  SkillRevisionNotFoundError,
  SkillRequirement,
  SkillRequirementStatus,
  SkillSource,
  SkillSourceUnavailableError,
  SkillTracking,
  SkillUpdateConflictError,
  SkillUpdateFileChange,
  StagedSkillSource,
} from "@executor-js/sdk/shared";

export const SkillPackageFilePayload = Schema.Struct({
  path: Schema.String,
  mediaType: Schema.optional(Schema.String),
  bytes: Schema.String,
});

export const SkillPackagePayload = Schema.Struct({
  files: Schema.Array(SkillPackageFilePayload),
});

const SkillWriteDelivery = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("disabled") }),
  Schema.Struct({
    kind: Schema.Literal("enabled"),
    invocation: Schema.Literals(["manual", "model"]),
  }),
]);

export const SkillRevisionResponse = Schema.Struct({
  id: SkillRevisionId,
  packageDigest: SkillPackageDigest,
  name: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  frontmatter: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  files: Schema.Array(SkillPackageManifestFile),
  diagnostics: Schema.Array(SkillDiagnostic),
  createdAt: Schema.Number,
});

export const ManagedSkillSummaryResponse = Schema.Struct({
  id: ManagedSkillId,
  owner: Owner,
  name: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  activeRevisionId: SkillRevisionId,
  delivery: SkillDelivery,
  source: SkillSource,
  requirements: Schema.Array(SkillRequirement),
  requirementStatuses: Schema.Array(SkillRequirementStatus),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const ManagedSkillResponse = Schema.Struct({
  ...ManagedSkillSummaryResponse.fields,
  revisions: Schema.Array(SkillRevisionResponse),
});

export const ManagedSkillFileResponse = Schema.Struct({
  manifest: SkillPackageManifestFile,
  bytes: Schema.String,
});

export const SkillCandidateResponse = Schema.Struct({
  id: SkillCandidateId,
  owner: Owner,
  source: StagedSkillSource,
  upstreamRevision: Schema.String,
  revision: Schema.Struct({
    packageDigest: SkillPackageDigest,
    name: Schema.NullOr(Schema.String),
    description: Schema.NullOr(Schema.String),
    frontmatter: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
    files: Schema.Array(SkillPackageManifestFile),
    diagnostics: Schema.Array(SkillDiagnostic),
  }),
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
});

export const SkillUpdateReviewResponse = Schema.Struct({
  skillId: ManagedSkillId,
  candidateId: SkillCandidateId,
  expectedActiveRevisionId: SkillRevisionId,
  expectedBaselineRevisionId: SkillRevisionId,
  changes: Schema.Array(SkillUpdateFileChange),
  conflicts: Schema.Array(Schema.String),
});

const ManagedSkillExportFiles = Schema.Array(
  Schema.Struct({ path: Schema.String, mediaType: Schema.String, bytes: Schema.String }),
);

export const ManagedSkillExportResponse = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("portable"),
    revisionId: SkillRevisionId,
    packageDigest: SkillPackageDigest,
    name: Schema.String,
    files: ManagedSkillExportFiles,
  }),
  Schema.Struct({
    kind: Schema.Literal("backup"),
    skill: ManagedSkillResponse,
    revision: SkillRevisionResponse,
    revisionId: SkillRevisionId,
    packageDigest: SkillPackageDigest,
    name: Schema.NullOr(Schema.String),
    files: ManagedSkillExportFiles,
  }),
]);

const SkillParams = { skillId: ManagedSkillId };
const SkillRevisionParams = { skillId: ManagedSkillId, revisionId: SkillRevisionId };
const SkillPackageErrors = [InternalError, SkillPackageRejectedError, OrgWriteDeniedError];
const SkillMutationErrors = [
  InternalError,
  ManagedSkillNotFoundError,
  SkillPackageRejectedError,
  SkillNameConflictError,
  SkillRevisionConflictError,
  OrgWriteDeniedError,
];

export const SkillsApi = HttpApiGroup.make("skills")
  .add(
    HttpApiEndpoint.get("list", "/skills", {
      success: Schema.Array(ManagedSkillSummaryResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/skills/:skillId", {
      params: SkillParams,
      success: ManagedSkillResponse,
      error: [InternalError, ManagedSkillNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.get("readFile", "/skills/:skillId/files", {
      params: SkillParams,
      query: Schema.Struct({
        path: Schema.String,
        revisionId: Schema.optional(SkillRevisionId),
      }),
      success: ManagedSkillFileResponse,
      error: [InternalError, ManagedSkillNotFoundError, SkillRevisionNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/skills", {
      payload: Schema.Struct({
        owner: Owner,
        package: SkillPackagePayload,
        delivery: Schema.optional(SkillWriteDelivery),
        requirements: Schema.optional(Schema.Array(SkillRequirement)),
      }),
      success: ManagedSkillResponse,
      error: SkillPackageErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("discover", "/skills/discover", {
      payload: Schema.Struct({
        source: Schema.String,
        owner: Owner,
        tracking: Schema.Literals(["pin", "follow"]),
      }),
      success: Schema.Struct({
        candidates: Schema.Array(SkillCandidateResponse),
        rejected: Schema.Array(Schema.Struct({ directory: Schema.String, reason: Schema.String })),
        truncated: Schema.Boolean,
      }),
      error: [
        InternalError,
        SkillSourceUnavailableError,
        SkillPackageRejectedError,
        OrgWriteDeniedError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("importCandidate", "/skills/import", {
      payload: Schema.Struct({
        candidateId: SkillCandidateId,
        delivery: Schema.optional(SkillWriteDelivery),
      }),
      success: ManagedSkillResponse,
      error: [
        InternalError,
        SkillCandidateNotFoundError,
        SkillCandidateExpiredError,
        OrgWriteDeniedError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.put("edit", "/skills/:skillId/package", {
      params: SkillParams,
      payload: Schema.Struct({
        owner: Schema.optional(Owner),
        expectedActiveRevisionId: SkillRevisionId,
        package: SkillPackagePayload,
      }),
      success: ManagedSkillResponse,
      error: SkillMutationErrors,
    }),
  )
  .add(
    HttpApiEndpoint.put("setDelivery", "/skills/:skillId/delivery", {
      params: SkillParams,
      payload: Schema.Struct({ delivery: SkillWriteDelivery }),
      success: ManagedSkillResponse,
      error: [
        InternalError,
        ManagedSkillNotFoundError,
        SkillInvalidTransitionError,
        OrgWriteDeniedError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.put("setSource", "/skills/:skillId/source", {
      params: SkillParams,
      payload: Schema.Struct({
        change: Schema.Union([
          Schema.Struct({ kind: Schema.Literal("detach") }),
          Schema.Struct({ kind: Schema.Literal("setTracking"), tracking: SkillTracking }),
        ]),
      }),
      success: ManagedSkillResponse,
      error: [
        InternalError,
        ManagedSkillNotFoundError,
        SkillInvalidTransitionError,
        OrgWriteDeniedError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.put("setRequirements", "/skills/:skillId/requirements", {
      params: SkillParams,
      payload: Schema.Struct({ requirements: Schema.Array(SkillRequirement) }),
      success: ManagedSkillResponse,
      error: [InternalError, ManagedSkillNotFoundError, OrgWriteDeniedError],
    }),
  )
  .add(
    HttpApiEndpoint.post("checkSource", "/skills/:skillId/source/check", {
      params: SkillParams,
      success: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("noUpdate") }),
        Schema.Struct({
          kind: Schema.Literal("updateAvailable"),
          candidate: SkillCandidateResponse,
          review: SkillUpdateReviewResponse,
        }),
        Schema.Struct({ kind: Schema.Literal("sourceFailure"), message: Schema.String }),
      ]),
      error: [
        InternalError,
        ManagedSkillNotFoundError,
        SkillCandidateNotFoundError,
        SkillCandidateExpiredError,
        SkillCandidateMismatchError,
        SkillPackageRejectedError,
        OrgWriteDeniedError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("reviewUpdate", "/skills/:skillId/updates/:candidateId", {
      params: { skillId: ManagedSkillId, candidateId: SkillCandidateId },
      success: SkillUpdateReviewResponse,
      error: [
        InternalError,
        ManagedSkillNotFoundError,
        SkillCandidateNotFoundError,
        SkillCandidateExpiredError,
        SkillCandidateMismatchError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("applyUpdate", "/skills/:skillId/updates/:candidateId/apply", {
      params: { skillId: ManagedSkillId, candidateId: SkillCandidateId },
      payload: Schema.Struct({
        expectedActiveRevisionId: SkillRevisionId,
        expectedBaselineRevisionId: SkillRevisionId,
        resolutions: Schema.Array(
          Schema.Union([
            Schema.Struct({
              path: Schema.String,
              choice: Schema.Literals(["local", "upstream"]),
            }),
            Schema.Struct({
              path: Schema.String,
              choice: Schema.Literal("custom"),
              bytes: Schema.String,
              mediaType: Schema.optional(Schema.String),
            }),
          ]),
        ),
      }),
      success: ManagedSkillResponse,
      error: [
        InternalError,
        ManagedSkillNotFoundError,
        SkillCandidateNotFoundError,
        SkillCandidateExpiredError,
        SkillCandidateMismatchError,
        SkillRevisionConflictError,
        SkillUpdateConflictError,
        SkillPackageRejectedError,
        OrgWriteDeniedError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("restoreRevision", "/skills/:skillId/revisions/:revisionId/restore", {
      params: SkillRevisionParams,
      payload: Schema.Struct({ expectedActiveRevisionId: SkillRevisionId }),
      success: ManagedSkillResponse,
      error: [
        InternalError,
        ManagedSkillNotFoundError,
        SkillRevisionNotFoundError,
        SkillRevisionConflictError,
        OrgWriteDeniedError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("export", "/skills/:skillId/export", {
      params: SkillParams,
      query: Schema.Struct({
        kind: Schema.Literals(["portable", "backup"]),
        revisionId: Schema.optional(SkillRevisionId),
      }),
      success: ManagedSkillExportResponse,
      error: [
        InternalError,
        ManagedSkillNotFoundError,
        SkillRevisionNotFoundError,
        PortableSkillExportRejectedError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/skills/:skillId", {
      params: SkillParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: [InternalError, ManagedSkillNotFoundError, OrgWriteDeniedError],
    }),
  );
