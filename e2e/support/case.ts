/** The only case composition helper: scope injected evidence/API/browser services around a test. */
import { Effect, Layer } from "effect";
import type { TestContext } from "vitest";
import { Actors } from "./actors.ts";
import { Api, SessionClients } from "./api.ts";
import { RuntimeLive, Target } from "./platform.ts";
import { startScenario } from "../sdk/scenario.ts";
import { BrowserDriver, Browser } from "./browser.ts";
import { evidenceLayer, Telemetry } from "./evidence.ts";
import { RecordingFocus } from "./recording-focus.ts";
import { Terminal } from "./terminal.ts";

/** Build per-case layers using the shared runtime from Effect Vitest's layer helper. */
export const withCase = <A, E, R>(context: TestContext, program: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* startScenario(yield* Target, context.task.name);
      const runtime = SessionClients.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target)));
      return yield* program.pipe(
        // Release scenario resources before closing evidence so cleanup can affect the result and manifest.
        Effect.scoped,
        Effect.provide(
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
        ),
      );
    }),
  );

/** Effect Vitest shares platform and browser process layers; cases get fresh contexts and evidence. */
export const TestLive = BrowserDriver.captureLayer.pipe(Layer.provideMerge(RuntimeLive));

/** Share platform and browser processes; actor fixtures are acquired per case. */
export const HostedLive = TestLive;

/** Hosted cases acquire their actors inside the evidence lifetime and release only their own fixtures. */
export const withHostedCase = <A, E, R>(context: TestContext, program: Effect.Effect<A, E, R>) =>
  withCase(context, Effect.scoped(program).pipe(Effect.provide(Layer.fresh(Actors.layer))));
