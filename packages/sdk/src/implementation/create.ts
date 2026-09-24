import { ProfileHost } from "../contracts/profiles.ts";
import { makeProfileSetup } from "./profile-setup.ts";
import { WorkflowHost } from "../contracts/workflow-runtime.ts";
import { makeWorkflowRuns } from "./workflows.ts";
/** Compose native operations once for in-process and HTTP callers. */
import { Crypto, Effect } from "effect";
import type { Executor, ExecutorOptions, RemoteExecutorOptions } from "../contracts/executor.ts";
import { NotImplemented } from "../contracts/shared.ts";
import { makeWebhooks } from "./webhooks.ts";
import { makeAppData } from "./app-storage.ts";
import { makeAccountConnections } from "./account-connections.ts";
import { makeAccounts } from "./accounts.ts";
import { makeProfiles } from "./profiles.ts";
import { makeApps } from "./apps.ts";
import { makeOwners } from "./owners.ts";
import { makeSchedules } from "./schedules.ts";
import { makeTools } from "./tools.ts";
import { makeSkills } from "./skills.ts";
import { toEffectRuntime } from "./runtime.ts";
import { database } from "./database.ts";
import { makeOAuth } from "./oauth.ts";

/** Capture host cryptography; caller owns database and platform resource lifetimes. */
export const createExecutor = (
  options: ExecutorOptions,
): Effect.Effect<Executor, never, Crypto.Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const db = database(options.storage);
    const runtime = toEffectRuntime(options.runtime, options.blobs);
    const oauth = makeOAuth(db, options.credentials, crypto, options.oauth, options.lifecycle);
    const workflows = makeWorkflowRuns(
      options.storage,
      runtime,
      oauth.resolve,
      options.credentials,
      crypto,
      options.workflows,
      options.appStorage,
      options.lifecycle,
    );
    const webhooks = makeWebhooks(
      options.storage,
      runtime,
      oauth.resolve,
      options.credentials,
      crypto,
      options.webhookOrigin,
      options.appStorage,
      workflows.controls,
      options.lifecycle,
    );
    const apps = {
      ...makeApps(db, runtime, crypto, options.sources, options.blobs, options.lifecycle),
      profiles: makeProfiles(db, crypto),
      workflows: { list: workflows.definitions },
      workflowRuns: workflows.runs,
    };
    const tools = makeTools(
      options.storage,
      oauth.resolve,
      runtime,
      options.credentials,
      crypto,
      options.appStorage,
      workflows.controls,
      options.lifecycle,
    );
    const schedules = makeSchedules(options.storage, apps, tools, options.credentials, crypto);
    const setup = makeProfileSetup(db, crypto, apps.profiles, {
      webhooks: webhooks.webhooks,
      schedules: schedules.operations,
      runs: workflows.runs,
    });
    return {
      [ProfileHost]: { tick: setup.tick },
      [WorkflowHost]: workflows.host,
      scheduler: schedules.dispatcher,
      schedules: schedules.operations,
      accounts: makeAccounts(db, options.credentials, crypto, options.lifecycle),
      accountConnections: {
        ...makeAccountConnections(db, options.credentials, crypto, options.lifecycle),
        ...oauth.connections,
      },
      apps: { ...apps, profiles: setup.operations },
      owners: makeOwners(db),
      skills: makeSkills(apps, db, runtime, oauth.resolve, crypto, options.lifecycle),
      ...webhooks,
      appData: makeAppData(
        options.storage,
        oauth.resolve,
        runtime,
        options.appStorage,
        workflows.controls,
        options.lifecycle,
      ),
      tools,
    };
  });

/** Remote transport is not implemented yet; it will expose the same native contract. */
export const createRemoteExecutor = (
  _options: RemoteExecutorOptions,
): Effect.Effect<Executor, NotImplemented> =>
  Effect.fail(new NotImplemented({ operation: "createRemoteExecutor" }));
