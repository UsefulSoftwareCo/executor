import { ProfileHost, type ProfileDispatcher } from "./profiles.ts";
import { WorkflowHost, type WorkflowRuntime } from "./workflow-runtime.ts";
/** The shared Executor interface and remote client options; projected from ExecutorApi. */
import { type Effect, type Redacted, type Stream, Schema } from "effect";
import type { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import type { WebhookSetupApi } from "./webhook-setup.ts";
import type { ExecutorApi } from "./http.ts";
import type { Credentials } from "./storage.ts";
import type { ExecutorDatabase } from "../implementation/storage.ts";
import type { AppRuntime } from "../implementation/runtime.ts";
import type { OAuthOptions } from "./oauth.ts";
import type { ToolInvocationOptions } from "./tools.ts";
import type { App } from "./apps.ts";
import type { Account } from "./account.ts";
import type { AccountConnectionId, StorageError } from "./shared.ts";
import type { BlobStorage } from "./blobs.ts";
import type { AppSourceStorage } from "./source.ts";

/** Product metadata participates in the resource transaction; hooks must perform no external I/O. */
export interface ResourceLifecycle {
  /** Recheck the saved subject before any profile-backed execution, including background work. */
  readonly profileResolving?: (
    profile: import("./profiles.ts").Profile,
  ) => Effect.Effect<void, StorageError>;
  /** Recheck product authority immediately before acquiring and returning account credentials. */
  readonly accountResolving: (account: Account) => Effect.Effect<void, StorageError>;
  /** Recheck a saved connection after external authentication, before committing its result. */
  readonly connectionCompleting: (
    connection: AccountConnectionId,
  ) => Effect.Effect<void, StorageError>;
  /** Called once after inserting a new configured app, before its transaction commits. */
  readonly appCreated: (app: App) => Effect.Effect<void, StorageError>;
  /** Called once for a newly saved account, including secrets and OAuth completion. */
  readonly accountCreated: (account: Account) => Effect.Effect<void, StorageError>;
  /** Called after active-work checks, before deleting credentials in the same transaction. */
  readonly accountRemoving: (account: Account) => Effect.Effect<void, StorageError>;
}

/** Caller-owned SQL, blobs, execution and encryption; constructors do not migrate or close them. */
export interface ExecutorOptions {
  /** Optional product-owned metadata lifecycle. Failures roll back the resource write. */
  readonly lifecycle?: ResourceLifecycle;
  /** Public callback origin, provided by the serving product. Local providers need a reachable tunnel. */
  readonly workflows?: WorkflowRuntime;
  readonly webhookOrigin?: string;
  readonly storage: ExecutorDatabase;
  readonly appStorage?: import("@executor-js/app-data").AppDatabases;
  readonly blobs: BlobStorage;
  readonly sources: AppSourceStorage;
  readonly runtime: AppRuntime;
  readonly credentials: Credentials;
  readonly oauth?: OAuthOptions;
  /** Evaluated skills, workflows and webhooks, shared per process or isolate. Defaults to this executor. */
  readonly declarations?: import("./declarations.ts").DeclarationCache;
  /** Revalidates stale declarations after the response. Without it, stale ones revalidate first. */
  readonly background?: import("./declarations.ts").BackgroundWork;
}

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
        : Method<E>
      : Method<E>;
  };
};

/** App-related namespaces remain beneath apps, including workflow execution management. */
export type Executor = Omit<
  FlatExecutor,
  "apps" | "appWorkflows" | "appWorkflowRuns" | "appProfiles"
> & {
  readonly apps: FlatExecutor["apps"] & {
    readonly profiles: FlatExecutor["appProfiles"];
    readonly workflows: FlatExecutor["appWorkflows"];
    readonly workflowRuns: FlatExecutor["appWorkflowRuns"];
  };
  readonly [ProfileHost]: ProfileDispatcher;
  readonly [WorkflowHost]: import("./workflow-runtime.ts").WorkflowHost;
  readonly scheduler: import("./scheduler.ts").ScheduleDispatcher;
};

type Promisify<T> = T extends (...args: infer Args) => Effect.Effect<infer A, infer _E, never>
  ? (...args: { [Key in keyof Args]: PublicInput<Args[Key]> }) => Promise<PublicOutput<A>>
  : { readonly [Key in keyof T]: Promisify<T[Key]> };

/** Root SDK facade over the same operations: plain inputs, Promises, and AsyncIterable subscriptions. */
export type PromiseExecutor = Promisify<
  Omit<Executor, typeof WorkflowHost | typeof ProfileHost | "scheduler">
>;
