// ---------------------------------------------------------------------------
// @executor-js/execution/promise — Promise-native surface for the execution
// engine.
// ---------------------------------------------------------------------------
//
// `engine.ts` is Effect-native; this module runs each method with
// `Effect.runPromise` at the boundary so hosts that can't compose Effects
// (the MCP SDK tool handlers, plain async call sites) can still use the
// engine. Callers already inside an Effect context should import directly
// from `@executor-js/execution` to keep trace context intact.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type * as Cause from "effect/Cause";

import type {
  ElicitationContext,
  ElicitationResponse,
  Executor as EffectExecutor,
} from "@executor-js/sdk/core";
import type { Executor as PromiseExecutor } from "@executor-js/sdk/promise";
import type { CodeExecutionError, CodeExecutor, ExecuteResult } from "@executor-js/codemode-core";

import {
  createExecutionEngine as createEffectExecutionEngine,
  type ExecutionEngine as EffectExecutionEngine,
  type ExecutionResult,
  type PausedExecution,
  type ResumeResponse,
} from "./engine";

export type ElicitationHandler = (ctx: ElicitationContext) => Promise<ElicitationResponse>;

export type ExecutionEngineConfig<E extends Cause.YieldableError = CodeExecutionError> = {
  readonly executor: PromiseExecutor;
  readonly codeExecutor: CodeExecutor<E>;
};

export type ExecutionEngine = {
  readonly execute: (
    code: string,
    options: { readonly onElicitation: ElicitationHandler },
  ) => Promise<ExecuteResult>;
  readonly executeWithPause: (code: string) => Promise<ExecutionResult>;
  readonly resume: (
    executionId: string,
    response: ResumeResponse,
  ) => Promise<ExecutionResult | null>;
  readonly getPausedExecution: (executionId: string) => Promise<PausedExecution | null>;
  readonly getDescription: () => Promise<string>;
};

/**
 * Wrap a Promise thunk into the Effect shape the engine consumes. The Promise
 * executor façade has already erased the SDK typed error channel (rejections
 * carry the tagged error as the rejected value), so we re-orphan it as a defect.
 */
const fromPromise = <A>(try_: () => Promise<A>): Effect.Effect<A> =>
  // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: Promise executor facade has already erased the SDK typed error channel
  Effect.tryPromise({ try: try_, catch: (cause) => cause }).pipe(Effect.orDie);

// ---------------------------------------------------------------------------
// wrapPromiseExecutor — adapt the v2 Promise `Executor` back into an Effect
// `Executor` so the Effect-native engine can drive it. The engine only touches
// `execute`, `tools.list`, `tools.schema`, and `integrations.list`; we wrap
// those and orphan the typed error channel. The remaining surface is filled
// with the same Promise-backed wrappers where the shapes line up so the cast to
// `EffectExecutor` is structurally honest for the methods callers can reach.
// ---------------------------------------------------------------------------

const wrapPromiseExecutor = (pe: PromiseExecutor): EffectExecutor => {
  const adapter = {
    integrations: {
      list: () => fromPromise(() => pe.integrations.list()),
      get: (slug: Parameters<PromiseExecutor["integrations"]["get"]>[0]) =>
        fromPromise(() => pe.integrations.get(slug)),
      update: (
        slug: Parameters<PromiseExecutor["integrations"]["update"]>[0],
        patch: Parameters<PromiseExecutor["integrations"]["update"]>[1],
      ) => fromPromise(() => pe.integrations.update(slug, patch)),
      remove: (slug: Parameters<PromiseExecutor["integrations"]["remove"]>[0]) =>
        fromPromise(() => pe.integrations.remove(slug)),
      detect: (url: Parameters<PromiseExecutor["integrations"]["detect"]>[0]) =>
        fromPromise(() => pe.integrations.detect(url)),
    },
    connections: {
      create: (input: Parameters<PromiseExecutor["connections"]["create"]>[0]) =>
        fromPromise(() => pe.connections.create(input)),
      list: (filter?: Parameters<PromiseExecutor["connections"]["list"]>[0]) =>
        fromPromise(() => pe.connections.list(filter)),
      get: (ref: Parameters<PromiseExecutor["connections"]["get"]>[0]) =>
        fromPromise(() => pe.connections.get(ref)),
      update: (
        ref: Parameters<PromiseExecutor["connections"]["update"]>[0],
        input: Parameters<PromiseExecutor["connections"]["update"]>[1],
      ) => fromPromise(() => pe.connections.update(ref, input)),
      remove: (ref: Parameters<PromiseExecutor["connections"]["remove"]>[0]) =>
        fromPromise(() => pe.connections.remove(ref)),
      refresh: (ref: Parameters<PromiseExecutor["connections"]["refresh"]>[0]) =>
        fromPromise(() => pe.connections.refresh(ref)),
    },
    tools: {
      list: (filter?: Parameters<PromiseExecutor["tools"]["list"]>[0]) =>
        fromPromise(() => pe.tools.list(filter)),
      schema: (address: Parameters<PromiseExecutor["tools"]["schema"]>[0]) =>
        fromPromise(() => pe.tools.schema(address)),
    },
    providers: {
      list: () => fromPromise(() => pe.providers.list()),
      items: (key: Parameters<PromiseExecutor["providers"]["items"]>[0]) =>
        fromPromise(() => pe.providers.items(key)),
    },
    policies: {
      list: () => fromPromise(() => pe.policies.list()),
      create: (input: Parameters<PromiseExecutor["policies"]["create"]>[0]) =>
        fromPromise(() => pe.policies.create(input)),
      update: (input: Parameters<PromiseExecutor["policies"]["update"]>[0]) =>
        fromPromise(() => pe.policies.update(input)),
      remove: (input: Parameters<PromiseExecutor["policies"]["remove"]>[0]) =>
        fromPromise(() => pe.policies.remove(input)),
      resolve: (address: Parameters<PromiseExecutor["policies"]["resolve"]>[0]) =>
        fromPromise(() => pe.policies.resolve(address)),
    },
    execute: (
      address: Parameters<PromiseExecutor["execute"]>[0],
      args: Parameters<PromiseExecutor["execute"]>[1],
      options?: Parameters<PromiseExecutor["execute"]>[2],
    ) => fromPromise(() => pe.execute(address, args, options)),
    close: () => fromPromise(() => pe.close()),
  };
  // oxlint-disable-next-line executor/no-double-cast -- boundary: the Promise executor mirrors the Effect surface structurally; the engine only reaches execute/tools/integrations, all wrapped here
  return adapter as unknown as EffectExecutor;
};

/**
 * Promise-wrap an Effect-native `ExecutionEngine` (from `./engine`).
 * Exposed separately so callers that already hold an Effect engine
 * (apps/cloud's execution-stack composes both) can convert it for hosts
 * that need the Promise surface (host-mcp).
 */
export const toPromiseExecutionEngine = <E extends Cause.YieldableError>(
  engine: EffectExecutionEngine<E>,
): ExecutionEngine => ({
  execute: (code, options) =>
    Effect.runPromise(
      engine.execute(code, {
        onElicitation: (ctx) =>
          // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: host-provided Promise elicitation callback is outside the Effect error model
          Effect.tryPromise(() => options.onElicitation(ctx)).pipe(Effect.orDie),
      }),
    ),
  executeWithPause: (code) => Effect.runPromise(engine.executeWithPause(code)),
  resume: (executionId, response) => Effect.runPromise(engine.resume(executionId, response)),
  getPausedExecution: (executionId) => Effect.runPromise(engine.getPausedExecution(executionId)),
  getDescription: () => Effect.runPromise(engine.getDescription),
});

export const createExecutionEngine = <E extends Cause.YieldableError = CodeExecutionError>(
  config: ExecutionEngineConfig<E>,
): ExecutionEngine =>
  toPromiseExecutionEngine(
    createEffectExecutionEngine({
      executor: wrapPromiseExecutor(config.executor),
      codeExecutor: config.codeExecutor,
    }),
  );

// ---------------------------------------------------------------------------
// Re-exports — plain types/helpers that don't carry Effect signatures.
// ---------------------------------------------------------------------------

export { formatExecuteResult, formatPausedExecution } from "./engine";

export type { ExecutionResult, PausedExecution, ResumeResponse, ExecuteResult };

export { buildExecuteDescription } from "./description";
export { ExecutionToolError } from "./errors";
