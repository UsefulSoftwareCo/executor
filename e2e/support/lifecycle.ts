/** Vitest hooks own isolated servers and cleanup; the test deadline owns scenario work. */
import { Clock, Effect, Exit, FileSystem, Layer, Scope } from "effect";
import { randomBytes } from "node:crypto";
import { beforeEach, type TestContext } from "vitest";
import { prepareScenario, startScenario } from "../sdk/scenario.ts";
import { createScenario } from "../sdk/session.ts";
import { RuntimeLive, Target } from "./platform.ts";
import { Actors } from "./actors.ts";
import { prepareManagementApp } from "./management-app.ts";
import { SessionClients } from "./api.ts";
import { scenarios, type TestPlan } from "../test-plan.ts";

/** An extra Testing SDK scenario acquired by setup. The test may close its scope early. */
export interface SdkScenarioFixture {
  readonly scenario: Effect.Success<ReturnType<typeof createScenario>>;
  readonly scope: Scope.Closeable;
}

interface ScenarioLifetime {
  readonly target: typeof Target.Service;
  readonly scope: Scope.Closeable;
  readonly actors: typeof Actors.Service | undefined;
  readonly sdkScenarios: ReadonlyArray<SdkScenarioFixture>;
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

// Vitest's beforeEach and onTestFinished hooks are Promise APIs; this acquires each scenario's runtime.
/* oxlint-disable executor/no-manual-effect-runtime-in-tests */
/** Register bounded native hooks without replacing Effect Vitest's test execution. */
export const installScenarioLifecycle = () =>
  beforeEach((context) => {
    const scope = Effect.runSync(Scope.make());
    let outcome: Exit.Exit<unknown, unknown> = Exit.void;
    const startedAt = Date.now();
    let readyAt: number | undefined;
    let completedAt: number | undefined;
    let save = (_finishedAt: number): Effect.Effect<void> => Effect.void;
    let discard: Effect.Effect<void> = Effect.void;
    // A passing scenario's server data is never read again; failures keep theirs for diagnosis.
    context.onTestFinished(({ task }) =>
      Effect.runPromise(
        Scope.close(scope, outcome).pipe(
          Effect.ensuring(Clock.currentTimeMillis.pipe(Effect.flatMap(save))),
          Effect.andThen(
            Effect.suspend(() => (task.result?.state === "pass" ? discard : Effect.void)),
          ),
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
          const plan: typeof TestPlan.Type | undefined = Object.values(scenarios).find(
            (scenario) => scenario.title === context.task.name,
          );
          const primary = Effect.gen(function* () {
            // The CLI test exercises creation and removal itself. An unused outer
            // server would compete with the server whose lifecycle it verifies.
            const target = yield* plan?.fixtures === "cli"
              ? prepareScenario(base, context.task.name)
              : startScenario(base, context.task.name, undefined, plan?.serverEnvironment);
            if (plan?.fixtures !== "actors") return { target, actors: undefined };
            const fixtures = yield* Layer.buildWithScope(
              Actors.layer.pipe(
                Layer.provideMerge(SessionClients.layer),
                Layer.provide(Layer.succeed(Target, target)),
              ),
              scope,
            );
            const actors = yield* Actors.pipe(Effect.provideContext(fixtures));
            if (plan.managementApps !== undefined)
              yield* Effect.forEach(
                plan.managementApps,
                (role) => prepareManagementApp(actors[role], actors.organization.id),
                { concurrency: 3, discard: true },
              ).pipe(Effect.provideContext(fixtures));
            return { target, actors };
          });
          // Each extra scenario owns a child scope, so a test can end it while the case continues.
          const extra = Effect.forEach(
            plan?.sdkScenarios ?? [],
            (label) =>
              Effect.gen(function* () {
                const child = yield* Scope.fork(scope);
                const scenario = yield* createScenario(base, {
                  id: randomBytes(16).toString("hex"),
                  label,
                }).pipe(Scope.provide(child));
                return { scenario, scope: child };
              }),
            { concurrency: 2 },
          );
          const [{ target, actors }, sdkScenarios] = yield* Effect.all([primary, extra], {
            concurrency: 2,
          });
          // Cloud scenarios share the run directory; only isolated scenario directories are discarded.
          const directories = [target, ...sdkScenarios.map(({ scenario }) => scenario.target)]
            .map(({ directory }) => directory)
            .filter((directory) => directory !== base.directory);
          discard = Effect.forEach(
            directories,
            (directory) => fs.remove(directory, { recursive: true }),
            { discard: true },
          ).pipe(Effect.orDie);
          readyAt = yield* Clock.currentTimeMillis;
          context.executorScenario = {
            target,
            scope,
            actors,
            sdkScenarios,
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
/* oxlint-enable executor/no-manual-effect-runtime-in-tests */
