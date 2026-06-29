// ---------------------------------------------------------------------------
// Shared execution stack — turn a (user, org) into a runnable executor + engine.
//
// Cloud and self-host both had an identical `makeExecutionStack`:
//   createScopedExecutor -> createExecutionEngine({ executor, codeExecutor }) ->
//   { executor, engine }
// differing only in (a) the code substrate (cloud's Cloudflare dynamic-worker vs
// self-host's in-process QuickJS) and (b) cloud's usage-metering decorator
// (an app-only billing overlay), absent on self-host.
//
// This factory owns the common body. The two differences are injected:
//   - `CodeExecutorProvider` — the `codeExecutor` value. Cloud's Layer wraps
//     `makeDynamicWorkerExecutor({ loader: env.LOADER })`; self-host's wraps
//     `makeQuickJsExecutor()`.
//   - `EngineDecorator` — `decorate(engine) => engine`. Cloud's app layer applies
//     a usage-metering overlay; the default Layer is a no-op (self-host, local,
//     tests, and cloud's non-metering MCP session path).
//
// The per-(user, org) executor itself comes from `makeScopedExecutor` (sdk),
// which reads the DB handle / plugins / host config from its own seams. This
// lives in `@executor-js/api` because it is the only package that depends on
// both `@executor-js/sdk` (for `makeScopedExecutor`) and `@executor-js/execution`
// (for `createExecutionEngine`).
// ---------------------------------------------------------------------------

import { Context, Effect, Layer } from "effect";
import type * as Cause from "effect/Cause";

import type { McpResource } from "@executor-js/host-mcp";
import type { AnyPlugin, Executor, StorageFailure } from "@executor-js/sdk";
import {
  createExecutionEngine,
  type ExecutionEngine,
  type ExecutionEngineConfig,
} from "@executor-js/execution";

import { DbProvider } from "./executor-fuma-db";
import { HostConfig, PluginsProvider, makeScopedExecutor } from "./scoped-executor";

// ---------------------------------------------------------------------------
// CodeExecutorProvider seam — the host's code-execution substrate. Typed to the
// widened `Cause.YieldableError` channel (matching `ExecutionEngineService`) so
// a runtime-specific tagged error (DynamicWorkerExecutionError, QuickJS errors)
// assigns structurally.
// ---------------------------------------------------------------------------

export type CodeExecutor = ExecutionEngineConfig<Cause.YieldableError>["codeExecutor"];

export class CodeExecutorProvider extends Context.Service<CodeExecutorProvider, CodeExecutor>()(
  "@executor-js/api/CodeExecutorProvider",
) {}

// ---------------------------------------------------------------------------
// EngineDecorator seam — wrap the freshly built engine (e.g. with usage
// metering). `decorate` receives the same `(accountId, organizationId,
// organizationName)` identity the stack was built for, so a host can bind the
// decorator to the org (cloud's per-org usage metering needs the org id). The
// default Layer is a no-op so hosts that do not decorate (self-host, local,
// tests) get an identity transform for free.
// ---------------------------------------------------------------------------

export interface EngineStackIdentity {
  readonly accountId: string;
  readonly organizationId: string;
  readonly organizationName: string;
}

export interface EngineDecoratorShape {
  readonly decorate: <E extends Cause.YieldableError>(
    engine: ExecutionEngine<E>,
    identity: EngineStackIdentity,
  ) => ExecutionEngine<E>;
}

export class EngineDecorator extends Context.Service<EngineDecorator, EngineDecoratorShape>()(
  "@executor-js/api/EngineDecorator",
) {}

/** No-op decorator: the engine passes through unchanged. */
export const EngineDecoratorNoop: Layer.Layer<EngineDecorator> = Layer.succeed(EngineDecorator)({
  decorate: (engine) => engine,
});

// ---------------------------------------------------------------------------
// makeExecutionStack — shared (user, org) -> { executor, engine }.
//
// Reads `makeScopedExecutor` (sdk), the code substrate from
// `CodeExecutorProvider`, and the engine wrap from `EngineDecorator`. The
// returned engine error channel is widened to `Cause.YieldableError`, matching
// `ExecutionEngineService` and the runtime-specific code executors.
// ---------------------------------------------------------------------------

export const makeExecutionStack = <
  const TPlugins extends readonly AnyPlugin[] = readonly AnyPlugin[],
>(
  accountId: string,
  organizationId: string,
  organizationName: string,
  options?: { readonly mcpResource?: McpResource },
): Effect.Effect<
  { readonly executor: Executor<TPlugins>; readonly engine: ExecutionEngine<Cause.YieldableError> },
  StorageFailure,
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator
> =>
  Effect.gen(function* () {
    const executor = yield* makeScopedExecutor<TPlugins>(
      accountId,
      organizationId,
      organizationName,
      { plugins: { mcpResource: options?.mcpResource } },
    );
    const codeExecutor = yield* CodeExecutorProvider;
    const { decorate } = yield* EngineDecorator;
    const engine = decorate(createExecutionEngine({ executor, codeExecutor }), {
      accountId,
      organizationId,
      organizationName,
    });
    return { executor, engine };
  });
