/** Vitest hooks own isolated servers and cleanup; the test deadline owns scenario work. */
import { Clock, Effect, Exit, FileSystem, Layer, Scope } from "effect";
import { beforeEach, type TestContext } from "vitest";
import { startScenario } from "../sdk/scenario.ts";
import { RuntimeLive, Target } from "./platform.ts";
import { Actors } from "./actors.ts";
import { prepareManagementApp } from "./management-app.ts";
import { SessionClients } from "./api.ts";
import { scenarios, type TestPlan } from "../test-plan.ts";

interface ScenarioLifetime {
  readonly target: typeof Target.Service;
  readonly scope: Scope.Closeable;
  readonly actors: typeof Actors.Service | undefined;
  readonly completed: (exit: Exit.Exit<unknown, unknown>) => void;
}

declare module "vitest" {
  interface TestContext {
    executorScenario?: ScenarioLifetime;
  }
}

/** Require the scenario acquired by this configuration's beforeEach hook. */
export const scenarioLifetime = (context: TestContext) => {
  if (context.executorScenario === undefined)
    throw new Error("Executor scenarios require the E2E lifecycle setup file");
  return context.executorScenario;
};

/** Register bounded native hooks without replacing Effect Vitest's test execution. */
export const installScenarioLifecycle = () =>
  beforeEach((context) => {
    const scope = Effect.runSync(Scope.make());
    let outcome: Exit.Exit<unknown, unknown> = Exit.void;
    const startedAt = Date.now();
    let readyAt: number | undefined;
    let completedAt: number | undefined;
    let save = (_finishedAt: number): Effect.Effect<void> => Effect.void;
    context.onTestFinished(() =>
      Effect.runPromise(
        Scope.close(scope, outcome).pipe(
          Effect.ensuring(Clock.currentTimeMillis.pipe(Effect.flatMap(save))),
        ),
      ),
    );
    return Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* Layer.buildWithScope(RuntimeLive, scope);
        yield* Effect.gen(function* () {
          const base = yield* Target;
          const fs = yield* FileSystem.FileSystem;
          const directory = `${base.directory}/report/lifecycle`;
          yield* fs.makeDirectory(directory, { recursive: true });
          save = (finishedAt) =>
            fs
              .writeFileString(
                `${directory}/${context.task.id}.json`,
                JSON.stringify(
                  {
                    title: context.task.name,
                    setupMs: readyAt === undefined ? finishedAt - startedAt : readyAt - startedAt,
                    scenarioMs:
                      readyAt === undefined || completedAt === undefined
                        ? null
                        : completedAt - readyAt,
                    cleanupMs: completedAt === undefined ? null : finishedAt - completedAt,
                    totalMs: finishedAt - startedAt,
                  },
                  null,
                  2,
                ),
                { mode: 0o600 },
              )
              .pipe(Effect.orDie);
          const target = yield* startScenario(base, context.task.name);
          const plan: typeof TestPlan.Type | undefined = Object.values(scenarios).find(
            (scenario) => scenario.title === context.task.name,
          );
          let actors: typeof Actors.Service | undefined;
          if (plan?.fixtures === "actors") {
            const fixtures = yield* Layer.buildWithScope(
              Actors.layer.pipe(
                Layer.provideMerge(SessionClients.layer),
                Layer.provide(Layer.succeed(Target, target)),
              ),
              scope,
            );
            const provisioned = yield* Actors.pipe(Effect.provideContext(fixtures));
            actors = provisioned;
            if (plan.managementProfiles !== undefined)
              yield* Effect.forEach(
                plan.managementProfiles,
                (role) => prepareManagementApp(provisioned[role], provisioned.organization.id),
                { concurrency: 3, discard: true },
              ).pipe(Effect.provideContext(fixtures));
          }
          readyAt = yield* Clock.currentTimeMillis;
          context.executorScenario = {
            target,
            scope,
            actors,
            completed: (exit) => {
              outcome = exit;
              completedAt = Date.now();
            },
          };
        }).pipe(Effect.provideContext(runtime), Scope.provide(scope));
      }).pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            outcome = Exit.failCause(cause);
          }),
        ),
      ),
      { signal: context.signal },
    );
  });
