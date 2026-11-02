import { InteractiveHost } from "./interactive-accounts.ts";
import { WorkflowHost, type WorkflowRuntime } from "./workflow-runtime.ts";
import { WebhookSourceHost, type WebhookSourceDispatcher } from "./webhooks.ts";
/** The shared Executor interface and remote client options; projected from ExecutorApi. */
import { Context, type Effect, type Redacted, type Stream, Schema } from "effect";
import type { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import type { WebhookSetupApi } from "./webhook-setup.ts";
import type { ExecutorApi } from "./http.ts";
import type { LegacyVersionEndpoints } from "./apps.ts";
import { StorageHost, type Credentials } from "./storage.ts";
import { PrefetchHost } from "./tools.ts";
import { SavedOAuthClientsHost } from "./oauth-clients.ts";
import { OwnerMovesHost } from "./owner.ts";
import { OAuthGrantImport } from "./oauth.ts";
import type { ExecutorDatabase } from "../implementation/storage.ts";
import type { AppRuntime } from "../implementation/runtime.ts";
import type { OAuthOptions } from "./oauth.ts";
import type {
  SearchableTools,
  ToolApproval,
  ToolApprovalNotFound,
  ToolInvocationOptions,
  ToolListOptions,
  ToolSearchInput,
  ToolSearchPage,
  ToolSearchUnavailable,
} from "./tools.ts";
import type { AccountScope, App, AppRequirements } from "./apps.ts";
import type { BuildMemoryExceeded, BuildUnanswered, VersionBuildFailed } from "./version.ts";
import type { Account } from "./account.ts";
import type { AccountProvisioned } from "./provider.ts";
import type {
  AccountConnectionRefused,
  AccountConnectionTargetChanged,
} from "./account-connection.ts";
import type {
  AccountConnectionId,
  AccountId,
  AppId,
  ApprovalRequestId,
  OwnerId,
  StorageError,
} from "./shared.ts";
import type { BlobStorage } from "./blobs.ts";
import { RepositoryHost, type RepositoryBackend, type SourceFiles } from "./source.ts";
import type { RegistryOptions } from "./registry.ts";
import type { CatalogReadOptions } from "./declarations.ts";

/**
 * The subject whose access an operation is checked against. Products provide it around the
 * operations a signed-in caller starts; the SDK provides the saved actor around background work:
 * schedules, webhook callbacks and workflow steps. Undefined when the product has no subjects.
 * Never supplied by authored code.
 */
export const CurrentActor = Context.Reference<string | undefined>("executor/CurrentActor", {
  defaultValue: () => undefined,
});

/**
 * An account an app requirement uses: the product authorizes it by the app link of that account to
 * that requirement. Requirement names are unique across scopes.
 */
export interface AppAccountUse {
  readonly requirement: string;
  readonly account: Pick<Account, "id" | "owner">;
}

/** One account linked to one requirement of an app, in either scope. */
export interface AccountLinkRecord {
  readonly requirement: string;
  readonly account: AccountId;
}

/** The connection being completed, with what the product needs to recheck without reading SDK tables. */
export interface AccountConnectionCompletion {
  readonly id: AccountConnectionId;
  readonly owner: OwnerId;
  readonly reconnectAccount: AccountId | null;
  /** The app requirement the connection links its account to. */
  readonly target: { readonly app: AppId; readonly requirement: string };
}
/** Product metadata participates in the resource transaction; hooks must perform no external I/O. */
export interface ResourceLifecycle {
  /**
   * The user links a subject has to an app whose accounts they may still use, oldest link first,
   * each naming its requirement, for background work: each run resolves its actor's accounts here,
   * and a plain requirement uses the newest. Unknown or inaccessible accounts are omitted, never
   * replaced. Called outside resource transactions.
   */
  readonly userLinks: (input: {
    readonly app: AppId;
    readonly subject: string;
  }) => Effect.Effect<ReadonlyArray<AccountLinkRecord>, StorageError>;
  /**
   * The app links of an app, oldest link first per requirement, for background work: each run
   * resolves the app's accounts here, and a plain app requirement uses the newest. Removed accounts
   * are omitted, never replaced. Called outside resource transactions.
   */
  readonly appLinks: (input: {
    readonly app: AppId;
  }) => Effect.Effect<ReadonlyArray<AccountLinkRecord>, StorageError>;
  /**
   * Resolving a webhook source's accounts found that its actor no longer has the source account
   * linked, or can no longer use it. The product links the source again with another subject who
   * links the account and can use it, or unlinks it. Called outside resource transactions; the
   * current resolution continues and fails on the account.
   */
  readonly sourceActorLost: (input: {
    readonly app: AppId;
    readonly account: AccountId;
    readonly actor: string;
  }) => Effect.Effect<void, StorageError>;
  /**
   * Recheck that the `CurrentActor` may still use the app, before its code is evaluated with or
   * without accounts: for the operations a caller starts and for schedules, webhook callbacks and
   * workflow steps, which run as their saved actor. Workflow steps keep their captured accounts.
   * The actor's use of the user accounts the evaluation runs with (`accounts`), as
   * `accountsResolving` checks it, is rechecked in the same call. Each app requirement's account
   * (`appUses`) is authorized by app access instead: the product checks that the account is still
   * linked to the app for that requirement, not that the actor may use it. An account used by both
   * scopes appears in both and must pass both checks; an actor who can use an account does not
   * keep an app link to it. App-scope work, such as an app schedule or an app-account webhook, has
   * no actor and no user accounts. Returns the IDs of the accounts that passed every
   * check asked of them; the SDK refuses the others. Fail to refuse the evaluation. It receives
   * each account's ID and owner only: a tool call may run it beside its account read, with the
   * owner it expects, and uses the result only when the accounts it read match.
   */
  readonly appResolving: (
    app: { readonly id: AppId; readonly owner: OwnerId },
    accounts: readonly Pick<Account, "id" | "owner">[],
    appUses: readonly AppAccountUse[],
  ) => Effect.Effect<ReadonlySet<AccountId>, StorageError>;
  /**
   * Recheck authority to remove what an app registered upstream, such as a webhook registration,
   * with the accounts it registered with, before acquiring their credentials and again after any
   * renewal. App access is not needed. The user accounts (`accounts`) are checked as
   * `accountsResolving` checks them for the `CurrentActor`, the actor the registration ran as.
   * Each app requirement's account (`appUses`) is authorized by the app having linked it, not by a
   * current app link: unlinking an account is what removes the app's registrations with it, so the
   * product permits an app account the app may have linked, such as one of the app owner's
   * accounts, and refuses one it could not have, such as an account another owner now holds. An
   * app-account registration has no actor and no user accounts. Returns the IDs of the accounts
   * that passed every check asked of them; the SDK refuses the others, and a refused registration
   * waits for a person to remove it at the provider.
   */
  readonly removalResolving: (
    app: { readonly id: AppId; readonly owner: OwnerId },
    accounts: readonly Pick<Account, "id" | "owner">[],
    appUses: readonly AppAccountUse[],
  ) => Effect.Effect<ReadonlySet<AccountId>, StorageError>;
  /**
   * Recheck product authority for the `CurrentActor` before acquiring account credentials without
   * running the app's code or removing what it registered, such as checking an account, and again
   * after any renewal. Returns the IDs of the accounts the product still authorizes; the SDK
   * refuses the others.
   */
  readonly accountsResolving: (
    accounts: readonly [Account, ...Account[]],
  ) => Effect.Effect<ReadonlySet<AccountId>, StorageError>;
  /**
   * Recheck a saved connection after external authentication, before committing its result. Fail
   * with `AccountConnectionRefused` when the completing subject may no longer complete it, such as
   * reconnecting an account they no longer manage; it rolls back the account save.
   */
  readonly connectionCompleting: (
    connection: AccountConnectionCompletion,
  ) => Effect.Effect<void, StorageError | AccountConnectionRefused>;
  /** External retirement wraps account persistence without holding its SQL transaction open. */
  readonly connectionSaving?: <A, E, R>(
    connection: AccountConnectionId,
    save: Effect.Effect<A, E, R>,
  ) => Effect.Effect<
    A,
    | E
    | StorageError
    | AccountConnectionTargetChanged
    | import("./interactive-errors.ts").InteractiveRetirementBusy
    | import("./interactive-errors.ts").InteractiveRetirementFailed,
    R
  >;
  /** Product deletion authority, checked before an external remove call. No writes. */
  readonly accountRetiring?: (account: Account) => Effect.Effect<void, StorageError>;
  /**
   * Host-only deployment guard, in each short reservation/persistence transaction. The final
   * check runs after compilation and before saving or promoting the app; no external I/O.
   */
  readonly appDeploying?: (owner: OwnerId) => Effect.Effect<void, StorageError>;
  /** Called once after inserting a new configured app, before its transaction commits. */
  readonly appCreated: (app: App) => Effect.Effect<void, StorageError>;
  /** Called after active-work checks, before deleting the app in the same transaction. */
  readonly appRemoving: (app: AppId) => Effect.Effect<void, StorageError>;
  /**
   * Called when a connection started for an app requirement saves its account, in the same
   * transaction, so the product can link the account to the requirement in its `scope`: for the
   * connecting subject for a user requirement, for the app for an app requirement. It runs under
   * the app's lock, after the SDK checked that the active version still gives the requirement
   * the `scope` the connection was started for: `connectionCompleting` ran before the lock, so a
   * product that authorizes by scope checks its own record of the `connection` here. Fail with
   * `AccountConnectionTargetChanged` when the connection was started for another scope, and with
   * `AccountConnectionRefused` when the completing subject may not connect the account for the
   * requirement; either rolls back the account save.
   */
  readonly appAccountConnected: (input: {
    readonly connection: AccountConnectionId;
    readonly app: AppId;
    readonly requirement: string;
    readonly scope: AccountScope;
    readonly account: Account;
  }) => Effect.Effect<
    void,
    StorageError | AccountConnectionTargetChanged | AccountConnectionRefused | AccountProvisioned
  >;
  /** Called once for a newly saved account, including secrets and OAuth completion. */
  readonly accountCreated: (account: Account) => Effect.Effect<void, StorageError>;
  /** Called after active-work checks, before deleting credentials in the same transaction. */
  readonly accountRemoving: (account: Account) => Effect.Effect<void, StorageError>;
  /**
   * Called once for a newly stored OAuth client, registered by a person or automatically, before
   * its transaction commits. A product that decides who may use clients records that here.
   */
  readonly oauthClientCreated?: (
    client: import("./oauth-clients.ts").OAuthClient,
  ) => Effect.Effect<void, StorageError>;
  /**
   * Recheck product authority before a stored client's credentials are used: whenever a sign-in
   * resolves one, whether the connection named it, a reconnect kept its account's client or the
   * automatic choice found it, and again before the sign-in's authorization code is exchanged.
   * Returns whether the product still lets the caller use it; the SDK refuses it otherwise.
   */
  readonly oauthClientResolving?: (
    client: import("./oauth-clients.ts").OAuthClient,
  ) => Effect.Effect<boolean, StorageError>;
  /**
   * Called when clients of one owner that hold the same credentials for one authorization server
   * become one (data step `8_oauth_clients_by_issuer`): `merged` are removed and `survivor` keeps
   * their credentials. A product that decides who may use clients lets everyone who could use any
   * of them use the survivor, and returns false when it cannot, which leaves every one of them as
   * it was. With `apply` false it only answers whether it could; with `apply` true it records the
   * survivor's access in the step's transaction, before the merged clients are removed.
   */
  readonly oauthClientsMerging?: (input: {
    readonly survivor: import("./oauth-clients.ts").OAuthClient;
    readonly merged: ReadonlyArray<import("./oauth-clients.ts").OAuthClient>;
    readonly apply: boolean;
  }) => Effect.Effect<boolean, StorageError>;
}

/** Evaluated declarations and tool listings: where they are kept and how long they are trusted. */
export interface ExecutorCache {
  /** Per process or isolate. Defaults to a store owned by this executor. */
  readonly memory?: import("./declarations.ts").DeclarationCache;
  /** Kept beyond this process or isolate, read when `memory` misses. */
  readonly durable?: import("./declarations.ts").DurableDeclarations;
  /** Overrides of `defaultToolListingPolicy`. */
  readonly toolListings?: Partial<import("./declarations.ts").ToolListingPolicy>;
}

/**
 * The API this host serves to apps that sign in to it, such as the built-in Executor app. Those
 * apps read the API through their own cache, keyed by their build, so an API change their build
 * cannot see would leave them listing the previous API's tools. The revision is an input of their
 * app cache and of their kept tool listings: a change starts both afresh. The runner fills such a
 * cache only with a document of this revision; see `HostApiCheck`.
 */
export interface HostApi {
  /** The SHA-256, in lowercase hex, of the exact document body served at `documents`. */
  readonly revision: string;
  /** The URLs this host serves its API document at, one for each origin apps call it at. */
  readonly documents: ReadonlyArray<string>;
  /** Whether a version with these requirements signs in to this host, and so reads its API. */
  readonly reads: (requirements: import("./apps.ts").AppRequirements) => boolean;
}

/** Caller-owned database, blobs, Git and execution; constructors do not migrate or close them. */
export interface ExecutorInputs {
  /** Executor tables, app data and the catalog live here. Migrated by the host before use. */
  readonly database: ExecutorDatabase;
  /** Public origin: the address of a stored catalog, and of webhook callbacks by default. */
  readonly origin?: string;
  /**
   * Origin new webhook subscriptions register their callbacks on; defaults to `origin`.
   * Existing subscriptions keep the callback URL they stored.
   */
  readonly webhookOrigin?: string;
  /** The Git backend behind app source. The executor derives revision storage from it. */
  readonly git: RepositoryBackend;
  readonly blobs: BlobStorage;
  readonly runtime: AppRuntime;
  readonly oauth?: OAuthOptions;
  /** Defaults to reading the hosted Executor registry. */
  readonly registry?: RegistryOptions;
  /** Optional product-owned metadata lifecycle. Failures roll back the resource write. */
  readonly hooks?: ResourceLifecycle;
  readonly workflows?: WorkflowRuntime;
  readonly cache?: ExecutorCache;
  /** This host's own API, when apps call it; see `HostApi`. */
  readonly hostApi?: HostApi;
  /** Outbound delivery and authorization for app events. Without it, subscribing is unavailable. */
  readonly events?: import("./events.ts").EventOptions;
  /**
   * Revalidates stale declarations and revokes deleted accounts' OAuth grants after the response.
   * Without it, stale declarations revalidate first and revocation runs inline.
   */
  readonly background?: import("./declarations.ts").BackgroundWork;
}

/** A hex-encoded 256-bit key encrypts saved credentials with AES-GCM; a custom store replaces that. */
export type ExecutorOptions = ExecutorInputs &
  (
    | { readonly secret: Redacted.Redacted<string>; readonly credentials?: undefined }
    | { readonly credentials: Credentials; readonly secret?: undefined }
  );

/** No valid remote response was received; the operation may already have completed. */
export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  reason: Schema.String,
}) {}

/**
 * Remote door options (scaffold shape). The serving host authenticates the
 * apiKey and decides which resources the caller may access. One caller may
 * work with several owners; an owner filter is not an authorization claim.
 */
export interface RemoteExecutorOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers?: Readonly<Record<string, string>>;
}

type TypeOf<S> = S extends { readonly Type: infer T } ? T : never;

type Part<T> = [T] extends [never] ? {} : T;

/** Promise inputs are ordinary values; the facade decodes/redacts them on entry. */
type PublicInput<T> =
  T extends Redacted.Redacted<infer Value>
    ? Value
    : T extends (...args: infer Args) => Effect.Effect<infer A, infer _E>
      ? (...args: Args) => Promise<A>
      : T extends string | number | boolean | null | undefined
        ? T
        : T extends ReadonlyArray<infer Item>
          ? readonly PublicInput<Item>[]
          : T extends object
            ? { readonly [Key in keyof T]: PublicInput<T[Key]> }
            : T;

type Input<E extends HttpApiEndpoint.Constraint> = Part<TypeOf<HttpApiEndpoint.Params<E>>> &
  Part<TypeOf<HttpApiEndpoint.Query<E>>> &
  Part<TypeOf<HttpApiEndpoint.Payload<E>>>;

type PublicOutput<T> = T extends Stream.Stream<infer A, infer _E, infer _R> ? AsyncIterable<A> : T;

type Method<E extends HttpApiEndpoint.Constraint> = [keyof Input<E>] extends [never]
  ? () => Effect.Effect<TypeOf<HttpApiEndpoint.Success<E>>, TypeOf<HttpApiEndpoint.Error<E>>>
  : Partial<Input<E>> extends Input<E>
    ? (
        input?: Input<E>,
      ) => Effect.Effect<TypeOf<HttpApiEndpoint.Success<E>>, TypeOf<HttpApiEndpoint.Error<E>>>
    : (
        input: Input<E>,
      ) => Effect.Effect<TypeOf<HttpApiEndpoint.Success<E>>, TypeOf<HttpApiEndpoint.Error<E>>>;

type Groups<Api> = Api extends HttpApi.HttpApi<infer _Id, infer G> ? G : never;
type WithInvocationOptions<M> = M extends (input: infer Input) => infer Output
  ? (input: Input, options?: ToolInvocationOptions) => Output
  : M;
type WithListOptions<M, Options> = M extends (input: infer Input) => infer Output
  ? (input: Input, options?: Options) => Output
  : M;

/**
 * Effect-native operations exposed by @executor-js/sdk/core, projected from
 * the HTTP contract rather than inferred from an implementation. Inputs use
 * decoded contract values, including Redacted secrets. Operations run in the
 * caller's fiber, retaining cancellation and live-query dependency tracking.
 */
type FlatExecutor = {
  readonly [G in Groups<ExecutorApi | typeof WebhookSetupApi> as HttpApiGroup.Identifier<G>]: {
    readonly [
      E in HttpApiGroup.Endpoints<G> as HttpApiEndpoint.Identifier<E>
    ]: HttpApiGroup.Identifier<G> extends "tools"
      ? HttpApiEndpoint.Identifier<E> extends "call" | "resume"
        ? WithInvocationOptions<Method<E>>
        : HttpApiEndpoint.Identifier<E> extends "list"
          ? WithListOptions<Method<E>, ToolListOptions>
          : Method<E>
      : HttpApiGroup.Identifier<G> extends "skills"
        ? HttpApiEndpoint.Identifier<E> extends "list"
          ? WithListOptions<Method<E>, CatalogReadOptions>
          : Method<E>
        : Method<E>;
  };
};

/** App-related namespaces remain beneath apps, including workflow execution management. */
export type Executor = Omit<FlatExecutor, "apps" | "appWorkflows" | "appWorkflowRuns" | "tools"> & {
  readonly tools: FlatExecutor["tools"] & {
    /**
     * Host-only: read a pending request and its issuer, so the host that issued it can show the
     * saved call. The owner is a filter, not authorization; consumed and expired requests are not
     * found. The host authorizes the reader and refuses requests it did not issue.
     */
    readonly approval: (input: {
      readonly requestId: ApprovalRequestId;
      readonly owner?: OwnerId;
    }) => Effect.Effect<ToolApproval, StorageError | ToolApprovalNotFound>;
    /**
     * Host-only: keep the target's current listing as search rows, reading the listing as `list`
     * does only when its rows are missing or older than a kept listing may be served. It names
     * the listing only once its rows are saved, and fails with `ToolSearchUnavailable` when they
     * cannot be. Hosts authorize the target as for `list`.
     */
    readonly searchable: (
      input: Omit<Parameters<FlatExecutor["tools"]["list"]>[0], "cursor" | "limit">,
      options?: ToolListOptions,
    ) => Effect.Effect<
      SearchableTools,
      Effect.Error<ReturnType<FlatExecutor["tools"]["list"]>> | ToolSearchUnavailable
    >;
    /**
     * Host-only: rank the tools of listings `searchable` returned with BM25. Hosts narrow each
     * target's scopes to the tools the caller may discover; the SDK never widens them.
     */
    readonly search: (input: ToolSearchInput) => Effect.Effect<ToolSearchPage, StorageError>;
  };
  readonly apps: Omit<FlatExecutor["apps"], (typeof LegacyVersionEndpoints)[number]> & {
    readonly workflows: FlatExecutor["appWorkflows"];
    readonly workflowRuns: FlatExecutor["appWorkflowRuns"];
    /**
     * Host-only: `copy` under an app ID the host reserved, such as one a storage migration
     * planned for a copy and parked state under. `save` saves the source without deploying it,
     * for a copy whose version no longer builds. Fails like `copy`; an app that already has
     * the ID fails with `StorageError`, so callers check for it first.
     */
    readonly copyAs: (
      input: Parameters<FlatExecutor["apps"]["copy"]>[0] & {
        readonly id: AppId;
        readonly save?: boolean;
      },
    ) => ReturnType<FlatExecutor["apps"]["copy"]>;
    /**
     * Host-only: compile source files as `deploy` would and return the requirements they declare,
     * writing nothing: no app, version or source is saved, and the build is neither retained nor
     * cached. For checks that must not create anything, such as the v1 import's dry run. Fails
     * like `deploy`'s build, except that a compiler that did not answer is `BuildUnanswered`.
     */
    readonly build: (input: {
      readonly owner: OwnerId;
      readonly name: string;
      readonly files: SourceFiles;
    }) => Effect.Effect<
      { readonly requirements: typeof AppRequirements.Type },
      VersionBuildFailed | BuildMemoryExceeded | BuildUnanswered | StorageError
    >;
  };
  readonly [WebhookSourceHost]: WebhookSourceDispatcher;
  readonly [WorkflowHost]: import("./workflow-runtime.ts").WorkflowHost;
  readonly [RepositoryHost]: RepositoryHost;
  readonly [StorageHost]: StorageHost;
  readonly [InteractiveHost]: import("./interactive-accounts.ts").InteractiveHost;
  readonly [PrefetchHost]: PrefetchHost;
  readonly [SavedOAuthClientsHost]: import("./oauth-clients.ts").SavedOAuthClients;
  readonly [OwnerMovesHost]: import("./owner.ts").OwnerMoves;
  /** Host-only: the v1 importer's grant import (`notes/v1-import.md`). */
  readonly [OAuthGrantImport]: OAuthGrantImport;
  readonly scheduler: import("./scheduler.ts").ScheduleDispatcher;
  /** Host-only: products authorize every event operation before calling it. */
  readonly events: import("./events.ts").ExecutorEvents;
  /**
   * Host-only: credential writes for accounts the product provisions itself, such as its own API
   * access. Everyone else saves credentials through an app's connection request.
   */
  readonly managedAccounts: import("./account.ts").ManagedAccounts;
};

type Promisify<T> = T extends (...args: infer Args) => Effect.Effect<infer A, infer _E, never>
  ? (...args: { [Key in keyof Args]: PublicInput<Args[Key]> }) => Promise<PublicOutput<A>>
  : { readonly [Key in keyof T]: Promisify<T[Key]> };

/** Root SDK facade over the same operations: plain inputs, Promises, and AsyncIterable subscriptions. */
export type PromiseExecutor = Promisify<
  Omit<
    Executor,
    | typeof WorkflowHost
    | typeof WebhookSourceHost
    | typeof RepositoryHost
    | typeof InteractiveHost
    | typeof StorageHost
    | typeof PrefetchHost
    | typeof SavedOAuthClientsHost
    | typeof OwnerMovesHost
    | typeof OAuthGrantImport
    | "scheduler"
    | "events"
    | "managedAccounts"
    | "tools"
    | "apps"
  > & {
    readonly tools: Omit<Executor["tools"], "approval" | "searchable" | "search">;
    readonly apps: Omit<Executor["apps"], "copyAs" | "build">;
  }
>;
