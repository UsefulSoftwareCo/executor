import { Context, Effect, Layer, Scope } from "effect";
import type { TestContext } from "vitest";
import { Actors } from "./actors.ts";
import { Api, SessionClients } from "./api.ts";
import { RuntimeLive, Target } from "./platform.ts";
import { scenarioLifetime } from "./lifecycle.ts";
import { BrowserDriver, Browser } from "./browser.ts";
import { Evidence, evidenceLayer, Telemetry } from "./evidence.ts";
import { RecordingFocus } from "./recording-focus.ts";
import { Terminal } from "./terminal.ts";
import { processCoverageLayer } from "./process-coverage.ts";
import { holdSecret } from "./failure-text.ts";
import { ScenarioDeadline } from "./scenario-deadline.ts";

export const withCase = <A, E, R>(context: TestContext, program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const timeout = context.task.timeout;
    const deadline = timeout > 0 ? Date.now() + timeout : undefined;
    const lifetime = scenarioLifetime(context);
    const target = lifetime.target;
    holdSecret(target.apiKey);
    const scope = yield* Scope.fork(lifetime.scope);
    const runtime = Layer.mergeAll(SessionClients.layer, processCoverageLayer).pipe(
      Layer.provideMerge(Layer.succeed(Target, target)),
    );
    return yield* Effect.gen(function* () {
      const services = yield* Layer.buildWithScope(
        Layer.fresh(
          Layer.mergeAll(Api.layer, Browser.layer, Terminal.layer).pipe(
            Layer.provideMerge(
              evidenceLayer(context).pipe(
                Layer.provideMerge(Layer.mergeAll(Telemetry.layer, RecordingFocus.layer)),
              ),
            ),
            Layer.provideMerge(runtime),
          ),
        ),
        scope,
      );
      const tests = yield* Scope.fork(scope);
      yield* Scope.addFinalizerExit(scope, (exit) =>
        Scope.close(tests, exit).pipe(
          Effect.onError((cause) => Context.get(services, Evidence).failed(cause)),
        ),
      );
      return yield* program.pipe(
        Effect.provideContext(services),
        Effect.provideService(ScenarioDeadline, deadline),
        Scope.provide(tests),
      );
    }).pipe(Effect.onExit((exit) => Effect.sync(() => lifetime.completed(exit))));
  });

export const TestLive = BrowserDriver.captureLayer.pipe(Layer.provideMerge(RuntimeLive));

export const HostedLive = TestLive;

export const WebKitLive = BrowserDriver.webkitCaptureLayer.pipe(Layer.provideMerge(RuntimeLive));

export const withHostedCase = <A, E, R>(context: TestContext, program: Effect.Effect<A, E, R>) =>
  withCase(
    context,
    Effect.gen(function* () {
      const actors = scenarioLifetime(context).actors;
      if (actors === undefined)
        return yield* Effect.die(new Error("Hosted scenarios must declare their actor fixtures"));
      return yield* program.pipe(Effect.provideService(Actors, actors));
    }),
  );
