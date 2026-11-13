/** Browser-owned Effect telemetry, shared by Promise calls and Atom runtimes. */
import { Cause, Context, Deferred, Effect, FiberSet, Layer, Logger, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpExporter } from "effect/observability";
import { Atom } from "effect/reactivity";
import type { TelemetryConfig } from "./config.ts";
import { telemetryLayer } from "./layer.ts";
import { observeBrowserPerformance } from "./browser-performance.ts";
import { countedFetch, keepaliveRoom } from "./keepalive.ts";

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

const encoder = new TextEncoder();
type Json = Readonly<Record<string, unknown>>;
const objects = (value: unknown): ReadonlyArray<Json> =>
  Array.isArray(value)
    ? value.filter((item): item is Json => typeof item === "object" && item !== null)
    : [];

// A text or typed-array body's bytes. Other bodies, which this exporter never sends, go without keepalive.
const requestBytes = (body: BodyInit | null | undefined) =>
  typeof body === "string"
    ? encoder.encode(body)
    : ArrayBuffer.isView(body)
      ? new Uint8Array(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
      : undefined;

// Split a trace export, which this exporter's serializer wrote as OTLP/JSON, in two: as many first
// spans as fit in `limit` bytes, then the rest. Each span keeps its resource and scope.
const splitTraces = (
  body: Uint8Array,
  limit: number,
): readonly [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>] | undefined => {
  const payload: Json = JSON.parse(new TextDecoder().decode(body));
  let seen = 0;
  // The spans before (or from) the `count`th.
  const part = (count: number, before: boolean) => {
    seen = 0;
    const resourceSpans = objects(payload.resourceSpans).map((resource) => ({
      ...resource,
      scopeSpans: objects(resource.scopeSpans).map((scope) => {
        const spans = objects(scope.spans);
        const at = Math.max(count - seen, 0);
        seen += spans.length;
        return { ...scope, spans: before ? spans.slice(0, at) : spans.slice(at) };
      }),
    }));
    return encoder.encode(JSON.stringify({ ...payload, resourceSpans }));
  };
  part(0, true);
  // The most first spans that fit, leaving at least one for the rest.
  let [low, high] = [0, seen - 1];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (part(middle, true).byteLength <= limit) low = middle;
    else high = middle - 1;
  }
  return low === 0 ? undefined : [part(low, true), part(low, false)];
};

// Export with keepalive whenever the body fits what is left of the page's keepalive budget, which
// error reports and analytics share, so an export in
// flight when the page unloads still arrives. One that does not fit is an ordinary request,
// except as the page leaves or hides: then a trace export's spans that fit go with keepalive and the
// rest in one ordinary request. More pieces would queue behind each other and be cancelled. The
// browser's refusal fails the batch, and four failures stop the exporter for a minute.
const exportFetch = (page: { leaving: boolean }): typeof fetch => {
  const send = (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    body: BodyInit,
    keepalive: number | false,
  ) => countedFetch(fetch, input, { ...init, body }, keepalive);
  return (input, init) => {
    const body = requestBytes(init?.body);
    if (body === undefined) return fetch(input, init);
    if (body.byteLength <= keepaliveRoom()) return send(input, init, body, body.byteLength);
    if (!page.leaving && document.visibilityState !== "hidden")
      return send(input, init, body, false);
    const parts = splitTraces(body, keepaliveRoom());
    if (parts === undefined) return send(input, init, body, false);
    const [head, rest] = parts;
    // Start the ordinary request first: issued after the keepalive one, Chrome usually cancels it
    // before its body leaves. Either refusal fails the export; otherwise the transport reads the
    // rest's acknowledgement, so a partial success the keepalive part reports is not counted.
    return Promise.all([
      send(input, init, rest, false),
      send(input, init, head, head.byteLength),
    ]).then(([rest, head]) => (head.ok ? rest : head));
  };
};

/** Install listeners for this page lifetime. Closing the Layer removes them and drains exporters. */
export const browserTelemetryLayer = (settings: Effect.Effect<TelemetryConfig>) =>
  Layer.unwrap(
    settings.pipe(
      Effect.map((config) => {
        const page = { leaving: false };
        return Layer.effect(
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
              page.leaving = true;
              run(performance.hide.pipe(Effect.andThen(flush)));
            };
            const onShow = (event: PageTransitionEvent) => {
              page.leaving = false;
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
            Layer.mergeAll(
              Layer.succeed(FetchHttpClient.RequestInit, { credentials: "same-origin" }),
              Layer.succeed(FetchHttpClient.Fetch, exportFetch(page)),
            ),
          ),
        );
      }),
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
