/**
 * `NodeRuntime.runMain` for a program that ends with an exit code, that ends by letting the event
 * loop drain instead of calling `process.exit()`.
 *
 * `NodeRuntime.runMain` calls `process.exit(code)` when the code is not 0. On Node 24 that can hang
 * for good: `process.exit()` shuts the V8 platform down and joins its worker threads, and a worker
 * whose concurrent compile is waiting for a garbage collection, which only the main thread can run,
 * never ends (nodejs/node#54918). A hung program shows its main thread and one V8Worker thread
 * waiting on a futex, with no DelayedTaskScheduler thread, ignores SIGTERM and outlives its parent.
 * ci-selection.spec.ts runs the CI selection as hundreds of processes, about a hundred of which
 * exit non-zero, so now and then one of its cases waited on such a process past its limit.
 *
 * Setting `process.exitCode` ends the process the way an exit code of 0 already does: the fiber's
 * end clears runMain's keep-alive timer, its scopes have closed their child processes, and the
 * process exits when nothing is left to run, disposing the isolate before the platform. The code
 * is the one `Runtime.defaultTeardown` gives.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Runtime, type Effect } from "effect";

export const runMain = <A, E>(program: Effect.Effect<A, E>) =>
  NodeRuntime.runMain(program, {
    teardown: (exit) =>
      Runtime.defaultTeardown(exit, (code) => {
        process.exitCode = code;
      }),
  });
