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
import { ToolId } from "@executor-js/sdk/core";
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
  readonly getDescription: () => Promise<string>;
};

/**
 * Wrap a Promise-style executor into the Effect shape the engine consumes.
 */
const fromPromise = <A>(try_: () => Promise<A>): Effect.Effect<A> =>
  // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: Promise executor facade has already erased the SDK typed error channel
  Effect.tryPromise({ try: try_, catch: (cause) => cause }).pipe(Effect.orDie);

type EffectInvokeOptions = Parameters<EffectExecutor["tools"]["invoke"]>[2];
type PromiseInvokeOptions = Parameters<PromiseExecutor["tools"]["invoke"]>[2];

const toPromiseInvokeOptions = (options: EffectInvokeOptions): PromiseInvokeOptions => {
  const onElicitation = options?.onElicitation;
  if (!onElicitation) return undefined;
  if (onElicitation === "accept-all") return { onElicitation };

  return {
    onElicitation: (ctx) =>
      onElicitation({
        ...ctx,
        toolId: ToolId.make(ctx.toolId),
      }),
  };
};

const wrapPromiseExecutor = (pe: PromiseExecutor): EffectExecutor => ({
  scopes: pe.scopes,
  tools: {
    invoke: (id, args, options) =>
      fromPromise(() => pe.tools.invoke(id, args, toPromiseInvokeOptions(options))),
    list: (filter) => fromPromise(() => pe.tools.list(filter)),
    schema: (id) => fromPromise(() => pe.tools.schema(id)),
    definitions: () => fromPromise(() => pe.tools.definitions()),
  },
  sources: {
    list: () => fromPromise(() => pe.sources.list()),
    remove: (input) => fromPromise(() => pe.sources.remove(input)),
    refresh: (input) => fromPromise(() => pe.sources.refresh(input)),
    detect: (url) => fromPromise(() => pe.sources.detect(url)),
    definitions: (id) => fromPromise(() => pe.sources.definitions(id)),
  },
  secrets: {
    get: (id) => fromPromise(() => pe.secrets.get(id)),
    getAtScope: (id, scope) => fromPromise(() => pe.secrets.getAtScope(id, scope)),
    status: (id) => fromPromise(() => pe.secrets.status(id)),
    set: (input) => fromPromise(() => pe.secrets.set(input)),
    remove: (input) => fromPromise(() => pe.secrets.remove(input)),
    list: () => fromPromise(() => pe.secrets.list()),
    listAll: () => fromPromise(() => pe.secrets.listAll()),
    usages: (id) => fromPromise(() => pe.secrets.usages(id)),
    providers: () => fromPromise(() => pe.secrets.providers()),
  },
  connections: {
    get: (id) => fromPromise(() => pe.connections.get(id)),
    getAtScope: (id, scope) => fromPromise(() => pe.connections.getAtScope(id, scope)),
    list: () => fromPromise(() => pe.connections.list()),
    create: (input) => fromPromise(() => pe.connections.create(input)),
    updateTokens: (input) => fromPromise(() => pe.connections.updateTokens(input)),
    setIdentityLabel: (id, label) => fromPromise(() => pe.connections.setIdentityLabel(id, label)),
    accessToken: (id) => fromPromise(() => pe.connections.accessToken(id)),
    accessTokenAtScope: (id, scope) =>
      fromPromise(() => pe.connections.accessTokenAtScope(id, scope)),
    remove: (input) => fromPromise(() => pe.connections.remove(input)),
    usages: (id) => fromPromise(() => pe.connections.usages(id)),
    providers: () => fromPromise(() => pe.connections.providers()),
  },
  credentialBindings: {
    listForSource: (input) => fromPromise(() => pe.credentialBindings.listForSource(input)),
    resolve: (input) => fromPromise(() => pe.credentialBindings.resolve(input)),
    set: (input) => fromPromise(() => pe.credentialBindings.set(input)),
    remove: (input) => fromPromise(() => pe.credentialBindings.remove(input)),
    replaceForSource: (input) => fromPromise(() => pe.credentialBindings.replaceForSource(input)),
    removeForSource: (input) => fromPromise(() => pe.credentialBindings.removeForSource(input)),
    usagesForSecret: (id) => fromPromise(() => pe.credentialBindings.usagesForSecret(id)),
    usagesForConnection: (id) => fromPromise(() => pe.credentialBindings.usagesForConnection(id)),
  },
  oauth: {
    probe: (input) => fromPromise(() => pe.oauth.probe(input)),
    start: (input) => fromPromise(() => pe.oauth.start(input)),
    complete: (input) => fromPromise(() => pe.oauth.complete(input)),
    cancel: (sessionId, tokenScope) => fromPromise(() => pe.oauth.cancel(sessionId, tokenScope)),
  },
  policies: {
    list: () => fromPromise(() => pe.policies.list()),
    create: (input) => fromPromise(() => pe.policies.create(input)),
    update: (input) => fromPromise(() => pe.policies.update(input)),
    remove: (input) => fromPromise(() => pe.policies.remove(input)),
    resolve: (id) => fromPromise(() => pe.policies.resolve(id)),
  },
  close: () => fromPromise(() => pe.close()),
});

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

export type { ExecutionResult, PausedExecution, ResumeResponse };

export { buildExecuteDescription } from "./description";
export { ExecutionToolError } from "./errors";
