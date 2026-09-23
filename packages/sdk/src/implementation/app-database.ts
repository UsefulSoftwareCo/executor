/** Bind a configured app before crossing the Promise runtime boundary. */
import type { AppDatabases } from "@executor-js/app-data";
import type { AppStorage } from "apps/contracts";
import { Effect } from "effect";
import type { AppId } from "../contracts/shared.ts";

/** Preserve live dependency tracking across authored callbacks; callers cannot select another app partition. */
export const bindAppStorage = (
  databases: AppDatabases | undefined,
  app: AppId,
): Effect.Effect<{ readonly storage?: AppStorage }> =>
  Effect.gen(function* () {
    if (databases === undefined) return {};
    const context = yield* Effect.context<never>();
    return {
      storage: {
        read: (schema, work) =>
          databases.read(app, schema, work).pipe(Effect.provideContext(context)),
        mutate: (schema, work) =>
          databases.mutate(app, schema, work).pipe(Effect.provideContext(context)),
      } satisfies AppStorage,
    };
  });
