/** Public Promise boundary for host-supplied runtime implementations. */
import { Clock, Effect, Option, Schema } from "effect";
import {
  HostAccountsInvalid,
  ResolvedAccounts,
  type HostContext,
  type HostedCatalog,
  type HostedCatalogSummary,
  type AppSkillSource,
  type ResolvedAccountsInput,
} from "apps/contracts";
import {
  AppCacheChanges,
  type BuiltApp,
  type Runtime,
  type RuntimeAsset,
} from "../contracts/runtime.ts";
import type { DeclarationCache } from "../contracts/declarations.ts";
import type { SourceFiles } from "../contracts/deployment.ts";
import type { BuildId, Json } from "../contracts/shared.ts";
import { BlobStore, type BlobStorage } from "../contracts/blobs.ts";

const NativeRuntime = Symbol("executor.Runtime");

/** Runtime definition. createExecutor supplies its host-owned binary storage. */
export interface AppRuntime {
  readonly [NativeRuntime]: Runtime<BlobStore>;
}

/** Standalone Promise adapter after host dependencies have been resolved. */
export interface ResolvedAppRuntime {
  readonly build: (input: { readonly files: SourceFiles }) => Promise<BuiltApp>;
  readonly asset?: (input: {
    readonly build: BuildId;
    readonly path: string;
  }) => Promise<RuntimeAsset | undefined>;
  readonly skills: (input: {
    readonly app: string;
    readonly build: BuildId;
    readonly accounts: ResolvedAccountsInput;
  }) => Promise<readonly AppSkillSource[]>;
  readonly inspect: (input: {
    readonly app: string;
    readonly build: BuildId;
    readonly accounts: ResolvedAccountsInput;
    readonly tools?: readonly string[];
    readonly scheduled?: true;
  }) => Promise<HostedCatalog>;
  readonly index: (input: {
    readonly app: string;
    readonly build: BuildId;
    readonly accounts: ResolvedAccountsInput;
  }) => Promise<HostedCatalogSummary>;
  readonly query: (input: {
    readonly app: string;
    readonly build: BuildId;
    readonly database: boolean;
    readonly accounts: ResolvedAccountsInput;
    readonly name: string;
    readonly input: Json;
  }) => Promise<Json>;
  readonly mutate: (input: {
    readonly app: string;
    readonly build: BuildId;
    readonly database: boolean;
    readonly accounts: ResolvedAccountsInput;
    readonly name: string;
    readonly input: Json;
  }) => Promise<Json>;
  readonly webhook: (input: {
    readonly app: string;
    readonly build: BuildId;
    readonly database: boolean;
    readonly accounts: ResolvedAccountsInput;
    readonly command: import("apps/contracts").WebhookCommand;
  }) => Promise<Json>;
  readonly call: (input: {
    readonly app: string;
    readonly approval?: NonNullable<HostContext["approval"]>;
    readonly elicitation?: NonNullable<HostContext["elicitation"]>;
    readonly build: BuildId;
    readonly database: boolean;
    readonly accounts: ResolvedAccountsInput;
    readonly tool: string;
    readonly kind?: "query" | "mutation";
    readonly input: Json;
  }) => Promise<Json>;
}

/** Adapt a native implementation without running any effects during construction. */
export const runtimeAdapter = (runtime: Runtime<BlobStore>): AppRuntime => ({
  [NativeRuntime]: runtime,
});

/** Bind storage for standalone runtime callers. SDK callers supply these options to createExecutor instead. */
export const createAppRuntime = (options: {
  readonly runtime: AppRuntime;
  readonly blobs: BlobStorage;
}): ResolvedAppRuntime => {
  const runtime = toEffectRuntime(options.runtime, options.blobs);
  const asset = runtime.asset;
  const context = (accounts: ResolvedAccountsInput) =>
    Schema.decodeUnknownEffect(Schema.RedactedFromValue(ResolvedAccounts))(accounts).pipe(
      Effect.map((accounts) => ({ accounts })),
      Effect.mapError(() => new HostAccountsInvalid()),
    );
  return {
    build: (input) => Effect.runPromise(runtime.build(input)),
    ...(asset === undefined
      ? {}
      : { asset: (input: { build: BuildId; path: string }) => Effect.runPromise(asset(input)) }),
    skills: ({ accounts, ...input }) =>
      Effect.runPromise(
        context(accounts).pipe(
          Effect.flatMap((context) => runtime.skills({ ...input, ...context })),
          Effect.map((catalog) => catalog.skills),
        ),
      ),
    inspect: ({ accounts, ...input }) =>
      Effect.runPromise(
        context(accounts).pipe(
          Effect.flatMap((context) => runtime.inspect({ ...input, ...context })),
        ),
      ),
    index: ({ accounts, ...input }) =>
      Effect.runPromise(
        context(accounts).pipe(
          Effect.flatMap((context) => runtime.index({ ...input, ...context })),
        ),
      ),
    query: ({ accounts, ...input }) =>
      Effect.runPromise(
        context(accounts).pipe(
          Effect.flatMap((context) => runtime.query({ ...input, ...context })),
        ),
      ),
    mutate: ({ accounts, ...input }) =>
      Effect.runPromise(
        context(accounts).pipe(
          Effect.flatMap((context) => runtime.mutate({ ...input, ...context })),
        ),
      ),
    webhook: ({ accounts, ...input }) =>
      Effect.runPromise(
        context(accounts).pipe(
          Effect.flatMap((context) => runtime.webhook({ ...input, ...context })),
        ),
      ),
    call: ({ accounts, ...input }) =>
      Effect.runPromise(
        context(accounts).pipe(Effect.flatMap((context) => runtime.call({ ...input, ...context }))),
      ),
  };
};

/**
 * Provide the host store without changing caller cancellation, tracing, or resource scopes. App
 * cache changes the runtime reports forget that app's kept results in `declarations`.
 */
export const toEffectRuntime = (
  definition: AppRuntime,
  blobs: BlobStorage,
  declarations?: DeclarationCache,
): Runtime => {
  const runtime = definition[NativeRuntime];
  const asset = runtime.asset;
  const changes =
    declarations === undefined
      ? undefined
      : {
          changed: (app: string) =>
            Clock.currentTimeMillis.pipe(Effect.map((at) => declarations.changed(app, at))),
        };
  const observe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    changes === undefined ? effect : Effect.provideService(effect, AppCacheChanges, changes);
  const store = Effect.provideService(BlobStore, {
    get: (key) =>
      blobs.get(key).pipe(
        Effect.tap((body) =>
          Effect.annotateCurrentSpan({
            "storage.blob.found": Option.isSome(body),
            ...(Option.isSome(body) ? { "storage.blob.size": body.value.byteLength } : {}),
          }),
        ),
        Effect.withSpan("storage.blob.get"),
      ),
    exists: (key) =>
      blobs.exists(key).pipe(
        Effect.tap((found) => Effect.annotateCurrentSpan("storage.blob.found", found)),
        Effect.withSpan("storage.blob.exists"),
      ),
    put: (key, body) =>
      blobs.put(key, body).pipe(
        Effect.withSpan("storage.blob.put", {
          attributes: { "storage.blob.size": body.byteLength },
        }),
      ),
    remove: (key) => blobs.remove(key).pipe(Effect.withSpan("storage.blob.remove")),
  });
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => observe(store(effect));
  return {
    ...(runtime.changes === undefined ? {} : { changes: runtime.changes }),
    build: (input) => runtime.build(input).pipe(provide),
    ...(asset === undefined
      ? {}
      : { asset: (input: Parameters<typeof asset>[0]) => asset(input).pipe(provide) }),
    skills: (input) => runtime.skills(input).pipe(provide),
    inspect: (input) => runtime.inspect(input).pipe(provide),
    index: (input) => runtime.index(input).pipe(provide),
    query: (input) => runtime.query(input).pipe(provide),
    mutate: (input) => runtime.mutate(input).pipe(provide),
    workflow: (input) => runtime.workflow(input).pipe(provide),
    webhook: (input) => runtime.webhook(input).pipe(provide),
    call: (input) => runtime.call(input).pipe(provide),
    checkAccount: (input) => runtime.checkAccount(input).pipe(provide),
    migrate: (input) => runtime.migrate(input).pipe(provide),
  };
};
