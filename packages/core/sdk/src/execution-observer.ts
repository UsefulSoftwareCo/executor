import { Context, Data, Effect, Schema } from "effect";
import * as Cause from "effect/Cause";

import type { ElicitationContext, ElicitationResponse } from "./elicitation";
import type { AnyPlugin, OwnerBinding, PluginExtensions } from "./plugin";

/* The execution-observer contract: a pull-model lifecycle stream the engine
 * emits as it runs code. Plugins opt in via `plugin.runtime.executionObserver`
 * and receive every event; sinks (history, metrics, tracing) are built on top.
 * Emission is dispatched to all registered observers with per-observer error
 * logging, so an observer can never break an execution. */

export const ExecutionId = Schema.String.pipe(Schema.brand("ExecutionId"));
export type ExecutionId = typeof ExecutionId.Type;

export const ExecutionToolCallId = Schema.String.pipe(Schema.brand("ExecutionToolCallId"));
export type ExecutionToolCallId = typeof ExecutionToolCallId.Type;

export const ExecutionInteractionId = Schema.String.pipe(Schema.brand("ExecutionInteractionId"));
export type ExecutionInteractionId = typeof ExecutionInteractionId.Type;

export type ExecutionTrigger = {
  readonly kind: string;
  readonly metadata?: Record<string, unknown>;
};

export type ToolCallStatus = "completed" | "failed";
export type InteractionStatus = "accepted" | "declined" | "cancelled" | "failed";
export type ExecutionStatus = "completed" | "failed";

export class ExecutionStarted extends Data.TaggedClass("ExecutionStarted")<{
  readonly executionId: ExecutionId;
  readonly owner: OwnerBinding;
  readonly code: string;
  readonly trigger?: ExecutionTrigger;
  readonly startedAt: Date;
}> {}

export class ToolCallStarted extends Data.TaggedClass("ToolCallStarted")<{
  readonly executionId: ExecutionId;
  readonly toolCallId: ExecutionToolCallId;
  readonly owner: OwnerBinding;
  readonly path: string;
  readonly args: unknown;
  readonly startedAt: Date;
}> {}

export class ToolCallFinished extends Data.TaggedClass("ToolCallFinished")<{
  readonly executionId: ExecutionId;
  readonly toolCallId: ExecutionToolCallId;
  readonly owner: OwnerBinding;
  readonly path: string;
  readonly status: ToolCallStatus;
  readonly result?: unknown;
  readonly error?: string;
  readonly completedAt: Date;
}> {}

export class InteractionStarted extends Data.TaggedClass("InteractionStarted")<{
  readonly executionId: ExecutionId;
  readonly interactionId: ExecutionInteractionId;
  readonly owner: OwnerBinding;
  readonly context: ElicitationContext;
  readonly startedAt: Date;
}> {}

export class InteractionResolved extends Data.TaggedClass("InteractionResolved")<{
  readonly executionId: ExecutionId;
  readonly interactionId: ExecutionInteractionId;
  readonly owner: OwnerBinding;
  readonly status: InteractionStatus;
  readonly response?: ElicitationResponse;
  readonly error?: string;
  readonly completedAt: Date;
}> {}

export class ExecutionFinished extends Data.TaggedClass("ExecutionFinished")<{
  readonly executionId: ExecutionId;
  readonly owner: OwnerBinding;
  readonly status: ExecutionStatus;
  readonly result?: unknown;
  readonly error?: string;
  readonly logs?: readonly string[];
  readonly completedAt: Date;
}> {}

export type ExecutionEvent =
  | ExecutionStarted
  | ToolCallStarted
  | ToolCallFinished
  | InteractionStarted
  | InteractionResolved
  | ExecutionFinished;

export interface ExecutionObserver<E = never> {
  readonly handle: (event: ExecutionEvent) => Effect.Effect<void, E>;
}

export const noopExecutionObserver: ExecutionObserver = {
  handle: () => Effect.void,
};

const currentExecutionObserver = Context.Reference<ExecutionObserver>(
  "@executor-js/sdk/ExecutionObserver",
  { defaultValue: () => noopExecutionObserver },
);

type ExecutionEventName = ExecutionEvent["_tag"];

const executionEventName = (event: ExecutionEvent): ExecutionEventName => {
  // oxlint-disable-next-line executor/no-manual-tag-check -- boundary: logging uses the Data.TaggedClass discriminant as an event name
  return event._tag;
};

const logExecutionObserverFailure = (
  event: ExecutionEvent,
  cause: Cause.Cause<unknown>,
  pluginId?: string,
): Effect.Effect<void> =>
  Effect.logWarning("execution observer failed", {
    cause: Cause.pretty(cause),
    event: executionEventName(event),
    ...(pluginId ? { pluginId } : {}),
  });

const handleExecutionObserverCause = (
  event: ExecutionEvent,
  cause: Cause.Cause<unknown>,
  pluginId?: string,
): Effect.Effect<void> =>
  Cause.hasInterrupts(cause)
    ? Effect.interrupt
    : logExecutionObserverFailure(event, cause, pluginId);

/** Emit an execution lifecycle event to the observer installed in the current
 *  Effect context. Defaults to a no-op when no observer is installed. */
export const emitExecutionEvent = (event: ExecutionEvent): Effect.Effect<void> =>
  Effect.service(currentExecutionObserver).pipe(
    Effect.flatMap((observer) => observer.handle(event)),
  );

/** Install an execution observer for the scoped Effect. Non-interrupt observer
 *  failures are logged and isolated; interrupt causes still propagate as
 *  cancellation. */
export const withExecutionObserver =
  (observer: ExecutionObserver<unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.provideService(currentExecutionObserver, {
        handle: (event) =>
          observer
            .handle(event)
            .pipe(Effect.catchCause((cause) => handleExecutionObserverCause(event, cause))),
      }),
    );

/** Collect every plugin's `runtime.executionObserver` and fan each event to
 *  all of them, logging per-observer errors. Returns the no-op observer when no
 *  plugin registers one, the common opt-out case. */
export const composeExecutionObservers = <TPlugins extends readonly AnyPlugin[]>(
  plugins: TPlugins,
  extensions: PluginExtensions<TPlugins>,
): ExecutionObserver => {
  const observers: { readonly pluginId: string; readonly observer: ExecutionObserver<unknown> }[] =
    [];

  for (const plugin of plugins) {
    const observer = plugin.runtime?.executionObserver?.(
      extensions[plugin.id as keyof PluginExtensions<TPlugins>] as never,
    );
    if (observer) {
      observers.push({ pluginId: plugin.id, observer });
    }
  }

  if (observers.length === 0) {
    return noopExecutionObserver;
  }

  return {
    handle: (event) =>
      Effect.forEach(
        observers,
        ({ pluginId, observer }) =>
          observer
            .handle(event)
            .pipe(
              Effect.catchCause((cause) => handleExecutionObserverCause(event, cause, pluginId)),
            ),
        // Preserve plugin order so observers see deterministic sequencing.
        { discard: true },
      ),
  };
};
