import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import { VersionId, OwnerId } from "./shared.ts";
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
import {
  AppAccounts,
  AppAccountsQuery,
  AppNotDeployed,
  AppNotFound,
  AccountRequired,
  AccountChoiceUnsupported,
  AccountSelectionInvalid,
} from "./apps.ts";
import { AccountNotFound } from "./account.ts";
import { VersionNotFound } from "./version.ts";
import { OAuthReconnectRequired, OAuthRenewalFailed } from "./oauth.ts";
import { AppEvaluationFailed, AppProviderFailed } from "./tools.ts";

export { HostedWorkflow, WorkflowRun, WorkflowRunId, WorkflowRunPage, WorkflowFailure };
/**
 * Start keys deduplicate retries within one configured app and actor. The run keeps the accounts it
 * starts with and the current actor, whose access its later steps are checked against.
 */
export const StartWorkflowFields = Schema.Struct({
  app: AppId,
  accounts: Schema.optional(AppAccounts),
  version: Schema.optional(VersionId),
  workflow: WorkflowName,
  input: WorkflowValue,
  key: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(128))),
});
export const StartWorkflow = StartWorkflowFields.pipe(withLegacyKeys({ version: "deployment" }));
/** Runs are addressed within their configured app, never globally by ID alone. */
export const WorkflowTarget = Schema.Struct({ app: AppId, run: WorkflowRunId });
/**
 * What a retained run pinned when it started: its actor and the accounts it may use, by the scope
 * each requirement had on the run's pinned version. A run started without a caller names no
 * `user`.
 */
export const PinnedWorkflowRun = Schema.Struct({
  accounts: AppAccounts,
  actor: Schema.NullOr(Schema.NonEmptyString),
});
export type PinnedWorkflowRun = typeof PinnedWorkflowRun.Type;
/** Bounded definition and history reads preserve product-owned authorization. */
const WorkflowAppFields = Schema.Struct({
  app: AppId,
  accounts: Schema.optional(AppAccounts),
  version: Schema.optional(VersionId),
});
export const WorkflowApp = WorkflowAppFields.pipe(withLegacyKeys({ version: "deployment" }));
export const ListWorkflowRuns = Schema.Struct({
  app: AppId,
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
  StorageError,
  CredentialsError,
  RequestInvalid,
  AppNotFound,
  AppNotDeployed,
  AccountNotFound,
  AccountRequired,
  AccountChoiceUnsupported,
  AccountSelectionInvalid,
  VersionNotFound,
  OAuthReconnectRequired,
  OAuthRenewalFailed,
  WorkflowFailure,
] as const;
/**
 * Listing an app's workflows evaluates the app's definition, so it fails as listing its tools or
 * skills does: with the app's own evaluation error or a service's refusal, attributed to the app.
 */
export const WorkflowDefinitionErrors = [
  ...WorkflowErrors,
  AppEvaluationFailed,
  AppProviderFailed,
] as const;

const path = "/v1/apps/:app/workflow-runs";
/** Flat transport groups are projected beneath executor.apps in the public SDK. */
export const AppWorkflowsGroup = HttpApiGroup.make("appWorkflows").add(
  HttpApiEndpoint.get("list", "/v1/apps/:app/workflows", {
    params: { app: AppId },
    query: Schema.Struct({ accounts: AppAccountsQuery, version: Schema.optional(VersionId) }).pipe(
      withLegacyKeys({ version: "deployment" }),
    ),
    success: Schema.Array(HostedWorkflow),
    error: WorkflowDefinitionErrors,
  }),
);
/** Lifecycle operations start quickly and return a retained run identity. */
export const AppWorkflowRunsGroup = HttpApiGroup.make("appWorkflowRuns")
  .add(
    HttpApiEndpoint.post("start", path, {
      params: { app: AppId },
      payload: StartWorkflowFields.mapFields(({ app: _app, ...fields }) => fields).pipe(
        withLegacyKeys({ version: "deployment" }),
      ),
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
