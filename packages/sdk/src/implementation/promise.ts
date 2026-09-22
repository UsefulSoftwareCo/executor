import { CheckOAuthSetup } from "../contracts/oauth.ts";
import { ProfileInputs } from "../contracts/profiles.ts";
import {
  StartWorkflow,
  WorkflowTarget,
  WorkflowApp,
  ListWorkflowRuns,
} from "../contracts/workflows.ts";
import { CompleteWebhookSetup } from "../contracts/webhook-setup.ts";
/** Promise facade parses plain inputs before calling native operations. */
import { CreateWebhook, WebhookApp, WebhookTarget, DeliverWebhook } from "../contracts/webhooks.ts";
import { Effect, Schema, Stream } from "effect";
import type { Executor, PromiseExecutor } from "../contracts/executor.ts";
import { AccountInputs } from "../contracts/account.ts";
import {
  CreateAccountConnection,
  GetAccountConnection,
  SubmitAccountConnection,
  StartConnectionOAuth,
  CompleteConnectionOAuth,
} from "../contracts/account-connection.ts";
import { ScheduleInputs } from "../contracts/schedules.ts";
import { AppInputs } from "../contracts/apps.ts";
import { OwnerInputs } from "../contracts/owner.ts";
import { ElicitationFailed, ToolInputs, type ToolInvocationOptions } from "../contracts/tools.ts";
import { RequestInvalid } from "../contracts/shared.ts";
import { AppDataInput } from "../contracts/app-data.ts";
import { AppSkillInputs } from "../contracts/skills.ts";

function run<A, B, E>(
  schema: Schema.Decoder<A>,
  input: unknown,
  operation: (value: A) => Effect.Effect<B, E>,
) {
  return Effect.runPromise(
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError(() => new RequestInvalid()),
      Effect.flatMap(operation),
    ),
  );
}

const invocationOptions = (
  options: Parameters<PromiseExecutor["tools"]["call"]>[1],
): ToolInvocationOptions | undefined => {
  const deliver = options?.elicitation;
  return deliver === undefined
    ? undefined
    : {
        elicitation: (request, signal) =>
          Effect.tryPromise({
            try: () => deliver(request, signal),
            catch: () => new ElicitationFailed({ reason: "transport" }),
          }),
      };
};

/** Adapt an existing native client; each Promise call runs one decoded operation. */
export const promiseExecutor = (executor: Executor): PromiseExecutor => {
  return {
    skills: {
      bundle: (input) => run(AppSkillInputs.list, input, executor.skills.bundle),
      list: (input) => run(AppSkillInputs.list, input, executor.skills.list),
      read: (input) => run(AppSkillInputs.read, input, executor.skills.read),
    },
    schedules: {
      definitions: (input) =>
        run(ScheduleInputs.definitions, input, executor.schedules.definitions),
      list: (input) => run(ScheduleInputs.list, input, executor.schedules.list),
      configure: (input) => run(ScheduleInputs.configure, input, executor.schedules.configure),
      runNow: (input) => run(ScheduleInputs.runNow, input, executor.schedules.runNow),
      runs: (input = {}) => run(ScheduleInputs.runs, input, executor.schedules.runs),
      approval: (input) => run(ScheduleInputs.approval, input, executor.schedules.approval),
      answer: (input) => run(ScheduleInputs.answer, input, executor.schedules.answer),
    },
    accounts: {
      add: (input) => run(AccountInputs.add, input, executor.accounts.add),
      get: (input) => run(AccountInputs.get, input, executor.accounts.get),
      provider: (input) => run(AccountInputs.get, input, executor.accounts.provider),
      list: (input = {}) => run(AccountInputs.list, input, executor.accounts.list),
      update: (input) => run(AccountInputs.update, input, executor.accounts.update),
      replaceCredentials: (input) =>
        run(AccountInputs.replaceCredentials, input, executor.accounts.replaceCredentials),
      remove: (input) => run(AccountInputs.get, input, executor.accounts.remove),
    },
    accountConnections: {
      oauthSetup: (input) => run(CheckOAuthSetup, input, executor.accountConnections.oauthSetup),
      create: (input) => run(CreateAccountConnection, input, executor.accountConnections.create),
      get: (input) => run(GetAccountConnection, input, executor.accountConnections.get),
      cancel: (input) => run(GetAccountConnection, input, executor.accountConnections.cancel),
      submit: (input) => run(SubmitAccountConnection, input, executor.accountConnections.submit),
      startOAuth: (input) =>
        run(StartConnectionOAuth, input, executor.accountConnections.startOAuth),
      completeOAuth: (input) =>
        run(CompleteConnectionOAuth, input, executor.accountConnections.completeOAuth),
    },
    owners: {
      check: (input) => run(OwnerInputs.check, input, executor.owners.check),
      remove: (input) => run(OwnerInputs.remove, input, executor.owners.remove),
    },
    apps: {
      profiles: {
        create: (input) => run(ProfileInputs.create, input, executor.apps.profiles.create),
        get: (input) => run(ProfileInputs.get, input, executor.apps.profiles.get),
        list: (input) => run(ProfileInputs.list, input, executor.apps.profiles.list),
        update: (input) => run(ProfileInputs.update, input, executor.apps.profiles.update),
        setEnabled: (input) =>
          run(ProfileInputs.setEnabled, input, executor.apps.profiles.setEnabled),
        reconcile: (input) => run(ProfileInputs.reconcile, input, executor.apps.profiles.reconcile),
        remove: (input) => run(ProfileInputs.remove, input, executor.apps.profiles.remove),
      },
      workflows: { list: (input) => run(WorkflowApp, input, executor.apps.workflows.list) },
      workflowRuns: {
        start: (input) => run(StartWorkflow, input, executor.apps.workflowRuns.start),
        get: (input) => run(WorkflowTarget, input, executor.apps.workflowRuns.get),
        list: (input) =>
          run(Schema.toType(ListWorkflowRuns), input, executor.apps.workflowRuns.list),
        terminate: (input) => run(WorkflowTarget, input, executor.apps.workflowRuns.terminate),
      },
      create: (input) => run(AppInputs.create, input, executor.apps.create),
      workspace: (input) => run(AppInputs.workspace, input, executor.apps.workspace),
      commit: (input) => run(AppInputs.commit, input, executor.apps.commit),
      copy: (input) => run(AppInputs.copy, input, executor.apps.copy),
      deploy: (input) => run(AppInputs.deploy, input, executor.apps.deploy),
      get: (input) => run(AppInputs.get, input, executor.apps.get),
      list: (input = {}) => run(AppInputs.list, input, executor.apps.list),
      update: (input) => run(AppInputs.update, input, executor.apps.update),
      remove: (input) => run(AppInputs.get, input, executor.apps.remove),
      activate: (input) => run(AppInputs.activate, input, executor.apps.activate),
      rename: (input) => run(AppInputs.rename, input, executor.apps.rename),
      deployments: (input) => run(AppInputs.deployments, input, executor.apps.deployments),
      deployment: (input) => run(AppInputs.source, input, executor.apps.deployment),
      source: (input) => run(AppInputs.source, input, executor.apps.source),
    },
    webhookSetup: {
      read: (input) => run(WebhookTarget, input, executor.webhookSetup.read),
      complete: (input) => run(CompleteWebhookSetup, input, executor.webhookSetup.complete),
    },
    webhooks: {
      get: (input) => run(WebhookTarget, input, executor.webhooks.get),
      confirmRemoval: (input) => run(WebhookTarget, input, executor.webhooks.confirmRemoval),
      definitions: (input) => run(WebhookApp, input, executor.webhooks.definitions),
      list: (input) => run(WebhookApp, input, executor.webhooks.list),
      create: (input) => run(CreateWebhook, input, executor.webhooks.create),
      reconcile: (input) => run(WebhookTarget, input, executor.webhooks.reconcile),
      remove: (input) => run(WebhookTarget, input, executor.webhooks.remove),
      deliver: (input) => run(DeliverWebhook, input, executor.webhooks.deliver),
    },
    appData: {
      subscribe: (input) =>
        run(AppDataInput, input, (value) =>
          executor.appData.subscribe(value).pipe(Effect.map(Stream.toAsyncIterable)),
        ),
      query: (input) => run(AppDataInput, input, executor.appData.query),
      mutate: (input) => run(AppDataInput, input, executor.appData.mutate),
    },
    tools: {
      list: (input) => run(Schema.toType(ToolInputs.list), input, executor.tools.list),
      call: (input, options) =>
        run(ToolInputs.call, input, (value) =>
          executor.tools.call(value, invocationOptions(options)),
        ),
      // Native resume rejects excess fields before lookup; do not strip them at this boundary.
      resume: (input, options) =>
        Effect.runPromise(executor.tools.resume(input, invocationOptions(options))),
      pruneApprovals: (input = {}) =>
        run(ToolInputs.pruneApprovals, input, executor.tools.pruneApprovals),
    },
  };
};
