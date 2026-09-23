/** One upstream call, with form requests forwarded to the invocation's existing elicitation capability. */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ElicitRequestSchema,
  ElicitResultSchema,
  ErrorCode,
  McpError as ProtocolError,
} from "@modelcontextprotocol/sdk/types.js";
import { Clock, Deferred, Effect, Option, Queue, Schema } from "effect";
import { ElicitationFailed, defaultElicitationLimits } from "../contracts/elicitation.ts";
import {
  mcpSdkTimerCeilingMs,
  McpError,
  McpToolResult,
  type McpToolContext,
} from "../contracts/mcp.ts";
import type { JsonObject } from "../contracts/schema.ts";
import { fromPromise } from "./authoring.ts";
import { prepareElicitation } from "./elicitation.ts";

/** Bound upstream execution time while excluding overlapping human-input waits. */
function callBudget(timeoutMs: number) {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const changes = yield* Queue.unbounded<void>();
    let remaining = timeoutMs,
      updated = clock.currentTimeMillisUnsafe(),
      waiting = 0;
    const account = () => {
      const now = clock.currentTimeMillisUnsafe();
      if (waiting === 0) remaining -= Math.max(0, now - updated);
      updated = now;
      return remaining;
    };
    return {
      waitForInput: <A, E>(input: Effect.Effect<A, E>) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            account();
            waiting++;
          }).pipe(Effect.andThen(Queue.offer(changes, undefined))),
          () => input,
          () =>
            Effect.sync(() => {
              account();
              waiting--;
            }).pipe(Effect.andThen(Queue.offer(changes, undefined))),
        ),
      expired: Effect.gen(function* () {
        while (true) {
          const left = account();
          if (waiting === 0 && left <= 0)
            return yield* new McpError({ phase: "call", reason: "timeout" });
          if (waiting > 0) yield* Queue.take(changes);
          else yield* Queue.take(changes).pipe(Effect.raceFirst(Effect.sleep(Math.max(1, left))));
        }
      }),
    };
  });
}

/** Register prompts only around tools/call, preserve metadata, and close every callback with the call. Never retries. */
export const mcpCall = (
  client: Client,
  name: string,
  input: JsonObject,
  context: McpToolContext,
  timeoutMs: number,
  failure: (phase: McpError["phase"], error: unknown) => McpError,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const budget = yield* callBudget(timeoutMs);
      const failed = yield* Deferred.make<never, ElicitationFailed>();
      const runtime = yield* Effect.context<never>();
      const callbacks = new Set<Promise<unknown>>();
      const lifetime = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) =>
          Effect.promise(async () => {
            controller.abort();
            client.removeRequestHandler("elicitation/create");
            await Promise.allSettled(callbacks);
          }),
      );
      client.setRequestHandler(ElicitRequestSchema, (request, extra) => {
        const signal = AbortSignal.any([lifetime.signal, extra.signal]);
        const interaction = Effect.gen(function* () {
          const form = yield* prepareElicitation({
            ...request.params,
            mode: request.params.mode ?? "form",
          });
          const deliver = context.elicit;
          if (deliver === undefined) return yield* new ElicitationFailed({ reason: "unavailable" });
          const answer = yield* budget
            .waitForInput(
              fromPromise(deliver)(form.request).pipe(
                Effect.mapError((error) =>
                  Option.getOrElse(
                    Schema.decodeUnknownOption(ElicitationFailed)(error),
                    () => new ElicitationFailed({ reason: "transport" }),
                  ),
                ),
                Effect.timeoutOrElse({
                  duration: defaultElicitationLimits.timeoutMs,
                  orElse: () => Effect.fail(new ElicitationFailed({ reason: "expired" })),
                }),
              ),
            )
            .pipe(Effect.withSpan("provider.mcp.elicitation"));
          return yield* form.respond(answer).pipe(
            Effect.flatMap((response) =>
              Effect.try({
                try: () => ElicitResultSchema.parse(response),
                catch: () => new ElicitationFailed({ reason: "invalid-response" }),
              }),
            ),
          );
        }).pipe(Effect.tapError((error) => Deferred.fail(failed, error)));
        const callback = Effect.runPromiseWith(runtime)(interaction, { signal }).catch(() => {
          if (!lifetime.signal.aborted)
            Effect.runSync(Deferred.fail(failed, new ElicitationFailed({ reason: "transport" })));
          // Never send a host error, credential, stack or callback exception to the upstream server.
          throw new ProtocolError(ErrorCode.InternalError, "User input could not be delivered");
        });
        callbacks.add(callback);
        return callback.finally(() => callbacks.delete(callback));
      });
      return yield* Effect.tryPromise({
        try: (signal) =>
          client.callTool({ name, arguments: input }, undefined, {
            signal: AbortSignal.any([signal, lifetime.signal]),
            timeout: mcpSdkTimerCeilingMs,
          }),
        catch: (error) => failure("call", error),
      }).pipe(
        Effect.raceFirst(Deferred.await(failed)),
        Effect.raceFirst(budget.expired),
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(McpToolResult)(result).pipe(
            Effect.mapError(() => new McpError({ phase: "call", reason: "invalid_response" })),
          ),
        ),
        Effect.tap((result) =>
          Effect.annotateCurrentSpan("mcp.tool.is_error", result.isError === true),
        ),
      );
    }),
  ).pipe(
    Effect.withSpan("provider.mcp.request", {
      kind: "client",
      attributes: {
        "rpc.system.name": "jsonrpc",
        "rpc.method": "tools/call",
        "mcp.tool.name": name,
      },
    }),
  );
