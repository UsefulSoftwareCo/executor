/** Caller-owned Effect SQL driver and one reactive storage handle shared by SDK clients. */
import {
  makeExecutorStorage,
  AppRequirements,
  StoredApp,
  StoredDeployment,
} from "@executor-js/sdk";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Effect, Schema } from "effect";

/** Initialize SQLite, commit an app, and close the driver with the enclosing scope. */
export const storageWalkthrough = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const storage = yield* makeExecutorStorage({ provider: "postgresql" });
        yield* storage.migrate;
        const orm = storage.orm("4.0.0");
        const createdAt = new Date("2026-01-01T00:00:00.000Z");
        const deployment = yield* Schema.decodeUnknownEffect(StoredDeployment)({
          id: "dpl_example",
          code: "code_example",
          owner: "example-publisher",
          sourceCommit: "a".repeat(40),
          fileCount: 1,
          build: "bld_example",
          requirements: { accounts: {} },
          createdAt,
        });
        const app = yield* Schema.decodeUnknownEffect(StoredApp)({
          id: "app_example",
          code: deployment.code,
          owner: "example-user",
          name: "Example",
          activeDeployment: deployment.id,
          accounts: {},
          createdAt,
        });
        yield* orm.transaction(
          Effect.gen(function* () {
            yield* orm.create("deployments", {
              ...deployment,
              requirements: yield* Schema.encodeEffect(Schema.toCodecJson(AppRequirements))(
                deployment.requirements,
              ),
            });
            yield* orm.create("apps", app);
          }),
        );
        return yield* orm.findFirst("apps", { where: (b) => b("id", "=", app.id) });
      }).pipe(Effect.provide(pgliteLayer())),
    ),
  );
