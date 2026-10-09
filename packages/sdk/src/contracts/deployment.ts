/** Immutable deployments, source files and expected build errors. */
import { Schema } from "effect";
import { ApiError } from "@executor-js/utils/api-error";
import { RecordedMessage } from "@executor-js/utils/recorded-message";
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
export const AppDeploymentChanged = ApiError.define({
  tag: "AppDeploymentChanged",
  status: 409,
  fields: {
    app: AppId,
    expected: Schema.NullOr(DeploymentId),
    current: Schema.NullOr(DeploymentId),
  },
  message:
    "The app's active deployment changed. Read the latest source and reconcile changes before retrying.",
});
export type AppDeploymentChanged = typeof AppDeploymentChanged.Type;

/**
 * A source location. Nested, because runtimes such as Bun set their own `line` and `column`
 * properties on every Error instance. `line` and `column` are both 1-based, and `column` counts
 * UTF-16 code units, as editors and stack traces print them. esbuild reports 0-based columns in
 * UTF-8 bytes and source maps 0-based columns in UTF-16 code units; they are converted where their
 * positions become a `SourceLocation`.
 */
export const SourceLocation = Schema.Struct({
  file: Schema.String.check(Schema.isMaxLength(1024)),
  line: Schema.optional(Schema.Int),
  column: Schema.optional(Schema.Int),
});
export type SourceLocation = typeof SourceLocation.Type;

/** The build step that failed. */
export const BuildStage = Schema.Literals([
  "source",
  "dependencies",
  "compile",
  "declaration",
  "retain",
  /** Applying the app's SQL migrations to its database, before activation. */
  "migrate",
]);

/** The build did not complete; nothing was retained, created or changed. */
export class DeploymentBuildFailed extends Schema.TaggedError<DeploymentBuildFailed>()(
  "DeploymentBuildFailed",
  {
    owner: OwnerId,
    name: Schema.NonEmptyString,
    reason: Schema.String,
    /** The build step that failed, when the runtime reported it. */
    stage: Schema.optional(BuildStage),
    /** The first failing source location, when known. */
    location: Schema.optional(SourceLocation),
    /** The stage, location and underlying failure, such as the compiler's own errors. */
    message: Schema.String,
  },
  {
    httpApiStatus: 422,
    description:
      "The build failed: no deployment was retained, no new app was created, and an existing app's active deployment is unchanged. Identified by (owner, name) because a first deploy has no app id yet. `message` describes the failing stage, source location and underlying error, such as compiler output or the error the app raised while declaring its requirements. Builds bind no accounts, so it holds no credentials.",
  },
) {
  /** The name is the deployer's and the message quotes their source; telemetry records the stage. */
  get [RecordedMessage]() {
    return this.stage === undefined
      ? "The build failed"
      : `The build failed at its ${this.stage} stage`;
  }
}

/** The compiler exhausted its memory before a new deployment could be activated. */
export const BuildMemoryExceeded = UserFacingError.define({
  tag: "BuildMemoryExceeded",
  status: 422,
  title: "App build hit the current memory limit",
  description:
    "This app's build needed more memory than Executor currently allows. No new deployment was activated.",
  recovery: {
    action:
      "This is a current platform limit, and we plan to raise it. Until then, fewer or smaller dependencies can help the build fit.",
    instructions:
      "The build ran out of memory during compilation, not while the app was running. This is a current Executor limit that is planned to increase; it does not mean the app is too large to run. Tell the user the build hit the current limit. Do not remove features, swap libraries, or prebuild dependencies unless the user asks. If they want to deploy now, offer those workarounds as options.",
  },
});
/** A confirmed compiler memory failure with safe recovery details. */
export type BuildMemoryExceeded = typeof BuildMemoryExceeded.Type;
