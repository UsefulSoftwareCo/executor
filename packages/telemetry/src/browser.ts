import {
  Cause,
  Context,
  Deferred,
  Effect,
  FiberSet,
  Layer,
  Logger,
  ManagedRuntime,
  Tracer,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpExporter } from "effect/observability";
import { Atom } from "effect/reactivity";
import type { TelemetryConfig } from "./config.ts";
import { telemetryLayer } from "./layer.ts";
import { observeBrowserPerformance } from "./browser-performance.ts";
import { browserPageId } from "./browser-operations.ts";
import { countedFetch, keepaliveRoom, onKeepaliveResend } from "./keepalive.ts";

export class BrowserTelemetry extends Context.Service<
  BrowserTelemetry,
  {
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

const requestBytes = (body: BodyInit | null | undefined) =>
  typeof body === "string"
    ? encoder.encode(body)
    : ArrayBuffer.isView(body)
      ? new Uint8Array(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
      : undefined;

const splitTraces = (
  body: Uint8Array,
  limit: number,
): readonly [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>] | undefined => {
  const payload: Json = JSON.parse(new TextDecoder().decode(body));
  let seen = 0;
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
  let [low, high] = [0, seen - 1];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (part(middle, true).byteLength <= limit) low = middle;
    else high = middle - 1;
  }
  return low === 0 ? undefined : [part(low, true), part(low, false)];
};

const exportFetch = (page: { leaving: boolean }): typeof fetch => {
  const send = (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    body: BodyInit,
    keepalive: number | false,
  ) => countedFetch("exports", fetch, input, { ...init, body }, keepalive);
  return (input, init) => {
    const body = requestBytes(init?.body);
    if (body === undefined) return fetch(input, init);
    if (body.byteLength <= keepaliveRoom()) return send(input, init, body, body.byteLength);
    if (!page.leaving && document.visibilityState !== "hidden")
      return send(input, init, body, false);
    const parts = splitTraces(body, keepaliveRoom());
    if (parts === undefined) return send(input, init, body, false);
    const [head, rest] = parts;
    return Promise.all([
      send(input, init, rest, false),
      send(input, init, head, head.byteLength),
    ]).then(([rest, head]) => (head.ok ? rest : head));
  };
};

const carryExportResends = (pending: { resent: number; failed: number }) =>
  Layer.effect(Tracer.Tracer)(
    Tracer.Tracer.pipe(
      Effect.map((tracer) => ({
        ...tracer,
        span: (options: Parameters<typeof tracer.span>[0]) => {
          const span = tracer.span(options);
          if (pending.resent > 0)
            span.attribute("executor.keepalive.export_resends", pending.resent);
          if (pending.failed > 0)
            span.attribute("executor.keepalive.export_resend_failures", pending.failed);
          pending.resent = 0;
          pending.failed = 0;
          return span;
        },
      })),
    ),
  );

export const browserTelemetryLayer = (settings: Effect.Effect<TelemetryConfig>) =>
  Layer.unwrap(
    settings.pipe(
      Effect.map((config) => {
        const page = { leaving: false };
        const exportResends = { resent: 0, failed: 0 };
        return Layer.effect(
          BrowserTelemetry,
          Effect.gen(function* () {
            const flusher = yield* OtlpExporter.Flusher;
            const run = yield* FiberSet.makeRuntime();
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
            const stopResends = onKeepaliveResend((sender, outcome) => {
              if (sender === "exports") {
                if (outcome === "resent") exportResends.resent++;
                else exportResends.failed++;
                return;
              }
              const attributes = {
                "executor.keepalive.sender": sender,
                "executor.keepalive.outcome": outcome,
                "executor.page.id": browserPageId() ?? "",
              };
              run(
                Effect.logInfo("ui.keepalive.resend").pipe(
                  Effect.annotateLogs(attributes),
                  Effect.withSpan("ui.keepalive.resend", { root: true, attributes }),
                ),
              );
            });
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
                stopResends();
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
          Layer.provideMerge(
            carryExportResends(exportResends).pipe(
              Layer.provideMerge(telemetryLayer(config, "process", Logger.consoleJson)),
            ),
          ),
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

export const makeBrowserTelemetry = (settings: Effect.Effect<TelemetryConfig>) => {
  const layer = browserTelemetryLayer(settings);
  const memoMap = Layer.makeMemoMapUnsafe();
  const runtime = ManagedRuntime.make(layer, { memoMap });
  const atoms = Atom.context({ memoMap });
  atoms.addGlobalLayer(layer);
  return { runtime, atoms };
};

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
