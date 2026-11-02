import { prepareInteractiveCleanup } from "./interactive-cleanup.ts";
import { transaction } from "./database.ts";
import { makeInteractiveRetirement } from "./interactive-retirement.ts";
import { WebhookSourceHost } from "../contracts/webhooks.ts";
import { makeWebhookSources } from "./webhook-sources.ts";
import { WorkflowHost } from "../contracts/workflow-runtime.ts";
import { RepositoryHost } from "../contracts/source.ts";
import { StorageHost } from "../contracts/storage.ts";
import { PrefetchHost } from "../contracts/tools.ts";
import { OAuthGrantImport } from "../contracts/oauth.ts";
import { gitSourceStorage } from "./git-sources.ts";
import { makeRegistry } from "./registry.ts";
import { remoteRegistry } from "./remote-registry.ts";
import { aesGcmCredentials } from "./credentials.ts";
import { hostedExecutorOrigin } from "../contracts/registry.ts";
import { defaultToolListingPolicy } from "../contracts/declarations.ts";
import {
  storedApp,
  checkAppRemoval,
  AppFileReleaseDeferred,
  releaseRemovedAppFiles,
} from "./apps.ts";
import { initializeAppRepository, recoverAppRepositories } from "./initial-source.ts";
import { makeWorkflowRuns } from "./workflows.ts";
/** Compose native operations once for in-process and HTTP callers. */
import { Crypto, Effect } from "effect";
import type { Executor, ExecutorOptions, RemoteExecutorOptions } from "../contracts/executor.ts";
import {
  AppCodeId,
  AppId,
  CredentialsError,
  NotImplemented,
  StorageError,
} from "../contracts/shared.ts";
import { makeWebhooks } from "./webhooks.ts";
import { makeAppData } from "./app-storage.ts";
import { makeInteractiveAccounts } from "./interactive-accounts.ts";
import { InteractiveHost } from "../contracts/interactive-accounts.ts";
import { makeAccountConnections } from "./account-connections.ts";
import {
  credentialsReadable,
  makeAccounts,
  moveImportedAccount,
  storedAccount,
} from "./accounts.ts";
import { makeSavedOAuthClients } from "./saved-oauth-clients.ts";
import { makeOwnerMoves } from "./owner-moves.ts";
import { SavedOAuthClientsHost } from "../contracts/oauth-clients.ts";
import { OwnerMovesHost } from "../contracts/owner.ts";
import { makeAccountHealth } from "./account-health.ts";
import { makeApps } from "./apps.ts";
import { makeOwners } from "./owners.ts";
import { makeSchedules } from "./schedules.ts";
import { makeTools } from "./tools.ts";
import { makeSkills } from "./skills.ts";
import { toEffectRuntime } from "./runtime.ts";
import { validateFields } from "./provider.ts";
import { database } from "./database.ts";
import { makeOAuth } from "./oauth.ts";
import { makeDeclarationCache, makeDeclarations } from "./declarations.ts";
import { makeListings } from "./listings.ts";
import { makeToolSearch } from "./tool-search.ts";
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
      accountsUsable: oauth.usableAll,
      crypto,
      lifecycle: options.hooks,
      hostApi: options.hostApi,
    });
    const workflows = makeWorkflowRuns(
      options.database,
      runtime,
      oauth.resolveSelected,
      credentials,
      crypto,
      declarations,
      options.workflows,
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
      workflows: { list: workflows.definitions },
      workflowRuns: workflows.runs,
    };
    const search = makeToolSearch({ store: options.database.toolSearch, crypto });
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
        policy: toolListings,
        search,
      }),
      workflows.controls,
      options.hooks,
    );
    const interactive = makeInteractiveAccounts(
      db,
      credentials,
      crypto,
      runtime,
      oauth.resolveSelected,
      options.hooks,
      options.hostApi,
    );
    const connections = makeAccountConnections(db, credentials, crypto, options.hooks);
    const { add, replaceCredentials, ...accountOperations } = makeAccounts(
      db,
      credentials,
      crypto,
      options.hooks,
      oauth.revokeRemoved,
    );
    const retirement = makeInteractiveRetirement(
      db,
      crypto,
      interactive.remove,
      accountOperations.remove,
      options.hooks,
    );
    const ownerOperations = makeOwners(db);
    const { checkCredentials, ...accountHealth } = makeAccountHealth(
      db,
      runtime,
      oauth,
      firstPartyClients,
      apps.list,
      options.hostApi,
    );
    const schedules = makeSchedules(
      options.database,
      apps,
      tools,
      credentials,
      crypto,
      options.hooks,
    );
    const webhookSources = makeWebhookSources(db, crypto, options.hooks, {
      webhooks: webhooks.webhooks,
      liveDefinitions: webhooks.liveDefinitions,
      retarget: webhooks.retarget,
      createManaged: webhooks.createManaged,
      removeManaged: webhooks.removeManaged,
      accountNeedingReconnect: tools.accountNeedingReconnect,
    });
    // App source defines schedules. Each activation removes saved settings for schedules the new
    // version no longer declares and retimes those whose timing changed. The activation has
    // committed, so a version that cannot be evaluated keeps them and the activation still
    // succeeds. Webhook sources reconcile in the
    // background.
    const activated = (app: AppId) =>
      schedules
        .activated(app)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "Kept saved schedules: the activated version was not evaluated",
              error,
            ),
          ),
        );
    return {
      [WebhookSourceHost]: { tick: webhookSources.tick },
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
      [OAuthGrantImport]: {
        importOAuthGrant: oauth.importGrant,
        checkOAuthGrant: oauth.checkGrant,
        checkAccountFields: (input) =>
          validateFields(input.provider, input.definition, input.method, input.fields).pipe(
            Effect.asVoid,
          ),
        firstPartyClient: oauth.firstPartyClient,
        credentialsReadable: credentialsReadable(db, credentials),
        moveImportedAccount: moveImportedAccount(db),
        refreshImportedGrant: oauth.refreshImportedGrant,
        // The same removal without the provider-side revocation `accountOperations` makes.
        removeImportedAccount: makeAccounts(db, credentials, crypto, options.hooks).remove,
      },
      [StorageHost]: {
        transaction: (effect) =>
          db.transaction(effect).pipe(
            Effect.withSpan("storage.transaction"),
            Effect.catchTag("SqlError", () => new StorageError()),
          ),
        read: options.database.reactivity.read,
        write: options.database.reactivity.write,
      },
      [PrefetchHost]: { invocation: tools.prefetchInvocation },
      [SavedOAuthClientsHost]: makeSavedOAuthClients(db, credentials, crypto, options.hooks, [
        ...(options.oauth?.savedClientCallbacks ?? []),
        ...(options.oauth?.previousRedirectUris ?? []),
        new URL("/api/oauth/callback", origin).href,
      ]),
      [OwnerMovesHost]: makeOwnerMoves(db, credentials),
      [InteractiveHost]: { ...interactive, ...retirement },
      scheduler: schedules.dispatcher,
      events,
      schedules: schedules.operations,
      accounts: {
        ...accountOperations,
        remove: (input) =>
          Effect.gen(function* () {
            const saved = yield* storedAccount(db, input.account, input.owner).pipe(
              Effect.catchTag("AccountNotFound", () => Effect.succeed(undefined)),
            );
            if (saved === undefined) return yield* accountOperations.remove(input);
            if (
              (yield* interactive.binding({ owner: saved.owner, account: saved.id })) === undefined
            )
              return yield* accountOperations.remove(input);
            return yield* retirement.retire(
              { owner: saved.owner, accounts: [saved.id] },
              Effect.succeed({ account: saved.id }),
            );
          }),
        ...accountHealth,
        revocation: (input) =>
          storedAccount(db, input.account, input.owner).pipe(
            Effect.flatMap((account) => oauth.revocation(account.id)),
            Effect.withSpan("sdk.accounts.revocation"),
          ),
      },
      managedAccounts: { add, replaceCredentials },
      accountConnections: {
        ...connections,
        ...oauth.connections,
        submit: (input) =>
          interactive
            .clearAttempt({ ...input, type: "secrets" })
            .pipe(Effect.andThen(connections.submit(input))),
        startOAuth: (input) =>
          interactive
            .clearAttempt({ ...input, type: "oauth2" })
            .pipe(Effect.andThen(oauth.connections.startOAuth(input))),
        findOAuth: (input) =>
          Effect.flatMap(oauth.findOAuth(input), ({ redirectUri, ...found }) =>
            Effect.map(connections.get(found), (connection) => ({ ...connection, redirectUri })),
          ),
      },
      oauthClients: oauth.clients,
      apps: {
        ...apps,
        remove: (input) =>
          Effect.gen(function* () {
            const app = yield* checkAppRemoval(db, input);
            if (app === undefined) return yield* apps.remove(input);
            const acquired = yield* retirement.acquired({ owner: app.owner, app: app.id });
            const cleanup = yield* prepareInteractiveCleanup(interactive.prepareRemoval, {
              owner: app.owner,
              accounts: acquired,
            });
            const result = yield* transaction(db, () =>
              Effect.gen(function* () {
                const result = yield* apps.remove(input);
                const current = yield* retirement.acquired({ owner: app.owner, app: app.id });
                yield* retirement.discard({ owner: app.owner, accounts: current });
                return result;
              }),
            ).pipe(Effect.provideService(AppFileReleaseDeferred, true));
            yield* cleanup;
            yield* releaseRemovedAppFiles(options.blobs, AppCodeId.make(app.code));
            return result;
          }),
        deploy: (input) =>
          apps
            .deploy(input)
            .pipe(
              Effect.tap(({ app, version }) =>
                app.activeVersion === version.id ? activated(app.id) : Effect.void,
              ),
            ),
        activate: (input) => apps.activate(input).pipe(Effect.tap((app) => activated(app.id))),
        checkCredentials,
      },
      owners: {
        ...ownerOperations,
        remove: (input) =>
          Effect.gen(function* () {
            const acquired = yield* retirement.acquired({ owner: input.owner });
            const cleanup = yield* prepareInteractiveCleanup(interactive.prepareRemoval, {
              owner: input.owner,
              accounts: acquired,
            });
            const result = yield* ownerOperations.remove(input);
            yield* cleanup;
            return result;
          }),
      },
      publications: catalog.publications,
      registry: catalog.registry,
      skills: makeSkills(db, runtime, crypto, declarations, options.blobs),
      webhooks: {
        ...webhooks.webhooks,
        sources: webhookSources.sources,
        link: webhookSources.link,
        configureSource: webhookSources.configureSource,
        unlink: webhookSources.unlink,
      },
      webhookSetup: webhooks.webhookSetup,
      appData: makeAppData(
        options.database,
        oauth.resolveSelected,
        runtime,
        options.hostApi,
        workflows.controls,
      ),
      tools: { ...tools, search: search.page },
    };
  });

/** Remote transport is not implemented yet; it will expose the same native contract. */
export const createRemoteExecutor = (
  _options: RemoteExecutorOptions,
): Effect.Effect<Executor, NotImplemented> =>
  Effect.fail(new NotImplemented({ operation: "createRemoteExecutor" }));
