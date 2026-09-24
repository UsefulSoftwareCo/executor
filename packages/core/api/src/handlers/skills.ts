import { Effect, Encoding, Result } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { FetchHttpClient } from "effect/unstable/http";
import {
  SkillPackageRejectedError,
  type ManagedSkill,
  type ManagedSkillSummary,
  type SkillCandidate,
  type SkillRevision,
  type SkillUpdateConflictResolution,
} from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { capture } from "../observability";
import { ExecutorService } from "../services";
import { discoverGitHubSkills } from "../skills/github";

const revisionToResponse = (revision: SkillRevision) => ({
  ...revision,
  name: revision.name === null ? null : String(revision.name),
  createdAt: revision.createdAt.getTime(),
});

const summaryToResponse = (skill: ManagedSkillSummary) => ({
  ...skill,
  name: skill.name === null ? null : String(skill.name),
  createdAt: skill.createdAt.getTime(),
  updatedAt: skill.updatedAt.getTime(),
});

const skillToResponse = (skill: ManagedSkill) => ({
  ...summaryToResponse(skill),
  revisions: skill.revisions.map(revisionToResponse),
});

const candidateToResponse = (candidate: SkillCandidate) => ({
  ...candidate,
  revision: {
    ...candidate.revision,
    name: candidate.revision.name === null ? null : String(candidate.revision.name),
  },
  createdAt: candidate.createdAt.getTime(),
  expiresAt: candidate.expiresAt.getTime(),
});

const decodePackage = (input: {
  readonly files: readonly {
    readonly path: string;
    readonly mediaType?: string;
    readonly bytes: string;
  }[];
}) =>
  Effect.forEach(input.files, (file) => {
    const decoded = Encoding.decodeBase64(file.bytes);
    return Result.isSuccess(decoded)
      ? Effect.succeed({ path: file.path, mediaType: file.mediaType, bytes: decoded.success })
      : Effect.fail(
          new SkillPackageRejectedError({
            diagnostics: [
              {
                severity: "blocking",
                code: "file_base64_invalid",
                message: `File "${file.path}" is not valid base64.`,
                path: file.path,
              },
            ],
          }),
        );
  });

const decodeConflictResolution = (resolution: {
  readonly path: string;
  readonly choice: "local" | "upstream" | "custom";
  readonly bytes?: string;
  readonly mediaType?: string;
}): Effect.Effect<SkillUpdateConflictResolution, SkillPackageRejectedError> => {
  if (resolution.choice !== "custom") {
    return Effect.succeed({ path: resolution.path, choice: resolution.choice });
  }
  const decoded = Encoding.decodeBase64(resolution.bytes ?? "");
  return Result.isSuccess(decoded)
    ? Effect.succeed({
        path: resolution.path,
        choice: "custom",
        bytes: decoded.success,
        mediaType: resolution.mediaType,
      })
    : Effect.fail(
        new SkillPackageRejectedError({
          diagnostics: [
            {
              severity: "blocking",
              code: "file_base64_invalid",
              message: `Conflict resolution for "${resolution.path}" is not valid base64.`,
              path: resolution.path,
            },
          ],
        }),
      );
};

export const SkillsHandlers = HttpApiBuilder.group(ExecutorApi, "skills", (handlers) =>
  handlers
    .handle("list", () =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return (yield* executor.skills.list()).map(summaryToResponse);
        }),
      ),
    )
    .handle("get", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return skillToResponse(yield* executor.skills.get({ skillId: params.skillId }));
        }),
      ),
    )
    .handle("readFile", ({ params, query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const file = yield* executor.skills.readFile({
            skillId: params.skillId,
            revisionId: query.revisionId,
            path: query.path,
          });
          return { manifest: file.manifest, bytes: Encoding.encodeBase64(file.bytes) };
        }),
      ),
    )
    .handle("create", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const files = yield* decodePackage(payload.package);
          return skillToResponse(
            yield* executor.skills.create({
              owner: payload.owner,
              package: { files },
              delivery: payload.delivery,
              requirements: payload.requirements,
            }),
          );
        }),
      ),
    )
    .handle("discover", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const result = yield* discoverGitHubSkills(executor, {
            input: payload.source,
            owner: payload.owner,
            tracking: payload.tracking,
          }).pipe(Effect.provide(FetchHttpClient.layer));
          return { ...result, candidates: result.candidates.map(candidateToResponse) };
        }),
      ),
    )
    .handle("importCandidate", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return skillToResponse(yield* executor.skills.importCandidate(payload));
        }),
      ),
    )
    .handle("edit", ({ params, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const files = yield* decodePackage(payload.package);
          return skillToResponse(
            yield* executor.skills.edit({
              skillId: params.skillId,
              ...(payload.owner === undefined ? {} : { owner: payload.owner }),
              expectedActiveRevisionId: payload.expectedActiveRevisionId,
              package: { files },
            }),
          );
        }),
      ),
    )
    .handle("setDelivery", ({ params, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return skillToResponse(
            yield* executor.skills.setDelivery({
              skillId: params.skillId,
              delivery: payload.delivery,
            }),
          );
        }),
      ),
    )
    .handle("setSource", ({ params, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return skillToResponse(
            yield* executor.skills.setSource({
              skillId: params.skillId,
              change: payload.change,
            }),
          );
        }),
      ),
    )
    .handle("setRequirements", ({ params, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return skillToResponse(
            yield* executor.skills.setRequirements({
              skillId: params.skillId,
              requirements: payload.requirements,
            }),
          );
        }),
      ),
    )
    .handle("checkSource", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const skill = yield* executor.skills.get({ skillId: params.skillId });
          if (skill.source.kind !== "imported" || skill.source.tracking.kind === "pinned") {
            return { kind: "noUpdate" as const };
          }
          if (skill.source.locator.kind !== "github") {
            return {
              kind: "sourceFailure" as const,
              message: "This source must be checked by its owning adapter.",
            };
          }
          const [repositoryOwner, repository] = skill.source.locator.repository.split("/");
          if (!repositoryOwner || !repository) {
            return {
              kind: "sourceFailure" as const,
              message: "The stored GitHub repository locator is invalid.",
            };
          }
          const result = yield* discoverGitHubSkills(executor, {
            owner: skill.owner,
            tracking: "follow",
            resolvedInput: {
              owner: repositoryOwner,
              repository,
              requestedRef: skill.source.tracking.symbolicReference,
              directory: skill.source.locator.directory,
              selectedSkills: [],
            },
          }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.catchTag("SkillSourceUnavailableError", (error) =>
              Effect.succeed({ sourceFailure: error.message } as const),
            ),
          );
          if ("sourceFailure" in result) {
            return { kind: "sourceFailure" as const, message: result.sourceFailure };
          }
          const candidate = result.candidates[0];
          if (!candidate) {
            return {
              kind: "sourceFailure" as const,
              message: result.rejected[0]?.reason ?? "The source no longer contains this skill.",
            };
          }
          const review = yield* executor.skills.reviewCandidate({
            skillId: skill.id,
            candidateId: candidate.id,
          });
          return review.changes.length === 0
            ? { kind: "noUpdate" as const }
            : {
                kind: "updateAvailable" as const,
                candidate: candidateToResponse(candidate),
                review,
              };
        }),
      ),
    )
    .handle("reviewUpdate", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return yield* executor.skills.reviewCandidate({
            skillId: params.skillId,
            candidateId: params.candidateId,
          });
        }),
      ),
    )
    .handle("applyUpdate", ({ params, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const resolutions = yield* Effect.forEach(payload.resolutions, decodeConflictResolution);
          return skillToResponse(
            yield* executor.skills.applyCandidate({
              skillId: params.skillId,
              candidateId: params.candidateId,
              expectedActiveRevisionId: payload.expectedActiveRevisionId,
              expectedBaselineRevisionId: payload.expectedBaselineRevisionId,
              resolutions,
            }),
          );
        }),
      ),
    )
    .handle("restoreRevision", ({ params, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return skillToResponse(
            yield* executor.skills.restoreRevision({
              skillId: params.skillId,
              revisionId: params.revisionId,
              expectedActiveRevisionId: payload.expectedActiveRevisionId,
            }),
          );
        }),
      ),
    )
    .handle("export", ({ params, query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const exported = yield* executor.skills.export({
            skillId: params.skillId,
            revisionId: query.revisionId,
            kind: query.kind,
          });
          if (exported.kind === "portable") {
            return {
              kind: exported.kind,
              revisionId: exported.revisionId,
              packageDigest: exported.packageDigest,
              name: String(exported.name),
              files: exported.files.map((file) => ({
                ...file,
                bytes: Encoding.encodeBase64(file.bytes),
              })),
            };
          }
          return {
            kind: exported.kind,
            skill: skillToResponse(exported.skill),
            revision: revisionToResponse(exported.revision),
            revisionId: exported.revision.id,
            packageDigest: exported.revision.packageDigest,
            name: exported.revision.name === null ? null : String(exported.revision.name),
            files: exported.files.map((file) => ({
              ...file,
              bytes: Encoding.encodeBase64(file.bytes),
            })),
          };
        }),
      ),
    )
    .handle("remove", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.skills.remove({ skillId: params.skillId });
          return { removed: true };
        }),
      ),
    ),
);
