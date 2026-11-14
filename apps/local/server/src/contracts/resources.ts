/** Paired-dashboard access to workflow history and webhook lifecycle metadata. */
import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import {
  AccountId,
  AppId,
  VersionId,
  WorkflowRunId,
  HostedWorkflow,
  WorkflowRun,
  WorkflowRunPage,
  StartWorkflowFields,
  ListWorkflowRuns,
  WorkflowErrors,
  WorkflowDefinitionErrors,
  WebhookSubscription,
  WebhookErrors,
  WebhookId,
  WebhookSource,
  ConfigureWebhookSource,
  WebhookSourceSummary,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
const app = { app: AppId };
const path = "/dashboard/api/apps/:app";
/**
 * The paired browser has the same workflow capabilities as the local SDK. Runs use the accounts
 * linked to the app.
 */
export const DashboardWorkflows = HttpApiGroup.make("workflows")
  .add(
    HttpApiEndpoint.get("definitions", `${path}/workflows`, {
      params: app,
      query: Schema.Struct({ version: Schema.optional(VersionId) }).pipe(
        withLegacyKeys({ version: "deployment" }),
      ),
      success: Schema.Array(HostedWorkflow),
      error: WorkflowDefinitionErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("start", `${path}/workflow-runs`, {
      params: app,
      payload: StartWorkflowFields.mapFields(
        ({ app: _app, accounts: _accounts, ...fields }) => fields,
      ).pipe(withLegacyKeys({ version: "deployment" })),
      success: WorkflowRun,
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("list", `${path}/workflow-runs`, {
      params: app,
      query: ListWorkflowRuns.mapFields(({ app: _app, ...fields }) => fields),
      success: WorkflowRunPage,
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("terminate", `${path}/workflow-runs/:run/terminate`, {
      params: { ...app, run: WorkflowRunId },
      success: WorkflowRun,
      error: WorkflowErrors,
    }),
  );
/** Setup secrets remain behind the existing browser-only webhook setup route. */
export const DashboardWebhooks = HttpApiGroup.make("webhooks")
  .add(
    HttpApiEndpoint.get("list", `${path}/webhooks`, {
      params: app,
      success: Schema.Array(WebhookSubscription),
      error: WebhookErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("reconcile", `${path}/webhooks/:subscription/reconcile`, {
      params: { ...app, subscription: WebhookId },
      success: WebhookSubscription,
      error: WebhookErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("sources", `${path}/webhook-sources`, {
      params: app,
      success: Schema.Array(WebhookSourceSummary),
      error: WebhookErrors,
    }),
  )
  .add(
    HttpApiEndpoint.put("configureSource", `${path}/webhook-sources/:account/config`, {
      params: { ...app, account: AccountId },
      payload: ConfigureWebhookSource,
      success: WebhookSource,
      error: WebhookErrors,
    }),
  );
