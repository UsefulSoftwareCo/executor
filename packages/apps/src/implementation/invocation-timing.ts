/**
 * Divide a tool invocation's time, on its own isolate's clock, by who the work belonged to:
 * Executor, the app's authored code, upstream providers, or a person answering an elicitation.
 * Each boundary declares its owner where the work starts (see `owned`); the invocation's own span is
 * Executor's. The host adds the other isolates' parts.
 */
import { Effect } from "effect";
import { makeOwnershipAccounting, measuredSpan } from "@executor-js/telemetry";
import { InvocationTimingSink } from "../contracts/host.ts";

/** The span `makeElicit` opens while a person answers. */
export const elicitationWaitSpan = "app.elicitation.wait";
/** The span around each workflow control an app calls, which Executor answers. */
export const workflowControlSpan = "app.workflow.control";

/**
 * Run a tool operation in its `app.<operation>` span and time it from the span's own start to its
 * own end. The span records each part, and the isolated handler returns them to the host.
 */
export const timedInvocation =
  (operation: "call" | "query" | "mutate") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const report = yield* InvocationTimingSink;
      return yield* effect.pipe(
        measuredSpan(`app.${operation}`, {}, (start) => {
          const accounting = makeOwnershipAccounting(start, "executor");
          return {
            around: accounting.observe,
            end: (end, span) => {
              const spent = accounting.read(end);
              report({
                elapsedMs: Number(end - start) / 1_000_000,
                upstreamMs: spent.upstream,
                elicitationMs: spent.person,
                authoredMs: spent.app,
              });
              span.attribute("executor.upstream.wait_ms", spent.upstream);
              span.attribute("executor.elicitation.wait_ms", spent.person);
              span.attribute("executor.authored_ms", spent.app);
              span.attribute("executor.overhead_ms", spent.executor);
            },
          };
        }),
      );
    });
