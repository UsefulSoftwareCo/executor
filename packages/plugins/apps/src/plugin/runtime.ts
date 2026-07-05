import { Effect } from "effect";

import type { ArtifactStore } from "../seams/artifact-store";
import type { ScopeDb } from "../seams/scope-db";
import type { ToolSandbox } from "../seams/tool-sandbox";
import type { LiveChannel } from "../seams/live-channel";
import type { DurableSteps, WorkflowRunner, RunView, StepView } from "../seams/workflow-runner";
import { publish as runPublish, type PublishOutput } from "../pipeline/publish";
import { PublishError } from "../pipeline/discover";
import type { AppDescriptor, ToolDescriptor, WorkflowDescriptor } from "../pipeline/descriptor";
import { bundleEntry } from "../pipeline/bundle";
import {
  buildBridge,
  rootsFor,
  type Bindings,
  type ClientResolver,
  BindingError,
} from "./bindings";
import type { AppsStore } from "./store";

// ---------------------------------------------------------------------------
// AppsRuntime — the substrate-neutral core of the apps subsystem. It owns the
// five seams + the store, and exposes the operations every surface (HTTP, MCP,
// the plugin) drives: publish, resolveTools (descriptor projection), invokeTool
// (bundle -> sandbox invoke with bound clients), and the workflow lifecycle
// (start/signal/status/history) with real journal replay + scheduling.
//
// Nothing here knows about HTTP or MCP; those are thin adapters over this.
// ---------------------------------------------------------------------------

export interface AppsRuntimeDeps {
  readonly artifactStore: ArtifactStore;
  readonly scopeDb: ScopeDb;
  readonly sandbox: ToolSandbox;
  readonly workflows: WorkflowRunner;
  readonly liveChannel: LiveChannel;
  readonly store: AppsStore;
  /** Routes a bound integration method call to the real API (policy/audit). */
  readonly resolver: ClientResolver;
}

export interface AppsRuntime {
  readonly publish: (input: {
    readonly scope: string;
    readonly files: ReadonlyMap<string, string>;
    readonly message?: string;
  }) => Effect.Effect<PublishOutput, PublishError>;
  readonly getDescriptor: (scope: string) => Effect.Effect<AppDescriptor | null>;
  readonly invokeTool: (input: {
    readonly scope: string;
    readonly tool: string;
    readonly args: unknown;
    readonly bindings: Bindings;
  }) => Effect.Effect<unknown, PublishError | BindingError>;
  readonly startWorkflow: (input: {
    readonly scope: string;
    readonly workflow: string;
    readonly input?: unknown;
    readonly bindings?: Bindings;
    readonly runId?: string;
  }) => Effect.Effect<RunView, PublishError | BindingError>;
  readonly signalWorkflow: (input: {
    readonly scope: string;
    readonly runId: string;
    readonly event: string;
    readonly payload: unknown;
  }) => Effect.Effect<RunView, PublishError | BindingError>;
  readonly getRun: (runId: string) => Effect.Effect<RunView | null>;
  readonly listRuns: (scope: string) => Effect.Effect<readonly RunView[]>;
  readonly listSteps: (runId: string) => Effect.Effect<readonly StepView[]>;
  /** Serve a ui bundle by name (raw endpoint / MCP resource). */
  readonly getUiBundle: (
    scope: string,
    name: string,
  ) => Effect.Effect<{ code: string; title?: string; maxHeight?: number } | null>;
  /** Subscribe to a scope's live invalidations (SSE adapter drives this). */
  readonly subscribeLive: (
    scope: string,
    listener: (event: { table: string; version: number }) => void,
  ) => () => void;
  readonly deps: AppsRuntimeDeps;
}

const failNoDescriptor = (scope: string): PublishError =>
  new PublishError({
    message: `scope "${scope}" has no published app`,
    stage: "project",
    diagnostics: [],
  });

export const makeAppsRuntime = (deps: AppsRuntimeDeps): AppsRuntime => {
  // Bundle cache keyed by (snapshot, sourcePath): a published snapshot is
  // immutable, so its bundles never change.
  const bundleCache = new Map<string, string>();

  const bundleFor = (
    descriptor: AppDescriptor,
    sourcePath: string,
  ): Effect.Effect<string, PublishError> =>
    Effect.gen(function* () {
      const cacheKey = `${descriptor.snapshotId}:${sourcePath}`;
      const cached = bundleCache.get(cacheKey);
      if (cached) return cached;
      const scopeStore = yield* deps.artifactStore
        .forScope(descriptor.scope)
        .pipe(
          Effect.mapError(
            (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
          ),
        );
      const files = yield* scopeStore
        .read(descriptor.snapshotId as never)
        .pipe(
          Effect.mapError(
            (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
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

  const requireDescriptor = (scope: string): Effect.Effect<AppDescriptor, PublishError> =>
    deps.store.getDescriptor(scope).pipe(
      Effect.mapError(
        (c) => new PublishError({ message: String(c), stage: "project", diagnostics: [] }),
      ),
      Effect.flatMap((d) => (d ? Effect.succeed(d) : Effect.fail(failNoDescriptor(scope)))),
    );

  const invokeToolInternal = (
    scope: string,
    descriptor: AppDescriptor,
    toolDesc: ToolDescriptor,
    args: unknown,
    bindings: Bindings,
  ): Effect.Effect<unknown, PublishError | BindingError> =>
    Effect.gen(function* () {
      const roots = yield* rootsFor(toolDesc.connections, bindings);
      const code = yield* bundleFor(descriptor, toolDesc.sourcePath);
      const db = yield* deps.scopeDb
        .forScope(scope)
        .pipe(
          Effect.mapError(
            (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
          ),
        );
      const bridge = buildBridge({
        declared: toolDesc.connections,
        bindings,
        db,
        resolver: deps.resolver,
      });
      const result = yield* deps.sandbox
        .invoke(code, { artifact: toolDesc.name, kind: "tool", input: args, roots }, bridge)
        .pipe(
          Effect.mapError(
            (c) =>
              new PublishError({
                message: c.message,
                stage: "project",
                diagnostics: [{ path: toolDesc.sourcePath, message: c.message }],
              }),
          ),
        );
      return result.output;
    });

  // Build the workflow body closure for one run: replay the workflow's compiled
  // bundle over the DurableSteps. Our sandbox runs a tool handler, not a
  // long-lived stepful body, so we drive the workflow with a thin interpreter:
  // the workflow's `run(step, {db})` is executed in-process against the
  // DurableSteps facade, with `step.tool` -> the runner bindings and
  // `db.sql` -> the scope db. This keeps CF semantics while the durable journal
  // lives in the WorkflowRunner seam.
  const workflowBody = (
    scope: string,
    descriptor: AppDescriptor,
    wfDesc: WorkflowDescriptor,
  ): ((steps: DurableSteps) => Promise<unknown>) => {
    return async (steps: DurableSteps) => {
      const code = await Effect.runPromise(
        bundleFor(descriptor, wfDesc.sourcePath).pipe(Effect.orDie),
      );
      const db = await Effect.runPromise(deps.scopeDb.forScope(scope).pipe(Effect.orDie));
      // Interpret the workflow: run its bundle in the sandbox is not how durable
      // steps work (the body must call back into our journaled `steps`). Instead
      // we evaluate the workflow module here and invoke its `run(step, {db})`.
      // The compiled bundle sets globalThis.__artifact = the workflow def.
      const def = extractWorkflowDef(code);
      const scopeDbClient = {
        sql: (strings: TemplateStringsArray, ...values: unknown[]) =>
          Effect.runPromise(db.sql(strings, ...values).pipe(Effect.orDie)),
      };
      return def.run(steps, { db: scopeDbClient });
    };
  };

  const bindingsForRunTool = (
    scope: string,
    descriptor: AppDescriptor,
    recordedBindings: Bindings,
  ) => ({
    runTool: async (address: string, toolArgs: unknown) => {
      const toolDesc = descriptor.tools.find((t) => t.name === address);
      if (!toolDesc) throw new Error(`workflow step.tool: unknown tool "${address}"`);
      return Effect.runPromise(
        invokeToolInternal(scope, descriptor, toolDesc, toolArgs, recordedBindings).pipe(
          Effect.orDie,
        ),
      );
    },
    notify: async (_msg: { title: string; body?: string; link?: string }) => {
      // Self-host delivery sink: recorded as a journaled step; a real host wires
      // this to notifications. No-op body here keeps the workflow durable.
    },
  });

  return {
    deps,
    publish: (input) =>
      Effect.gen(function* () {
        const out = yield* runPublish(
          {
            artifactStore: deps.artifactStore,
            sandbox: deps.sandbox,
            putBlob: (hash, value) =>
              deps.store
                .putBlob(hash, value)
                .pipe(
                  Effect.mapError(
                    (c) =>
                      new PublishError({ message: String(c), stage: "project", diagnostics: [] }),
                  ),
                ),
          },
          { scope: input.scope, files: input.files, commitMessage: input.message },
        );
        yield* deps.store
          .putDescriptor("org", out.descriptor)
          .pipe(
            Effect.mapError(
              (c) => new PublishError({ message: String(c), stage: "project", diagnostics: [] }),
            ),
          );
        return out;
      }),

    getDescriptor: (scope) =>
      deps.store.getDescriptor(scope).pipe(Effect.orElseSucceed(() => null)),

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
          input.bindings,
        );
      }),

    startWorkflow: (input) =>
      Effect.gen(function* () {
        const descriptor = yield* requireDescriptor(input.scope);
        const wfDesc = descriptor.workflows.find((w) => w.name === input.workflow);
        if (!wfDesc) {
          return yield* Effect.fail(
            new PublishError({
              message: `workflow "${input.workflow}" is not published in scope "${input.scope}"`,
              stage: "project",
              diagnostics: [],
            }),
          );
        }
        const bindings = input.bindings ?? {};
        const body = workflowBody(input.scope, descriptor, wfDesc);
        return yield* deps.workflows
          .start(
            {
              scope: input.scope,
              workflow: input.workflow,
              snapshotId: descriptor.snapshotId,
              input: input.input ?? {},
              runId: input.runId,
            },
            body,
            bindingsForRunTool(input.scope, descriptor, bindings),
          )
          .pipe(
            Effect.mapError(
              (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
            ),
          );
      }),

    signalWorkflow: (input) =>
      Effect.gen(function* () {
        const run = yield* deps.workflows
          .get(input.runId)
          .pipe(
            Effect.mapError(
              (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
            ),
          );
        if (!run) {
          return yield* Effect.fail(
            new PublishError({
              message: `no run ${input.runId}`,
              stage: "project",
              diagnostics: [],
            }),
          );
        }
        const descriptor = yield* requireDescriptor(run.scope);
        const wfDesc = descriptor.workflows.find((w) => w.name === run.workflow);
        if (!wfDesc) {
          return yield* Effect.fail(
            new PublishError({
              message: `workflow ${run.workflow} gone`,
              stage: "project",
              diagnostics: [],
            }),
          );
        }
        const body = workflowBody(run.scope, descriptor, wfDesc);
        return yield* deps.workflows
          .signal(
            input.runId,
            input.event,
            input.payload,
            body,
            bindingsForRunTool(run.scope, descriptor, {}),
          )
          .pipe(
            Effect.mapError(
              (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
            ),
          );
      }),

    getRun: (runId) => deps.workflows.get(runId).pipe(Effect.orElseSucceed(() => null)),
    listRuns: (scope) =>
      deps.workflows.list({ scope }).pipe(Effect.orElseSucceed(() => [] as readonly RunView[])),
    listSteps: (runId) =>
      deps.workflows.listSteps(runId).pipe(Effect.orElseSucceed(() => [] as readonly StepView[])),

    getUiBundle: (scope, name) =>
      Effect.gen(function* () {
        const descriptor = yield* deps.store
          .getDescriptor(scope)
          .pipe(Effect.orElseSucceed(() => null));
        if (!descriptor) return null;
        const uiDesc = descriptor.ui.find((u) => u.name === name);
        if (!uiDesc) return null;
        const code = yield* deps.store
          .getBlob(`ui/${uiDesc.bundleHash}`)
          .pipe(Effect.orElseSucceed(() => null));
        if (!code) return null;
        return { code, title: uiDesc.title, maxHeight: uiDesc.maxHeight };
      }),

    subscribeLive: (scope, listener) =>
      deps.liveChannel.subscribe(scope, (event) =>
        listener({ table: event.table, version: event.version }),
      ),
  };
};

// Extract the workflow def from a compiled bundle by running it in a tiny
// module shim (Node-side, trusted: this is our own runtime, not user isolation
// for the durable interpreter — the tool HANDLERS still run in the sandbox).
// The bundle set globalThis.__artifact to the workflow def object.
const extractWorkflowDef = (
  code: string,
): { run: (steps: DurableSteps, deps: { db: unknown }) => Promise<unknown> } => {
  const g: Record<string, unknown> = {};
  const shim = {
    connection: (integration: string, opts?: { description?: string }) => ({
      __decl: "single",
      integration,
      description: opts?.description,
    }),
    connections: (integration: string) => ({ __decl: "array", integration }),
    catalog: () => ({ __decl: "catalog" }),
    defineTool: (def: unknown) => {
      g.__artifact = def;
      return def;
    },
    defineWorkflow: (def: unknown) => {
      g.__artifact = def;
      return def;
    },
  };
  const req = (id: string) => {
    if (id === "executor:app") return shim;
    if (id === "executor:ui") return {};
    if (id === "executor:ui/components") return {};
    throw new Error(`module not available: ${id}`);
  };
  const moduleObj = { exports: {} as Record<string, unknown> };
  const globalThisShim = g as unknown as typeof globalThis;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function("module", "exports", "require", "globalThis", code);
  factory(moduleObj, moduleObj.exports, req, globalThisShim);
  const def = (g.__artifact ?? moduleObj.exports.default ?? moduleObj.exports) as {
    run: (steps: DurableSteps, deps: { db: unknown }) => Promise<unknown>;
  };
  if (!def || typeof def.run !== "function") {
    throw new Error("workflow bundle did not produce a run() function");
  }
  return def;
};
