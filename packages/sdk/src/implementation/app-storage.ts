import type { ResourceLifecycle } from "../contracts/executor.ts";
/** Configured-app data dispatch. Platform storage never holds authored rows. */
import { Effect, Result, Schema, Stream } from "effect";
import type { WorkflowHostControls } from "apps/contracts";
import { Json } from "../contracts/shared.ts";
import { HostOperationNotFound } from "apps/contracts";
import { AppDataFailed, AppDataNotFound, type AppDataInput } from "../contracts/app-data.ts";
import type { Runtime } from "../contracts/runtime.ts";
import type { ExecutorDatabase } from "./storage.ts";
import { database } from "./database.ts";
import { resolve, snapshot, type InvocationSnapshot } from "./tools.ts";
import type { makeOAuth } from "./oauth.ts";
import { ownsDatabase } from "../contracts/apps.ts";

/** Bind data calls to fresh saved app/deployment/account selections. */
export const makeAppData = (
  storage: ExecutorDatabase,
  resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
  runtime: Runtime,
  workflows?: (state: InvocationSnapshot) => WorkflowHostControls,
  lifecycle?: ResourceLifecycle,
) => {
  const db = database(storage);
  const execute = (
    kind: "query" | "mutate",
    input: AppDataInput,
    observeRevision?: (revision: number) => void,
    read: ReturnType<typeof snapshot> = snapshot(db, input),
  ) =>
    Effect.gen(function* () {
      const state = yield* read;
      const accounts = yield* resolve(state, resolveAccount, lifecycle);
      return yield* runtime[kind]({
        build: state.deployment.build,
        database: ownsDatabase(state.deployment.requirements),
        ...accounts,
        app: state.app.id,
        ...(workflows === undefined ? {} : { workflowControls: workflows(state) }),
        name: input.name,
        input: input.input,
        ...(observeRevision === undefined ? {} : { observeRevision }),
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
          : Stream.unwrap(
              Effect.sync(() => {
                let observedRevision: number | undefined;
                return Stream.tick("15 seconds").pipe(
                  Stream.mapEffect(() => snapshot(db, input)),
                  Stream.changesWith((a, b) => a.deployment.id === b.deployment.id),
                  Stream.switchMap((state) => {
                    // The deployment's first query uses the selections just read for it.
                    // Later executions reread them, so they see account and profile changes.
                    let fresh: InvocationSnapshot | undefined = state;
                    const current = Effect.suspend(() => {
                      const known = fresh;
                      fresh = undefined;
                      return known === undefined ? snapshot(db, input) : Effect.succeed(known);
                    });
                    return Stream.merge(
                      // First data does not wait for the notification connection.
                      // The initial notification is skipped only if its writes were
                      // already observed by a successful query. Setup races still reread.
                      Stream.succeed(undefined),
                      !ownsDatabase(state.deployment.requirements)
                        ? Stream.empty
                        : changes(input.app).pipe(
                            Stream.mapError(
                              () => new AppDataFailed({ app: input.app, name: input.name }),
                            ),
                          ),
                    ).pipe(
                      Stream.merge(Stream.tick("15 seconds").pipe(Stream.drop(1))),
                      Stream.filterMapEffect((revision) =>
                        typeof revision === "number" &&
                        observedRevision !== undefined &&
                        revision <= observedRevision
                          ? Effect.succeed(Result.fail(undefined))
                          : execute(
                              "query",
                              input,
                              (revision) => {
                                observedRevision = revision;
                              },
                              current,
                            ).pipe(Effect.map(Result.succeed)),
                      ),
                    );
                  }),
                  Stream.changesWith(Schema.toEquivalence(Json)),
                  Stream.zipWithIndex,
                  Stream.map(([value, revision]) => ({ value, revision })),
                );
              }),
            ),
      ).pipe(Effect.withSpan("sdk.data.subscribe")),
    query: (input: AppDataInput) => execute("query", input).pipe(Effect.withSpan("sdk.data.query")),
    mutate: (input: AppDataInput) =>
      execute("mutate", input).pipe(Effect.withSpan("sdk.data.mutate")),
  };
};
