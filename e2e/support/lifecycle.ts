import * as NodeServices from "@effect/platform-node/NodeServices";
import { Clock, Config, Effect, Exit, FileSystem, Layer, Option, Path, Scope } from "effect";
import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, type TestContext } from "vitest";
import { prepareScenario, startScenario } from "../sdk/scenario.ts";
import { createScenario } from "../sdk/session.ts";
import { RuntimeLive, Target } from "./platform.ts";
import { Actors } from "./actors.ts";
import { prepareManagementApp } from "./management-app.ts";
import { prepareOrganization } from "./organization-provisioning.ts";
import { SessionClients } from "./api.ts";
import { scenarios, type TestPlan } from "../test-plan.ts";
import { saveLostRequests } from "../lost-requests.ts";
import {
  configureLostConnections,
  takeAllLostRequests,
  forgetStageRequests,
  takeLostRequests,
  unsentNote,
} from "./lost-connections.ts";
import { targetHosts } from "./role-hosts.ts";
import { machineWorkMs, referenceMachineWorkMs, timeoutLine } from "./machine-speed.ts";
import { hookTimeoutMs } from "../timeouts.ts";

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

export const scenarioLifetime = (context: TestContext) => {
  if (context.executorScenario === undefined)
    throw new Error("Executor scenarios require the E2E lifecycle setup file");
  return context.executorScenario;
};

/* oxlint-disable executor/no-manual-effect-runtime-in-tests */
export const installScenarioLifecycle = () =>
  beforeEach((context) => {
    const scope = Effect.runSync(Scope.make());
    let outcome: Exit.Exit<unknown, unknown> = Exit.void;
    const startedAt = Date.now();
    let readyAt: number | undefined;
    let completedAt: number | undefined;
    let provisioningMs: number | null = null;
    let save = (_finishedAt: number): Effect.Effect<void> => Effect.void;
    let finished = false;
    context.onTestFailed(({ task }) => {
      const note = unsentNote(task.name);
      const first = task.result?.errors?.[0];
      if (note === "" || first === undefined) return;
      const original = first.message;
      first.message = `${original}; ${note}`;
      if (first.stack) first.stack = first.stack.replace(original, first.message);
    });
    let timing: Record<string, unknown> = {};
    let discard: Effect.Effect<void> = Effect.void;
    context.onTestFinished(({ task }) => {
      finished = true;
      timing = { timeoutMs: task.timeout, hookTimeoutMs };
      const timedOut = (task.result?.errors ?? []).flatMap((error) => {
        const bound = /^(Test|Hook) timed out in (\d+)ms/.exec(error.message ?? "");
        return bound ? [{ error, kind: bound[1], boundMs: Number(bound[2]) }] : [];
      });
      if (timedOut.length > 0) {
        const machineMs = machineWorkMs();
        const lines = timedOut.map(({ error, kind, boundMs }) => {
          const line = `${kind} ${timeoutLine(boundMs, boundMs, machineMs)}`;
          const original = error.message;
          error.message = `${line}\n${original}`;
          if (error.stack) error.stack = error.stack.replace(original, error.message);
          return line;
        });
        timing = { ...timing, timedOut: lines, machineMs, referenceMachineWorkMs };
        console.error(lines.join("\n"));
      }
      return Effect.runPromise(
        Scope.close(scope, outcome).pipe(
          Effect.ensuring(Clock.currentTimeMillis.pipe(Effect.flatMap(save))),
          Effect.ensuring(Effect.sync(() => forgetStageRequests(task.name))),
          Effect.andThen(
            Effect.suspend(() => (task.result?.state === "pass" ? discard : Effect.void)),
          ),
        ),
      );
    });
    return Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* Layer.buildWithScope(RuntimeLive, scope);
        yield* Effect.gen(function* () {
          const base = yield* Target;
          const fs = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const directory = `${base.directory}/report/lifecycle`;
          yield* fs.makeDirectory(directory, { recursive: true });
          configureLostConnections({
            origins: Object.values(targetHosts(base)),
            deadline: () =>
              finished || context.task.timeout <= 0 ? undefined : startedAt + context.task.timeout,
          });
          save = (finishedAt) =>
            saveLostRequests(base.directory, context.task.id, takeLostRequests(context.task.name))
              .pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, paths),
                Effect.orDie,
              )
              .pipe(
                Effect.andThen(
                  fs
                    .writeFileString(
                      `${directory}/${context.task.id}.json`,
                      JSON.stringify(
                        {
                          title: context.task.name,
                          setupMs:
                            readyAt === undefined ? finishedAt - startedAt : readyAt - startedAt,
                          provisioningMs,
                          scenarioMs:
                            readyAt === undefined || completedAt === undefined
                              ? null
                              : completedAt - readyAt,
                          cleanupMs: completedAt === undefined ? null : finishedAt - completedAt,
                          totalMs: finishedAt - startedAt,
                          ...timing,
                        },
                        null,
                        2,
                      ),
                      { mode: 0o600 },
                    )
                    .pipe(Effect.orDie),
                ),
              );
          const plan: typeof TestPlan.Type | undefined = Object.values(scenarios).find(
            (scenario) => scenario.title === context.task.name,
          );
          const primary = Effect.gen(function* () {
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
            if (plan.provisioning !== "observed") {
              const settling = yield* Clock.currentTimeMillis;
              yield* prepareOrganization(actors.organization.id, {
                owner: actors.owner,
                admin: actors.admin,
              }).pipe(Effect.provideContext(fixtures));
              provisioningMs = (yield* Clock.currentTimeMillis) - settling;
            }
            if (plan.managementApps !== undefined)
              yield* Effect.forEach(
                plan.managementApps,
                (role) => prepareManagementApp(actors[role], actors.organization.id),
                { concurrency: 3, discard: true },
              ).pipe(Effect.provideContext(fixtures));
            return { target, actors };
          });
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

export const installLostRequestSaving = () =>
  afterAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const run = yield* Config.String("EXECUTOR_E2E_RUN").pipe(Config.option);
        const records = takeAllLostRequests();
        if (Option.isNone(run) || records.length === 0) return;
        const file = records.find((lost) => lost.file !== undefined)?.file ?? "file";
        yield* saveLostRequests(
          run.value,
          `outside-scenarios-${file.replace(/[^A-Za-z0-9.-]/gu, "-")}-${process.pid}-${Date.now()}`,
          records,
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
    ),
  );
/* oxlint-enable executor/no-manual-effect-runtime-in-tests */
