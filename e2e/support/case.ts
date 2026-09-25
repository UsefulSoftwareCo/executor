/** The only case composition helper: scope injected evidence/API/browser services around a test. */
import { Effect, Layer, Scope } from "effect";
import type { TestContext } from "vitest";
import { Actors } from "./actors.ts";
import { Api, SessionClients } from "./api.ts";
import { RuntimeLive, Target } from "./platform.ts";
import { scenarioLifetime } from "./lifecycle.ts";
import { BrowserDriver, Browser } from "./browser.ts";
import { evidenceLayer, Telemetry } from "./evidence.ts";
import { RecordingFocus } from "./recording-focus.ts";
import { Terminal } from "./terminal.ts";

/** Build per-case layers using the shared runtime from Effect Vitest's layer helper. */
export const withCase = <A, E, R>(context: TestContext, program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lifetime = scenarioLifetime(context);
    const target = lifetime.target;
    const scope = yield* Scope.fork(lifetime.scope);
    const runtime = SessionClients.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target)));
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
      return yield* program.pipe(Effect.provideContext(services), Scope.provide(scope));
    }).pipe(Effect.onExit((exit) => Effect.sync(() => lifetime.completed(exit))));
  });

/** Effect Vitest shares platform and browser process layers; cases get fresh contexts and evidence. */
export const TestLive = BrowserDriver.captureLayer.pipe(Layer.provideMerge(RuntimeLive));

/** Share platform and browser processes; actor fixtures are acquired per case. */
export const HostedLive = TestLive;

/** Hosted cases use the fixtures acquired by setup; the native cleanup hook owns their release. */
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
