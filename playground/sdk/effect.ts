/** Native SDK calls compose in the host's Effect fiber. The host supplies Crypto and owns its storage. */
import { Effect } from "effect";
import { createExecutor, OwnerId, type ExecutorOptions } from "@executor-js/sdk/core";

/** Read an owner's configured apps through the public Effect SDK. No work starts until this effect runs. */
export const listApps = (options: ExecutorOptions) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(options);
    return yield* executor.apps.list({ owner: OwnerId.make("alice") });
  });
