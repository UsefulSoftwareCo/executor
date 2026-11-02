import {
  WorkflowInputTarget,
  AnswerWorkflowInput,
  ListWorkflowInputs,
  UpdateWorkflowInputEvidence,
} from "../contracts/workflow-inputs.ts";
import { CheckOAuthSetup } from "../contracts/oauth.ts";
import { OAuthClientInputs } from "../contracts/oauth-clients.ts";
import {
  StartWorkflow,
  WorkflowTarget,
  WorkflowApp,
  ListWorkflowRuns,
} from "../contracts/workflows.ts";
import { CompleteWebhookSetup } from "../contracts/webhook-setup.ts";
/** Promise facade parses plain inputs before calling native operations. */
import {
  CreateWebhook,
  DeliverWebhook,
  LinkWebhookSource,
  UpdateWebhookSource,
  UnlinkWebhookSource,
  WebhookApp,
  WebhookDefinitionsInput,
  WebhookTarget,
} from "../contracts/webhooks.ts";
import { Effect, Schema, Stream } from "effect";
import type { Executor, PromiseExecutor } from "../contracts/executor.ts";
import { AccountInputs } from "../contracts/account.ts";
import {
  CreateAccountConnection,
  GetAccountConnection,
  SubmitAccountConnection,
  StartConnectionOAuth,
  CompleteConnectionOAuth,
  FindConnectionOAuth,
} from "../contracts/account-connection.ts";
import { ScheduleInputs } from "../contracts/schedules.ts";
import { AppInputs } from "../contracts/apps.ts";
import { OwnerInputs } from "../contracts/owner.ts";
import { PublicationInputs, RegistryInputs } from "../contracts/registry.ts";
import { ElicitationFailed, ToolInputs, type ToolInvocationOptions } from "../contracts/tools.ts";
import { OwnerId, RequestInvalid } from "../contracts/shared.ts";
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
): ToolInvocationOptions => {
  const deliver = options?.elicitation;
  return {
    ...(deliver === undefined
      ? {}
      : {
          elicitation: (request, signal) =>
            Effect.tryPromise({
              try: () => deliver(request, signal),
              catch: () => new ElicitationFailed({ reason: "transport" }),
            }),
        }),
    ...(options?.issuer === undefined ? {} : { issuer: options.issuer }),
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
      copy: (input) => run(ScheduleInputs.copy, input, executor.schedules.copy),
      update: (input) => run(ScheduleInputs.update, input, executor.schedules.update),
      runNow: (input) => run(ScheduleInputs.runNow, input, executor.schedules.runNow),
      remove: (input) => run(ScheduleInputs.remove, input, executor.schedules.remove),
      runs: (input = {}) => run(ScheduleInputs.runs, input, executor.schedules.runs),
      approval: (input) => run(ScheduleInputs.approval, input, executor.schedules.approval),
      answer: (input) => run(ScheduleInputs.answer, input, executor.schedules.answer),
    },
    accounts: {
      get: (input) => run(AccountInputs.get, input, executor.accounts.get),
      provider: (input) => run(AccountInputs.get, input, executor.accounts.provider),
      list: (input) => run(AccountInputs.list, input, executor.accounts.list),
      update: (input) => run(AccountInputs.update, input, executor.accounts.update),
      remove: (input) => run(AccountInputs.get, input, executor.accounts.remove),
      signIn: (input) => run(AccountInputs.get, input, executor.accounts.signIn),
      providers: (input) => run(AccountInputs.providers, input, executor.accounts.providers),
      health: (input) => run(AccountInputs.health, input, executor.accounts.health),
      revocation: (input) => run(AccountInputs.get, input, executor.accounts.revocation),
      listHealth: (input) => run(AccountInputs.listHealth, input, executor.accounts.listHealth),
      check: (input) => run(AccountInputs.check, input, executor.accounts.check),
    },
    accountConnections: {
      oauthSetup: (input) => run(CheckOAuthSetup, input, executor.accountConnections.oauthSetup),
      create: (input) => run(CreateAccountConnection, input, executor.accountConnections.create),
      get: (input) => run(GetAccountConnection, input, executor.accountConnections.get),
      cancel: (input) => run(GetAccountConnection, input, executor.accountConnections.cancel),
      submit: (input) => run(SubmitAccountConnection, input, executor.accountConnections.submit),
      startOAuth: (input) =>
        run(StartConnectionOAuth, input, executor.accountConnections.startOAuth),
      findOAuth: (input) => run(FindConnectionOAuth, input, executor.accountConnections.findOAuth),
      completeOAuth: (input) =>
        run(CompleteConnectionOAuth, input, executor.accountConnections.completeOAuth),
    },
    oauthClients: {
      register: (input) => run(OAuthClientInputs.register, input, executor.oauthClients.register),
      list: (input) => run(OAuthClientInputs.list, input, executor.oauthClients.list),
      issuers: (input) => run(OAuthClientInputs.issuers, input, executor.oauthClients.issuers),
      get: (input) => run(OAuthClientInputs.get, input, executor.oauthClients.get),
      update: (input) => run(OAuthClientInputs.update, input, executor.oauthClients.update),
      remove: (input) => run(OAuthClientInputs.remove, input, executor.oauthClients.remove),
    },
    owners: {
      check: (input) => run(OwnerInputs.check, input, executor.owners.check),
      remove: (input) => run(OwnerInputs.remove, input, executor.owners.remove),
    },
    workflowInputs: {
      updateEvidence: (input) =>
        run(UpdateWorkflowInputEvidence, input, executor.workflowInputs.updateEvidence),
      get: (input) => run(WorkflowInputTarget, input, executor.workflowInputs.get),
      answer: (input) => run(AnswerWorkflowInput, input, executor.workflowInputs.answer),
      withdraw: (input) => run(WorkflowInputTarget, input, executor.workflowInputs.withdraw),
      list: (input) => run(ListWorkflowInputs, input, executor.workflowInputs.list),
    },
    apps: {
      workflows: { list: (input) => run(WorkflowApp, input, executor.apps.workflows.list) },
      workflowRuns: {
        start: (input) => run(StartWorkflow, input, executor.apps.workflowRuns.start),
        get: (input) => run(WorkflowTarget, input, executor.apps.workflowRuns.get),
        pinned: (input) =>
          run(
            Schema.Struct({ ...WorkflowTarget.fields, owner: Schema.optional(OwnerId) }),
            input,
            executor.apps.workflowRuns.pinned,
          ),
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
      checkCredentials: (input) =>
        run(AppInputs.checkCredentials, input, executor.apps.checkCredentials),
      remove: (input) => run(AppInputs.get, input, executor.apps.remove),
      activate: (input) => run(AppInputs.activate, input, executor.apps.activate),
      rename: (input) => run(AppInputs.rename, input, executor.apps.rename),
      versions: (input) => run(AppInputs.versions, input, executor.apps.versions),
      version: (input) => run(AppInputs.source, input, executor.apps.version),
      source: (input) => run(AppInputs.source, input, executor.apps.source),
      history: (input) => run(AppInputs.history, input, executor.apps.history),
      revision: (input) => run(AppInputs.revision, input, executor.apps.revision),
    },
    publications: {
      status: () => Effect.runPromise(executor.publications.status()),
      preview: (input) => run(PublicationInputs.preview, input, executor.publications.preview),
      publish: (input) => run(PublicationInputs.publish, input, executor.publications.publish),
      owned: (input) => run(PublicationInputs.owned, input, executor.publications.owned),
      unpublish: (input) =>
        run(PublicationInputs.unpublish, input, executor.publications.unpublish),
    },
    registry: {
      list: (input = {}) => run(RegistryInputs.list, input, executor.registry.list),
      snapshot: (input) => run(RegistryInputs.snapshot, input, executor.registry.snapshot),
      file: (input) => run(RegistryInputs.file, input, executor.registry.file),
    },
    webhookSetup: {
      read: (input) => run(WebhookTarget, input, executor.webhookSetup.read),
      complete: (input) => run(CompleteWebhookSetup, input, executor.webhookSetup.complete),
    },
    webhooks: {
      get: (input) => run(WebhookTarget, input, executor.webhooks.get),
      confirmRemoval: (input) => run(WebhookTarget, input, executor.webhooks.confirmRemoval),
      definitions: (input) => run(WebhookDefinitionsInput, input, executor.webhooks.definitions),
      list: (input) => run(WebhookApp, input, executor.webhooks.list),
      create: (input) => run(CreateWebhook, input, executor.webhooks.create),
      reconcile: (input) => run(WebhookTarget, input, executor.webhooks.reconcile),
      remove: (input) => run(WebhookTarget, input, executor.webhooks.remove),
      deliver: (input) => run(DeliverWebhook, input, executor.webhooks.deliver),
      sources: (input) => run(WebhookApp, input, executor.webhooks.sources),
      link: (input) => run(LinkWebhookSource, input, executor.webhooks.link),
      configureSource: (input) =>
        run(UpdateWebhookSource, input, executor.webhooks.configureSource),
      unlink: (input) => run(UnlinkWebhookSource, input, executor.webhooks.unlink),
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
      index: (input) => run(Schema.toType(ToolInputs.index), input, executor.tools.index),
      get: (input) => run(Schema.toType(ToolInputs.get), input, executor.tools.get),
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
