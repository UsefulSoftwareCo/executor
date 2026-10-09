import { DeploymentId, OwnerId, ProfileId } from "./shared.ts";
import { SelectedAccounts } from "./apps.ts";
import { ProfileErrors, ProfileRevision } from "./profiles.ts";
/** App-scoped workflow discovery and run management share one HTTP contract. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  HostedWorkflow,
  WorkflowRun,
  WorkflowRunId,
  WorkflowRunPage,
  WorkflowFailure,
  WorkflowName,
  WorkflowValue,
} from "apps/contracts";
import { AppId, StorageError, CredentialsError, RequestInvalid } from "./shared.ts";
import { AppNotDeployed, AppNotFound, AccountRequired, AccountSelectionInvalid } from "./apps.ts";
import { AccountNotFound } from "./account.ts";
import { DeploymentNotFound } from "./deployment.ts";
import { OAuthReconnectRequired, OAuthRenewalFailed } from "./oauth.ts";

export { HostedWorkflow, WorkflowRun, WorkflowRunId, WorkflowRunPage, WorkflowFailure };
/** Start keys deduplicate retries within one configured app. */
export const StartWorkflow = Schema.Struct({
  app: AppId,
  profile: Schema.optional(ProfileId),
  expectedProfileRevision: Schema.optional(ProfileRevision),
  deployment: Schema.optional(DeploymentId),
  workflow: WorkflowName,
  input: WorkflowValue,
  key: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(128))),
});
/** Runs are addressed within their configured app, never globally by ID alone. */
export const WorkflowTarget = Schema.Struct({ app: AppId, run: WorkflowRunId });
/** What a retained run pinned when it started: the accounts it may use and its profile. */
export const PinnedWorkflowRun = Schema.Struct({
  accounts: SelectedAccounts,
  profile: Schema.NullOr(ProfileId),
});
export type PinnedWorkflowRun = typeof PinnedWorkflowRun.Type;
/** Bounded definition and history reads preserve product-owned authorization. */
export const WorkflowApp = Schema.Struct({
  app: AppId,
  profile: Schema.optional(ProfileId),
  expectedProfileRevision: Schema.optional(ProfileRevision),
  deployment: Schema.optional(DeploymentId),
});
export const ListWorkflowRuns = Schema.Struct({
  app: AppId,
  profile: Schema.optional(ProfileId),
  workflow: Schema.optional(WorkflowName),
  /** Only the run started with this idempotency key, if it was retained. */
  key: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(128))),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
  cursor: Schema.optional(WorkflowRunId),
});
/** Expected failures remain safe and typed at every serving boundary. */
export const WorkflowErrors = [
  ...ProfileErrors,
  StorageError,
  CredentialsError,
  RequestInvalid,
  AppNotFound,
  AppNotDeployed,
  AccountNotFound,
  AccountRequired,
  AccountSelectionInvalid,
  DeploymentNotFound,
  OAuthReconnectRequired,
  OAuthRenewalFailed,
  WorkflowFailure,
] as const;

const path = "/v1/apps/:app/workflow-runs";
/** Flat transport groups are projected beneath executor.apps in the public SDK. */
export const AppWorkflowsGroup = HttpApiGroup.make("appWorkflows").add(
  HttpApiEndpoint.get("list", "/v1/apps/:app/workflows", {
    params: { app: AppId },
    query: {
      profile: Schema.optional(ProfileId),
      deployment: Schema.optional(DeploymentId),
      expectedProfileRevision: Schema.optional(
        Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
      ),
    },
    success: Schema.Array(HostedWorkflow),
    error: WorkflowErrors,
  }),
);
/** Lifecycle operations start quickly and return a retained run identity. */
export const AppWorkflowRunsGroup = HttpApiGroup.make("appWorkflowRuns")
  .add(
    HttpApiEndpoint.post("start", path, {
      params: { app: AppId },
      payload: StartWorkflow.mapFields(({ app: _app, ...fields }) => fields),
      success: WorkflowRun,
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", `${path}/:run`, {
      params: WorkflowTarget.fields,
      success: WorkflowRun,
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("pinned", `${path}/:run/pinned`, {
      params: WorkflowTarget.fields,
      query: { owner: Schema.optional(OwnerId) },
      success: PinnedWorkflowRun,
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("list", path, {
      params: { app: AppId },
      query: ListWorkflowRuns.mapFields(({ app: _app, ...fields }) => fields),
      success: WorkflowRunPage,
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("terminate", `${path}/:run/terminate`, {
      params: WorkflowTarget.fields,
      success: WorkflowRun,
      error: WorkflowErrors,
    }),
  );
