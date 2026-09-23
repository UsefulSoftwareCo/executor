/** The only case composition helper: scope injected evidence/API/browser services around a test. */
import { Effect, Layer } from "effect";
import type { TestContext } from "vitest";
import { Actors } from "./actors.ts";
import { Api, SessionClients } from "./api.ts";
import { RuntimeLive } from "./platform.ts";
import { BrowserDriver, Browser } from "./browser.ts";
import { evidenceLayer, Telemetry } from "./evidence.ts";
import { RecordingFocus } from "./recording-focus.ts";
import { Terminal } from "./terminal.ts";

/** Build per-case layers using the shared runtime from Effect Vitest's layer helper. */
export const withCase = <A, E, R>(context: TestContext, program: Effect.Effect<A, E, R>) =>
  program.pipe(
    // Release scenario resources before closing evidence so cleanup can affect the result and manifest.
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(Api.layer, Browser.layer, Terminal.layer).pipe(
        Layer.provideMerge(
          evidenceLayer(context).pipe(
            Layer.provideMerge(Layer.mergeAll(Telemetry.layer, RecordingFocus.layer)),
          ),
        ),
      ),
    ),
  );

/** Effect Vitest shares platform and browser process layers; cases get fresh contexts and evidence. */
export const TestLive = Layer.mergeAll(BrowserDriver.captureLayer, SessionClients.layer).pipe(
  Layer.provideMerge(RuntimeLive),
);

/** Share actor fixtures with Effect Vitest's suite layer; each browser still has its own context. */
export const HostedLive = Actors.layer.pipe(Layer.provideMerge(TestLive));
