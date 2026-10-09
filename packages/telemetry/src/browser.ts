/** Browser-owned Effect telemetry, shared by Promise calls and Atom runtimes. */
import { Cause, Context, Deferred, Effect, FiberSet, Layer, Logger, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpExporter } from "effect/observability";
import { Atom } from "effect/reactivity";
import type { TelemetryConfig } from "./config.ts";
import { telemetryLayer } from "./layer.ts";
import { observeBrowserPerformance } from "./browser-performance.ts";

/** Page events use the same tracer and export scope as browser API operations. */
export class BrowserTelemetry extends Context.Service<
  BrowserTelemetry,
  {
    /**
     * `load` names the document's initial route without a span: hydration resolves no route
     * change, and first load is measured by the vitals. `start` opens a `ui.navigation` span
     * that the router's next `end` closes or the next `start` interrupts.
     */
    readonly navigation: (
      event: { readonly type: "load" | "start"; readonly path: string } | { readonly type: "end" },
    ) => Effect.Effect<void>;
    readonly flush: Effect.Effect<void>;
  }
>()("executor/BrowserTelemetry") {}

/** Install listeners for this page lifetime. Closing the Layer removes them and drains exporters. */
export const browserTelemetryLayer = (settings: Effect.Effect<TelemetryConfig>) =>
  Layer.unwrap(
    settings.pipe(
      Effect.map((config) =>
        Layer.effect(
          BrowserTelemetry,
          Effect.gen(function* () {
            const flusher = yield* OtlpExporter.Flusher;
            const run = yield* FiberSet.makeRuntime();
            // `hidden` records whether the page was hidden at any point before the route resolved.
            let navigation: { readonly done: Deferred.Deferred<void>; hidden: boolean } | undefined;
            const performance = yield* observeBrowserPerformance;
            const flush = performance.flush.pipe(
              Effect.andThen(flusher.flush),
              Effect.timeoutOption("2 seconds"),
              Effect.asVoid,
            );
            const error = (name: string, value: unknown) =>
              run(
                Effect.logError(Cause.die(value)).pipe(
                  Effect.andThen(Effect.fail(value)),
                  Effect.withSpan(name),
                  Effect.ignore,
                ),
              );
            const onError = (event: ErrorEvent) =>
              error("ui.error", event.error ?? new Error(event.message));
            const onRejection = (event: PromiseRejectionEvent) =>
              error("ui.unhandled-rejection", event.reason);
            const onHidden = () => {
              if (navigation !== undefined && document.visibilityState === "hidden")
                navigation.hidden = true;
              run(
                document.visibilityState === "hidden"
                  ? performance.pause.pipe(Effect.andThen(flush))
                  : performance.resume,
              );
            };
            const onHide = () => {
              run(performance.hide.pipe(Effect.andThen(flush)));
            };
            const onShow = (event: PageTransitionEvent) => {
              if (event.persisted) run(performance.restore);
            };
            window.addEventListener("error", onError);
            window.addEventListener("unhandledrejection", onRejection);
            window.addEventListener("pagehide", onHide);
            window.addEventListener("pageshow", onShow);
            document.addEventListener("visibilitychange", onHidden);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                window.removeEventListener("error", onError);
                window.removeEventListener("unhandledrejection", onRejection);
                window.removeEventListener("pagehide", onHide);
                window.removeEventListener("pageshow", onShow);
                document.removeEventListener("visibilitychange", onHidden);
              }),
            );
            return {
              flush,
              navigation: (event) =>
                Effect.sync(() => {
                  if (event.type === "load") return;
                  if (event.type === "end") {
                    if (navigation !== undefined) Deferred.doneUnsafe(navigation.done, Effect.void);
                    navigation = undefined;
                    return;
                  }
                  if (navigation !== undefined)
                    Deferred.doneUnsafe(navigation.done, Effect.interrupt);
                  const current = {
                    done: Deferred.makeUnsafe<void>(),
                    hidden: document.visibilityState === "hidden",
                  };
                  navigation = current;
                  run(
                    Deferred.await(current.done).pipe(
                      // Record visibility however the navigation ends, including when a later one interrupts it.
                      Effect.ensuring(
                        Effect.suspend(() =>
                          Effect.annotateCurrentSpan("executor.navigation.hidden", current.hidden),
                        ),
                      ),
                      Effect.withSpan("ui.navigation", {
                        root: true,
                        attributes: { "url.path": event.path },
                      }),
                      Effect.ignore,
                    ),
                  );
                }).pipe(
                  Effect.andThen(
                    event.type === "end" ? Effect.void : performance.navigation(event.path),
                  ),
                ),
            };
          }),
        ).pipe(
          Layer.provideMerge(telemetryLayer(config, "process", Logger.consoleJson)),
          Layer.provide(
            Layer.succeed(FetchHttpClient.RequestInit, {
              keepalive: true,
              credentials: "same-origin",
            }),
          ),
        ),
      ),
    ),
  );

/** Share a memo map so the page and its Atom registries acquire one telemetry Layer. */
export const makeBrowserTelemetry = (settings: Effect.Effect<TelemetryConfig>) => {
  const layer = browserTelemetryLayer(settings);
  const memoMap = Layer.makeMemoMapUnsafe();
  const runtime = ManagedRuntime.make(layer, { memoMap });
  const atoms = Atom.context({ memoMap });
  atoms.addGlobalLayer(layer);
  return { runtime, atoms };
};

/** Read public build metadata and use only same-origin telemetry endpoints. */
export const browserSettings = (
  basePath: string,
  service: string,
): Effect.Effect<TelemetryConfig> =>
  Effect.sync(() => ({
    service,
    clock: "system",
    version:
      document.querySelector<HTMLMetaElement>('meta[name="executor-build"]')?.content ??
      "development",
    environment:
      document.querySelector<HTMLMetaElement>('meta[name="executor-environment"]')?.content ??
      "development",
    traces: { url: new URL(`${basePath}/traces`, window.location.origin).href },
    logs: { url: new URL(`${basePath}/logs`, window.location.origin).href },
  }));

export {
  browserPageId,
  BrowserOperationFailure,
  observeBrowserTransport,
  observeBrowserResponse,
} from "./browser-operations.ts";
