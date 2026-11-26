import { Effect } from "effect";
import { createExecutor, OwnerId, type ExecutorOptions } from "@executor-js/sdk/core";

export const listApps = (options: ExecutorOptions) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(options);
    return yield* executor.apps.list({ owner: OwnerId.make("alice") });
  });
