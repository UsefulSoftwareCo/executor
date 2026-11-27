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
import type { CodeFiles } from "../contracts/source.ts";
import type { BuildId, Json } from "../contracts/shared.ts";
import { BlobStore, type BlobKey, type BlobStorage } from "../contracts/blobs.ts";

const NativeRuntime = Symbol("executor.Runtime");

export interface AppRuntime {
  readonly [NativeRuntime]: Runtime<BlobStore>;
}

export interface ResolvedAppRuntime {
  readonly build: (input: {
    readonly files: CodeFiles;
    readonly public?: ReadonlyArray<string>;
  }) => Promise<BuiltApp>;
  readonly asset?: (input: {
    readonly build: BuildId;
    readonly path: string;
  }) => Promise<RuntimeAsset | undefined>;
  readonly skills: (input: {
    readonly app: string;
    readonly build: BuildId;
    readonly accounts: ResolvedAccountsInput;
    readonly caller?: string;
  }) => Promise<readonly AppSkillSource[]>;
  readonly inspect: (input: {
    readonly app: string;
    readonly build: BuildId;
    readonly accounts: ResolvedAccountsInput;
    readonly caller?: string;
    readonly tools?: readonly string[];
    readonly scheduled?: true;
  }) => Promise<HostedCatalog>;
  readonly index: (input: {
    readonly app: string;
    readonly build: BuildId;
    readonly accounts: ResolvedAccountsInput;
    readonly caller?: string;
  }) => Promise<HostedCatalogSummary>;
  readonly query: (input: {
    readonly app: string;
    readonly build: BuildId;
    readonly database: boolean;
    readonly accounts: ResolvedAccountsInput;
    readonly caller?: string;
    readonly name: string;
    readonly input: Json;
  }) => Promise<Json>;
  readonly mutate: (input: {
    readonly app: string;
    readonly build: BuildId;
    readonly database: boolean;
    readonly accounts: ResolvedAccountsInput;
    readonly caller?: string;
    readonly name: string;
    readonly input: Json;
  }) => Promise<Json>;
  readonly webhook: (input: {
    readonly app: string;
    readonly build: BuildId;
    readonly database: boolean;
    readonly accounts: ResolvedAccountsInput;
    readonly caller?: string;
    readonly command: import("apps/contracts").WebhookCommand;
  }) => Promise<Json>;
  readonly call: (input: {
    readonly app: string;
    readonly approval?: NonNullable<HostContext["approval"]>;
    readonly elicitation?: NonNullable<HostContext["elicitation"]>;
    readonly build: BuildId;
    readonly database: boolean;
    readonly accounts: ResolvedAccountsInput;
    readonly caller?: string;
    readonly tool: string;
    readonly kind?: "query" | "mutation";
    readonly input: Json;
  }) => Promise<Json>;
}

export const runtimeAdapter = (runtime: Runtime<BlobStore>): AppRuntime => ({
  [NativeRuntime]: runtime,
});

export const createAppRuntime = (options: {
  readonly runtime: AppRuntime;
  readonly blobs: BlobStorage;
}): ResolvedAppRuntime => {
  const runtime = toEffectRuntime(options.runtime, options.blobs);
  const asset = runtime.asset;
  const context = (accounts: ResolvedAccountsInput) =>
    Schema.decodeUnknownEffect(Schema.RedactedFromValue(ResolvedAccounts))(accounts).pipe(
      Effect.map((accounts) => ({ accounts, hostApi: undefined })),
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

export const blobKind = (key: string) =>
  key.startsWith("frameworks/")
    ? "framework"
    : /^bld_[^/]+(\/worker)?\.json$/u.test(key)
      ? "build"
      : /^bld_[^/]+\/ui\//u.test(key)
        ? "build-ui"
        : /^bld_[^/]+\/public\.json$/u.test(key)
          ? "public-manifest"
          : /^deployments\/[^/]+\/source\.json$/u.test(key)
            ? "version-source"
            : /^app-source\/[^/]+\/initial\.json$/u.test(key)
              ? "initial-source"
              : key.startsWith("app-public/")
                ? "public-file"
                : key.startsWith("team-icons/")
                  ? "team-icon"
                  : "other";

const tracedPut = (blobs: BlobStorage, key: BlobKey, body: Uint8Array) =>
  blobs.put(key, body).pipe(
    Effect.tap(() => Effect.annotateCurrentSpan("storage.blob.outcome", "stored")),
    Effect.tapError(() => Effect.annotateCurrentSpan("storage.blob.outcome", "failed")),
    Effect.withSpan("storage.blob.put", {
      attributes: { "storage.blob.size": body.byteLength, "storage.blob.kind": blobKind(key) },
    }),
  );

export const withTracedPuts = (blobs: BlobStorage): BlobStorage => ({
  ...blobs,
  put: (key, body) => tracedPut(blobs, key, body),
});

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
    put: (key, body) => tracedPut(blobs, key, body),
    remove: (key) => blobs.remove(key).pipe(Effect.withSpan("storage.blob.remove")),
    removeAll: (keys) =>
      blobs.removeAll(keys).pipe(
        Effect.withSpan("storage.blob.remove_all", {
          attributes: { "storage.blob.keys": keys.length },
        }),
      ),
    list: (folder, options) =>
      blobs.list(folder, options).pipe(Effect.withSpan("storage.blob.list")),
    stream: (key, range) =>
      blobs.stream(key, range).pipe(
        Effect.tap((body) => Effect.annotateCurrentSpan("storage.blob.found", Option.isSome(body))),
        Effect.withSpan("storage.blob.stream"),
      ),
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
    connect: (input) => runtime.connect(input).pipe(provide),
    checkAccount: (input) => runtime.checkAccount(input).pipe(provide),
    migrate: (input) => runtime.migrate(input).pipe(provide),
  };
};
