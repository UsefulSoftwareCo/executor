/** Scope injected case services, evidence and cleanup around one test. */
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

/** Build per-case layers using the shared runtime from Effect Vitest's layer helper. */
const withCaseServices = <A, E, R, Services, LayerError, LayerRequirements>(
  context: TestContext,
  program: Effect.Effect<A, E, R>,
  caseLayers: Layer.Layer<Services, LayerError, LayerRequirements>,
) =>
  Effect.gen(function* () {
    const lifetime = scenarioLifetime(context);
    const target = lifetime.target;
    const scope = yield* Scope.fork(lifetime.scope);
    const runtime = SessionClients.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target)));
    return yield* Effect.gen(function* () {
      const services = yield* Layer.buildWithScope(
        Layer.fresh(
          caseLayers.pipe(
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
      // The test's own finalizers close first. A failure among them fails the case after its
      // body passed, so evidence records it before it writes the outcome.
      const tests = yield* Scope.fork(scope);
      yield* Scope.addFinalizerExit(scope, (exit) =>
        Scope.close(tests, exit).pipe(
          Effect.onError((cause) => Context.get(services, Evidence).failed(cause)),
        ),
      );
      return yield* program.pipe(Effect.provideContext(services), Scope.provide(tests));
    }).pipe(Effect.onExit((exit) => Effect.sync(() => lifetime.completed(exit))));
  });

/** Build per-case HTTP and evidence layers without constructing a browser context. */
export const withApiCase = <A, E, R>(context: TestContext, program: Effect.Effect<A, E, R>) =>
  withCaseServices(context, program, Layer.mergeAll(Api.layer, Terminal.layer));

/** Existing browser-backed case composition. */
export const withCase = <A, E, R>(context: TestContext, program: Effect.Effect<A, E, R>) =>
  withCaseServices(context, program, Layer.mergeAll(Api.layer, Browser.layer, Terminal.layer));

/** Effect Vitest shares platform and browser process layers; cases get fresh contexts and evidence. */
export const TestLive = BrowserDriver.captureLayer.pipe(Layer.provideMerge(RuntimeLive));

/** Share only native platform services; API-only cases do not launch a browser process. */
export const ApiLive = RuntimeLive;

/** Share platform and browser processes; actor fixtures are acquired per case. */
export const HostedLive = TestLive;

/** The same shared platform driven through Safari's engine. */
export const WebKitLive = BrowserDriver.webkitCaptureLayer.pipe(Layer.provideMerge(RuntimeLive));

const withActors = <A, E, R>(context: TestContext, program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const actors = scenarioLifetime(context).actors;
    if (actors === undefined)
      return yield* Effect.die(new Error("Hosted scenarios must declare their actor fixtures"));
    return yield* program.pipe(Effect.provideService(Actors, actors));
  });

/** Hosted cases use the fixtures acquired by setup; the native cleanup hook owns their release. */
export const withHostedCase = <A, E, R>(context: TestContext, program: Effect.Effect<A, E, R>) =>
  withCase(context, withActors(context, program));

/** Hosted fixtures with the browser-free API case lifecycle. */
export const withHostedApiCase = <A, E, R>(context: TestContext, program: Effect.Effect<A, E, R>) =>
  withApiCase(context, withActors(context, program));
