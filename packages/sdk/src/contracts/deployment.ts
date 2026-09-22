/** Immutable deployments, source files and expected build errors. */
import { Schema } from "effect";
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
export class DeploymentNotFound extends Schema.TaggedError<DeploymentNotFound>()(
  "DeploymentNotFound",
  { app: AppId, deployment: DeploymentId },
  {
    httpApiStatus: 404,
    description: "No deployment matches this id and the app's code lineage.",
  },
) {}

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
