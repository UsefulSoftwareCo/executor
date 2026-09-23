/** Immutable deployments, source files and expected build errors. */
import { Schema } from "effect";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { AppCodeId, AppId, BuildId, DeploymentId, OwnerId } from "./shared.ts";
import { SourceCommit, SourceFiles } from "./source.ts";

export { SourceFiles, SourceFile, SourceFilePath } from "./source.ts";

/**
 * One immutable source version belonging to a single app code lineage. The deploying app supplies the deployment owner. `build` points at
 * retained compiled output, so activating any retained deployment —
 * including rollback — only moves the app's pointer: nothing is rebuilt
 * and no app data or external operations are reversed. The manifest is
 * NOT a build output: uploaded code is evaluated live on each use.
 */
export const DeploymentMetadata = Schema.Struct({
  id: DeploymentId,
  code: AppCodeId,
  owner: OwnerId,
  sourceCommit: Schema.NullOr(SourceCommit),
  build: BuildId,
  createdAt: Schema.Date,
});
/** A retained build reference without loading its source files. */
export type DeploymentMetadata = typeof DeploymentMetadata.Type;

/** Source inspection explicitly hydrates files; serving and execution use metadata. */
export const Deployment = Schema.Struct({
  ...DeploymentMetadata.fields,
  files: SourceFiles,
});

export type Deployment = typeof Deployment.Type;

/** Metadata for a retained deployment, without source contents. */
export const DeploymentSummary = Schema.Struct({
  id: DeploymentId,
  code: AppCodeId,
  owner: OwnerId,
  createdAt: Schema.Date,
  fileCount: Schema.Int.check(Schema.isGreaterThan(0)),
});

export type DeploymentSummary = typeof DeploymentSummary.Type;

/** No deployment with this id belongs to the configured app's code lineage. */
export const DeploymentNotFound = UserFacingError.define({
  tag: "DeploymentNotFound",
  status: 404,
  fields: { app: AppId, deployment: DeploymentId },
  title: "Deployment no longer available",
  description: "Executor could not find the requested deployment for this app.",
  recovery: {
    action: "Reload the app to use its current deployment. If this continues, check Deployments.",
    instructions:
      "Read the app’s current active deployment and retained deployments. Check for a stale deployment reference or an unavailable retained build. Reopen the current deployment through the supported app flow and verify tool discovery. Do not select a different app or roll back without the user’s choice.",
  },
});
/** Parsed missing deployment. */
export type DeploymentNotFound = typeof DeploymentNotFound.Type;

/** The app changed since the caller read it; retry against the current pointer. */
export class AppDeploymentChanged extends Schema.TaggedError<AppDeploymentChanged>()(
  "AppDeploymentChanged",
  { app: AppId, expected: Schema.NullOr(DeploymentId), current: Schema.NullOr(DeploymentId) },
  {
    httpApiStatus: 409,
    description:
      "The active deployment changed. Read the latest source and reconcile changes before retrying.",
  },
) {}

/** The build did not complete; nothing was retained, created or changed. */
export class DeploymentBuildFailed extends Schema.TaggedError<DeploymentBuildFailed>()(
  "DeploymentBuildFailed",
  { owner: OwnerId, name: Schema.NonEmptyString, reason: Schema.String },
  {
    httpApiStatus: 422,
    description:
      "The build failed: no deployment was retained, no new app was created, and an existing app's active deployment is unchanged. Identified by (owner, name) because a first deploy has no app id yet. `reason` is a safe summary without source or secrets.",
  },
) {}

/** The compiler exhausted its memory before a new deployment could be activated. */
export const BuildMemoryExceeded = UserFacingError.define({
  tag: "BuildMemoryExceeded",
  status: 422,
  title: "App build ran out of memory",
  description:
    "Executor ran out of memory while building the app. No new deployment was activated.",
  recovery: {
    action: "Review the build's dependencies and memory use before deploying again.",
    instructions:
      "Inspect dependency installation and compiler memory use for this build. This failure occurred during compilation, not while running the app. Reduce unnecessary build allocations or prepare large dependencies ahead of time, then verify deployment. Do not remove app features or dependencies without the user's agreement.",
  },
});
/** A confirmed compiler memory failure with safe recovery details. */
export type BuildMemoryExceeded = typeof BuildMemoryExceeded.Type;
