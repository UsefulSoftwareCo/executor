/** Configured-app data dispatch. Platform storage never holds authored rows. */
import { Effect, Schema, Stream } from "effect";
import type { WorkflowHostControls } from "apps/contracts";
import type { AppDatabases } from "@executor-js/app-data";
import { bindAppStorage } from "./app-database.ts";
import { Json } from "../contracts/shared.ts";
import { HostOperationNotFound } from "apps/contracts";
import { AppDataFailed, AppDataNotFound, type AppDataInput } from "../contracts/app-data.ts";
import type { Runtime } from "../contracts/runtime.ts";
import type { ExecutorDatabase } from "./storage.ts";
import { database } from "./database.ts";
import { resolve, snapshot } from "./tools.ts";
import type { makeOAuth } from "./oauth.ts";

/** Bind data calls to fresh saved app/deployment/account selections. */
export const makeAppData = (
  storage: ExecutorDatabase,
  resolveAccount: ReturnType<typeof makeOAuth>["resolve"],
  runtime: Runtime,
  appStorage?: AppDatabases,
  workflows?: (app: import("../contracts/shared.ts").AppId) => WorkflowHostControls,
) => {
  const db = database(storage);
  const execute = (kind: "query" | "mutate", input: AppDataInput) =>
    Effect.gen(function* () {
      const state = yield* snapshot(db, input);
      const accounts = yield* resolve(state, resolveAccount);
      return yield* runtime[kind]({
        build: state.deployment.build,
        ...accounts,
        app: state.app.id,
        ...(yield* bindAppStorage(appStorage, state.app.id)),
        ...(workflows === undefined ? {} : { workflowControls: workflows(state.app.id) }),
        name: input.name,
        input: input.input,
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(HostOperationNotFound)(error)
            ? new AppDataNotFound({ app: input.app, name: input.name })
            : new AppDataFailed({ app: input.app, name: input.name }),
        ),
      );
    });
  const changes = runtime.changes;
  return {
    subscribe: (input: AppDataInput) =>
      Effect.succeed(
        changes === undefined
          ? storage.reactivity.subscribe(execute("query", input))
          : Stream.tick("15 seconds").pipe(
              Stream.mapEffect(() => snapshot(db, input)),
              Stream.changesWith((a, b) => a.deployment.id === b.deployment.id),
              Stream.switchMap((state) =>
                Stream.merge(
                  // First data does not wait for the notification connection.
                  // Its initial ready event reads again after registration, so
                  // a write during setup cannot be missed.
                  Stream.succeed(undefined),
                  state.deployment.requirements.database === undefined
                    ? Stream.empty
                    : changes(input.app).pipe(
                        Stream.mapError(
                          () => new AppDataFailed({ app: input.app, name: input.name }),
                        ),
                      ),
                ).pipe(Stream.merge(Stream.tick("15 seconds").pipe(Stream.drop(1)))),
              ),
              Stream.mapEffect(() => execute("query", input)),
              Stream.changesWith(Schema.toEquivalence(Json)),
              Stream.zipWithIndex,
              Stream.map(([value, revision]) => ({ value, revision })),
            ),
      ).pipe(Effect.withSpan("sdk.data.subscribe")),
    query: (input: AppDataInput) => execute("query", input).pipe(Effect.withSpan("sdk.data.query")),
    mutate: (input: AppDataInput) =>
      execute("mutate", input).pipe(Effect.withSpan("sdk.data.mutate")),
  };
};
