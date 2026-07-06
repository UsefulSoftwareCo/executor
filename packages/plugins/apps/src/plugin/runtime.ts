import { Effect } from "effect";
import type { InvokeOptions } from "@executor-js/sdk";

import type { ArtifactStore } from "../seams/artifact-store";
import type { ScopeDb } from "../seams/scope-db";
import {
  InputValidationError,
  OutputValidationError,
  type ToolSandbox,
} from "../seams/tool-sandbox";
import {
  publish as runPublish,
  loadDescriptorFromSnapshot,
  type PublishOutput,
} from "../pipeline/publish";
import { PublishError } from "../pipeline/discover";
import type { AppDescriptor, AppSourceRef, ToolDescriptor } from "../pipeline/descriptor";
import { bundleEntry } from "../pipeline/bundle";
import {
  buildBridge,
  rootsFor,
  resolveIntegrationBindings,
  type ClientResolver,
  BindingError,
} from "./bindings";
import type { AppsStore } from "./store";

// ---------------------------------------------------------------------------
// AppsRuntime: the substrate-neutral core for published custom tools.
// ---------------------------------------------------------------------------

export interface AppsRuntimeDeps {
  readonly artifactStore: ArtifactStore;
  readonly scopeDb: ScopeDb;
  readonly sandbox: ToolSandbox;
  readonly store: AppsStore;
  /** Routes a bound integration method call to the real API (policy/audit). */
  readonly resolver: ClientResolver;
}

export interface AppsRuntime {
  readonly publish: (input: {
    readonly scope: string;
    readonly files: ReadonlyMap<string, string>;
    readonly message?: string;
    readonly description?: string;
    readonly source?: AppSourceRef;
  }) => Effect.Effect<PublishOutput, PublishError>;
  readonly getDescriptor: (scope: string) => Effect.Effect<AppDescriptor | null>;
  /** Re-derive the published-descriptor pointer from the latest committed
   *  snapshot. */
  readonly repair: (scope: string) => Effect.Effect<AppDescriptor | null, PublishError>;
  readonly invokeTool: (input: {
    readonly scope: string;
    readonly tool: string;
    readonly args: unknown;
    /** Optional per-request resolver override. The catalog invoke path supplies
     *  one built from the request's executor context. */
    readonly resolver?: ClientResolver;
    /** Optional caller options forwarded to bridged sub-calls. */
    readonly invokeOptions?: InvokeOptions;
  }) => Effect.Effect<
    unknown,
    PublishError | BindingError | InputValidationError | OutputValidationError
  >;
  readonly deps: AppsRuntimeDeps;
}

const failNoDescriptor = (scope: string): PublishError =>
  new PublishError({
    message: `scope "${scope}" has no published app`,
    stage: "project",
    diagnostics: [],
  });

export const makeAppsRuntime = (deps: AppsRuntimeDeps): AppsRuntime => {
  const bundleCache = new Map<string, string>();
  const publishChains = new Map<string, Promise<unknown>>();

  const withScopePublishLock = <A>(scope: string, run: () => Promise<A>): Promise<A> => {
    const prior = publishChains.get(scope) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(run);
    publishChains.set(
      scope,
      next.catch(() => undefined),
    );
    return next;
  };

  const bundleFor = (
    descriptor: AppDescriptor,
    sourcePath: string,
  ): Effect.Effect<string, PublishError> =>
    Effect.gen(function* () {
      const cacheKey = `${descriptor.snapshotId}:${sourcePath}`;
      const cached = bundleCache.get(cacheKey);
      if (cached) return cached;
      const scopeStore = yield* deps.artifactStore.forScope(descriptor.scope).pipe(
        Effect.mapError(
          (c) =>
            new PublishError({
              message: c.message,
              stage: "project",
              diagnostics: [],
            }),
        ),
      );
      const files = yield* scopeStore.read(descriptor.snapshotId as never).pipe(
        Effect.mapError(
          (c) =>
            new PublishError({
              message: c.message,
              stage: "project",
              diagnostics: [],
            }),
        ),
      );
      const bundle = yield* bundleEntry({ files, entry: sourcePath }).pipe(
        Effect.mapError(
          (c) =>
            new PublishError({
              message: c.message,
              stage: "bundle",
              diagnostics: [{ path: sourcePath, message: c.message }],
            }),
        ),
      );
      bundleCache.set(cacheKey, bundle.code);
      return bundle.code;
    });

  const recoverFromSnapshot = (scope: string): Effect.Effect<AppDescriptor | null, PublishError> =>
    Effect.gen(function* () {
      const scopeStore = yield* deps.artifactStore.forScope(scope).pipe(
        Effect.mapError(
          (c) =>
            new PublishError({
              message: c.message,
              stage: "project",
              diagnostics: [],
            }),
        ),
      );
      const latest = yield* scopeStore.latest().pipe(
        Effect.mapError(
          (c) =>
            new PublishError({
              message: c.message,
              stage: "project",
              diagnostics: [],
            }),
        ),
      );
      if (!latest) return null;
      return yield* loadDescriptorFromSnapshot(deps.artifactStore, scope, latest.id);
    });

  const requireDescriptor = (scope: string): Effect.Effect<AppDescriptor, PublishError> =>
    deps.store.getDescriptor(scope).pipe(
      Effect.mapError(
        (c) =>
          new PublishError({
            message: String(c),
            stage: "project",
            diagnostics: [],
          }),
      ),
      Effect.flatMap((d) =>
        d ? Effect.succeed(d) : recoverFromSnapshot(scope).pipe(Effect.orElseSucceed(() => null)),
      ),
      Effect.flatMap((d) => (d ? Effect.succeed(d) : Effect.fail(failNoDescriptor(scope)))),
    );

  const putDescriptorPointer = (descriptor: AppDescriptor): Effect.Effect<void, PublishError> =>
    deps.store.putDescriptor("org", descriptor).pipe(
      Effect.mapError(
        (c) =>
          new PublishError({
            message: String(c),
            stage: "project",
            diagnostics: [],
          }),
      ),
    );

  const repairScope = (scope: string): Effect.Effect<AppDescriptor | null, PublishError> =>
    Effect.gen(function* () {
      const descriptor = yield* recoverFromSnapshot(scope);
      if (!descriptor) return null;
      yield* putDescriptorPointer(descriptor);
      return descriptor;
    });

  const invokeToolInternal = (
    scope: string,
    descriptor: AppDescriptor,
    toolDesc: ToolDescriptor,
    args: unknown,
    resolver?: ClientResolver,
    invokeOptions?: InvokeOptions,
  ): Effect.Effect<
    unknown,
    PublishError | BindingError | InputValidationError | OutputValidationError
  > =>
    Effect.gen(function* () {
      const activeResolver = resolver ?? deps.resolver;
      const resolved = yield* resolveIntegrationBindings(
        toolDesc.integrations,
        args,
        activeResolver,
      );
      const roots = rootsFor(toolDesc.integrations);
      const code = yield* bundleFor(descriptor, toolDesc.sourcePath);
      const db = yield* deps.scopeDb.forScope(scope).pipe(
        Effect.mapError(
          (c) =>
            new PublishError({
              message: c.message,
              stage: "project",
              diagnostics: [],
            }),
        ),
      );
      const bridge = buildBridge({
        declared: toolDesc.integrations,
        bindings: resolved.bindings,
        db,
        resolver: activeResolver,
        invokeOptions,
      });
      const result = yield* deps.sandbox
        .invoke(
          code,
          { artifact: toolDesc.name, kind: "tool", input: resolved.input, roots },
          bridge,
        )
        .pipe(
          Effect.mapError((c) => {
            if (
              c instanceof BindingError ||
              c instanceof InputValidationError ||
              c instanceof OutputValidationError
            ) {
              return c;
            }
            return new PublishError({
              message: c.message,
              stage: "project",
              diagnostics: [{ path: toolDesc.sourcePath, message: c.message }],
            });
          }),
        );
      return result.output;
    });

  return {
    deps,
    publish: (input) =>
      Effect.flatMap(
        Effect.tryPromise({
          try: () =>
            withScopePublishLock(input.scope, () =>
              Effect.runPromiseExit(
                Effect.gen(function* () {
                  const out = yield* runPublish(
                    {
                      artifactStore: deps.artifactStore,
                      sandbox: deps.sandbox,
                    },
                    {
                      scope: input.scope,
                      files: input.files,
                      commitMessage: input.message,
                      description: input.description,
                      source: input.source,
                    },
                  );
                  yield* putDescriptorPointer(out.descriptor);
                  return out;
                }),
              ),
            ),
          catch: (cause) =>
            new PublishError({
              message: cause instanceof Error ? cause.message : String(cause),
              stage: "project",
              diagnostics: [],
            }),
        }),
        (exit) => exit,
      ),

    getDescriptor: (scope) =>
      deps.store.getDescriptor(scope).pipe(
        Effect.orElseSucceed(() => null),
        Effect.flatMap((pointer) =>
          pointer
            ? Effect.succeed(pointer)
            : recoverFromSnapshot(scope).pipe(Effect.orElseSucceed(() => null)),
        ),
      ),

    repair: (scope) => repairScope(scope),

    invokeTool: (input) =>
      Effect.gen(function* () {
        const descriptor = yield* requireDescriptor(input.scope);
        const toolDesc = descriptor.tools.find((t) => t.name === input.tool);
        if (!toolDesc) {
          return yield* Effect.fail(
            new PublishError({
              message: `tool "${input.tool}" is not published in scope "${input.scope}"`,
              stage: "project",
              diagnostics: [],
            }),
          );
        }
        return yield* invokeToolInternal(
          input.scope,
          descriptor,
          toolDesc,
          input.args,
          input.resolver,
          input.invokeOptions,
        );
      }),
  };
};
