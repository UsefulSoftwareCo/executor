import { ProfileHost } from "../contracts/profiles.ts";
import { makeProfileSetup } from "./profile-setup.ts";
import { WorkflowHost } from "../contracts/workflow-runtime.ts";
import { RepositoryHost } from "../contracts/source.ts";
import { StorageHost } from "../contracts/storage.ts";
import { gitSourceStorage } from "./git-sources.ts";
import { makeRegistry } from "./registry.ts";
import { remoteRegistry } from "./remote-registry.ts";
import { aesGcmCredentials } from "./credentials.ts";
import { hostedExecutorOrigin } from "../contracts/registry.ts";
import { defaultToolListingPolicy } from "../contracts/declarations.ts";
import { storedApp } from "./apps.ts";
import { initializeAppRepository, recoverAppRepositories } from "./initial-source.ts";
import { makeWorkflowRuns } from "./workflows.ts";
/** Compose native operations once for in-process and HTTP callers. */
import { Crypto, Effect } from "effect";
import type { Executor, ExecutorOptions, RemoteExecutorOptions } from "../contracts/executor.ts";
import { AppId, CredentialsError, NotImplemented, StorageError } from "../contracts/shared.ts";
import { makeWebhooks } from "./webhooks.ts";
import { makeAppData } from "./app-storage.ts";
import { makeAccountConnections } from "./account-connections.ts";
import { makeAccounts } from "./accounts.ts";
import { makeAccountHealth } from "./account-health.ts";
import { makeProfiles } from "./profiles.ts";
import { makeApps } from "./apps.ts";
import { makeOwners } from "./owners.ts";
import { makeSchedules } from "./schedules.ts";
import { makeTools } from "./tools.ts";
import { makeSkills } from "./skills.ts";
import { toEffectRuntime } from "./runtime.ts";
import { database } from "./database.ts";
import { makeOAuth } from "./oauth.ts";
import { makeDeclarationCache, makeDeclarations } from "./declarations.ts";
import { makeListings } from "./listings.ts";
import { makeEvents } from "./events.ts";
import { AppEventSink, RuntimeProtocolFailed, type Runtime } from "../contracts/runtime.ts";

/** Capture host cryptography; caller owns database and platform resource lifetimes. */
export const createExecutor = (
  options: ExecutorOptions,
): Effect.Effect<Executor, CredentialsError, Crypto.Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const credentials =
      options.credentials ?? (yield* aesGcmCredentials(options.secret, globalThis.crypto));
    const db = database(options.database);
    const sources = gitSourceStorage(options.git);
    const origin = options.origin ?? hostedExecutorOrigin;
    const catalog = makeRegistry(
      options.registry ?? remoteRegistry(hostedExecutorOrigin),
      origin,
      db,
      sources,
      options.blobs,
    );
    const toolListings = { ...defaultToolListingPolicy, ...options.cache?.toolListings };
    const cache = options.cache?.memory ?? makeDeclarationCache();
    const events = makeEvents({
      db,
      credentials,
      options: options.events,
      background: options.background,
    });
    // Every invocation reports the events it emitted here, whichever operation started it.
    const sink: typeof AppEventSink.Service = {
      emitted: (input) =>
        events
          .record({ app: AppId.make(input.app), accounts: input.accounts, events: input.events })
          .pipe(
            Effect.tapError(() => Effect.logError("Emitted app events could not be saved")),
            Effect.mapError(() => new RuntimeProtocolFailed({ reason: "data" })),
          ),
    };
    const base = toEffectRuntime(options.runtime, options.blobs, cache);
    const runtime: Runtime = {
      ...base,
      call: (input) => base.call(input).pipe(Effect.provideService(AppEventSink, sink)),
      mutate: (input) => base.mutate(input).pipe(Effect.provideService(AppEventSink, sink)),
      webhook: (input) => base.webhook(input).pipe(Effect.provideService(AppEventSink, sink)),
    };
    // The operator's own OAuth clients, by ID; their tokens are managed.
    const firstPartyClients = new Map(
      (options.oauth?.firstPartyClients ?? []).map((client) => [client.id, client] as const),
    );
    const oauth = makeOAuth(
      db,
      credentials,
      crypto,
      options.oauth,
      options.hooks,
      options.background,
    );
    const declarations = makeDeclarations({
      cache,
      durable: options.cache?.durable,
      background: options.background,
      resolveAccount: oauth.resolveSelected,
      accountUsable: oauth.usable,
      crypto,
      lifecycle: options.hooks,
    });
    const workflows = makeWorkflowRuns(
      options.database,
      runtime,
      oauth.resolveSelected,
      credentials,
      crypto,
      declarations,
      options.workflows,
      options.hooks,
    );
    const webhooks = makeWebhooks(
      options.database,
      runtime,
      oauth.resolveSelected,
      credentials,
      crypto,
      options.webhookOrigin ?? options.origin,
      declarations,
      workflows.controls,
      options.hooks,
    );
    const apps = {
      ...makeApps(
        db,
        runtime,
        crypto,
        sources,
        options.git,
        catalog.reads,
        options.blobs,
        options.hooks,
      ),
      profiles: makeProfiles(db, crypto),
      workflows: { list: workflows.definitions },
      workflowRuns: workflows.runs,
    };
    const tools = makeTools(
      options.database,
      oauth,
      firstPartyClients,
      runtime,
      credentials,
      crypto,
      makeListings({
        cache,
        background: options.background,
        declarations,
        resolveAccount: oauth.resolveSelected,
        lifecycle: options.hooks,
        policy: toolListings,
      }),
      workflows.controls,
      options.hooks,
    );
    const connections = makeAccountConnections(db, credentials, crypto, options.hooks);
    const { checkCredentials, ...accountHealth } = makeAccountHealth(
      db,
      runtime,
      oauth,
      firstPartyClients,
      apps.list,
    );
    const schedules = makeSchedules(options.database, apps, tools, credentials, crypto);
    const setup = makeProfileSetup(db, crypto, apps.profiles, {
      webhooks: webhooks.webhooks,
      webhookDefinitions: webhooks.liveDefinitions,
      schedules: schedules.operations,
      reconcileSchedules: schedules.reconcile,
      runs: workflows.runs,
      accountNeedingReconnect: tools.accountNeedingReconnect,
    });
    // App source defines schedules. Each activation removes saved settings for schedules the new
    // deployment no longer declares. The activation has committed, so a deployment that cannot be
    // evaluated keeps them and the activation still succeeds. Profiles reconcile in setup.
    const activated = (app: AppId) =>
      schedules
        .activated(app)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "Kept saved schedules: the activated deployment was not evaluated",
              error,
            ),
          ),
        );
    return {
      [ProfileHost]: { tick: setup.tick },
      [WorkflowHost]: workflows.host,
      [RepositoryHost]: {
        request: (input, request) =>
          Effect.gen(function* () {
            const app = yield* storedApp(db, input);
            yield* initializeAppRepository(db, sources, options.blobs, app);
            return yield* options.git.request(app.code, request);
          }),
        recover: recoverAppRepositories({
          database: options.database,
          sources,
          blobs: options.blobs,
        }),
      },
      [StorageHost]: {
        transaction: (effect) =>
          db.transaction(effect).pipe(
            Effect.withSpan("storage.transaction"),
            Effect.catchTag("SqlError", () => new StorageError()),
          ),
      },
      scheduler: schedules.dispatcher,
      events,
      schedules: schedules.operations,
      accounts: {
        ...makeAccounts(db, credentials, crypto, options.hooks, oauth.revokeRemoved),
        ...accountHealth,
      },
      accountConnections: {
        ...connections,
        ...oauth.connections,
        findOAuth: (input) =>
          Effect.flatMap(oauth.findOAuth(input), ({ redirectUri, ...found }) =>
            Effect.map(connections.get(found), (connection) => ({ ...connection, redirectUri })),
          ),
      },
      apps: {
        ...apps,
        deploy: (input) =>
          apps
            .deploy(input)
            .pipe(
              Effect.tap(({ app, deployment }) =>
                app.activeDeployment === deployment.id ? activated(app.id) : Effect.void,
              ),
            ),
        activate: (input) => apps.activate(input).pipe(Effect.tap((app) => activated(app.id))),
        profiles: setup.operations,
        checkCredentials,
      },
      owners: makeOwners(db),
      publications: catalog.publications,
      registry: catalog.registry,
      skills: makeSkills(db, runtime, crypto, declarations, options.blobs),
      webhooks: webhooks.webhooks,
      webhookSetup: webhooks.webhookSetup,
      appData: makeAppData(
        options.database,
        oauth.resolveSelected,
        runtime,
        workflows.controls,
        options.hooks,
      ),
      tools,
    };
  });

/** Remote transport is not implemented yet; it will expose the same native contract. */
export const createRemoteExecutor = (
  _options: RemoteExecutorOptions,
): Effect.Effect<Executor, NotImplemented> =>
  Effect.fail(new NotImplemented({ operation: "createRemoteExecutor" }));
