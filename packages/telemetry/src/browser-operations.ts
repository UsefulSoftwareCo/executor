/** Correlate transport and decoded outcomes without exporting response bodies or errors. */
import { Cause, Context, Effect, Exit, Schema, SchemaAST, Tracer } from "effect";
import { HttpClient, HttpClientError } from "effect/http";
import { isConnectionFailure } from "@executor-js/utils/connection-failure";
import { TraceContext } from "./trace-context.ts";

const pageIds = new WeakMap<Document, string>();
/**
 * A random identity for the current browser document. It is never an authentication or user
 * identifier. Server renders have no document, so they get none instead of sharing one per isolate.
 */
export const browserPageId = (): string | undefined => {
  if (typeof document === "undefined") return undefined;
  const existing = pageIds.get(document);
  if (existing !== undefined) return existing;
  const created = crypto.randomUUID();
  pageIds.set(document, created);
  return created;
};

interface Departure {
  /**
   * When the pending cross-document navigation started. A cancelled navigation ends it; a 204 or
   * an attachment response may never end it, so it explains only failures right after it starts.
   */
  navigationStart: number | undefined;
  /** The page is unloading or entering the back/forward cache. */
  hidden: boolean;
  /** The browser's Navigation API, when it has one. */
  navigation: EventTarget | undefined;
}
/**
 * How soon after a navigation starts a request it interrupts fails. Safari fails the page's
 * in-flight requests within about 10 ms of a cross-document navigation; the margin allows for a
 * busy main thread. Chromium fails them only at `pagehide`, which `hidden` covers.
 *
 * Inside this window the page's departure explains any failure of a request already in flight, so
 * a genuine reset of such a request by Executor or its edge is not reported either. The page is
 * leaving and nobody reads the result; that loss is accepted.
 */
const navigationFailureWindow = 1_000;
const departures = new WeakMap<Document, Departure>();
/**
 * Watch the current document leave. Browsers fail its in-flight requests as it leaves: Safari as
 * soon as a cross-document navigation starts, Chromium at `pagehide` while the page still reads
 * as visible. Browsers without the Navigation API are covered from `pagehide` on.
 */
const watchDeparture = (): Departure => {
  const existing = departures.get(document);
  if (existing !== undefined) return existing;
  const navigation: unknown = Reflect.get(window, "navigation");
  const departure: Departure = {
    navigationStart: undefined,
    hidden: false,
    navigation: navigation instanceof EventTarget ? navigation : undefined,
  };
  departures.set(document, departure);
  window.addEventListener("pagehide", () => {
    departure.hidden = true;
  });
  window.addEventListener("pageshow", () => {
    departure.hidden = false;
    departure.navigationStart = undefined;
  });
  if (navigation instanceof EventTarget) {
    // A script that intercepts the navigation keeps it in this document, but its destination still
    // reads as another document, and this listener may run before the script's. `intercepted`
    // tells the two apart when a request fails.
    navigation.addEventListener("navigate", (event) => {
      if (leavesDocument(event)) departure.navigationStart = performance.now();
    });
    // The navigation was cancelled, failed, or a script kept it in this document.
    const stays = () => {
      departure.navigationStart = undefined;
    };
    navigation.addEventListener("navigateerror", stays);
    navigation.addEventListener("navigatesuccess", stays);
  }
  return departure;
};
/** A Navigation API `navigate` event to another document that is not a download link. */
const leavesDocument = (event: Event): boolean => {
  // TypeScript 5's DOM library, used by the apps build, does not declare the Navigation API.
  const destination: unknown = Reflect.get(event, "destination");
  return (
    typeof destination === "object" &&
    destination !== null &&
    Reflect.get(destination, "sameDocument") === false &&
    typeof Reflect.get(event, "downloadRequest") !== "string"
  );
};

/**
 * The latest navigation was intercepted and is still in progress. Intercepting creates
 * `navigation.transition` before the `navigate` event's dispatch returns, and a later navigation
 * aborts it before its own event, so a cross-document navigation always runs without one.
 */
const intercepted = (navigation: EventTarget | undefined): boolean => {
  const transition: unknown =
    navigation === undefined ? undefined : Reflect.get(navigation, "transition");
  return typeof transition === "object" && transition !== null;
};

/**
 * A lost connection the browser itself explains: the device is offline, the page is hidden, or
 * the page is leaving while this request was in flight, so nobody waits for the result. Without
 * that evidence the same fetch failure can be Executor or its edge resetting the connection, or a
 * blocked request, and it is still reported.
 */
const connectionContext = (departure: Departure, started: number) => {
  const online = navigator.onLine;
  const visibility = document.visibilityState;
  const navigationStart = departure.navigationStart;
  const leaving =
    departure.hidden ||
    (navigationStart !== undefined &&
      navigationStart >= started &&
      performance.now() - navigationStart <= navigationFailureWindow &&
      !intercepted(departure.navigation));
  return { online, visibility, leaving, explained: !online || visibility === "hidden" || leaving };
};

/** Safe event shared with the host's error reporter and product analytics. */
export const BrowserOperationFailure = Schema.Struct({
  error_type: Schema.Literals([
    "BrowserDecodeFailed",
    "BrowserConnectionFailed",
    "BrowserTransportFailed",
    "BrowserOperationFailed",
  ]),
  trace_id: TraceContext.fields.traceId,
  span_id: TraceContext.fields.spanId,
  page_id: Schema.String,
});
const ResponseTrace = Context.Reference<TraceContext | undefined>("telemetry/ResponseTrace", {
  defaultValue: () => undefined,
});
const setResponseTrace = (value: TraceContext | undefined) =>
  Effect.withFiber((fiber) => {
    // The generated client executes transport then decoding on this fiber. Consume
    // once at decoding; parallel requests have independent fiber contexts.
    fiber.setContext(Context.add(fiber.context, ResponseTrace, value));
    return Effect.void;
  });
const observe = <A, E, R>(effect: Effect.Effect<A, E, R>, name: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.useSpan(name, (span) =>
      Effect.gen(function* () {
        const pageId = browserPageId();
        if (pageId !== undefined) yield* Effect.annotateCurrentSpan("executor.page.id", pageId);
        // Watch before the request starts: Safari fails it as soon as a navigation begins.
        const departure = pageId === undefined ? undefined : watchDeparture();
        const started = performance.now();
        const exit = yield* Effect.exit(effect);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          const interrupted = Cause.hasInterruptsOnly(exit.cause);
          const status =
            error instanceof Error && Schema.isSchema(error.constructor)
              ? SchemaAST.resolveAt<unknown>("httpApiStatus")(error.constructor.ast)
              : undefined;
          // A request that never got a response is expected only when the browser explains why;
          // the server records any part of it that arrived. The span keeps it observable.
          const connection =
            isConnectionFailure(error) && departure !== undefined
              ? connectionContext(departure, started)
              : undefined;
          const expected =
            connection?.explained === true ||
            (typeof status === "number" && status >= 400 && status < 500);
          const kind = Schema.isSchemaError(error)
            ? "BrowserDecodeFailed"
            : connection !== undefined
              ? "BrowserConnectionFailed"
              : HttpClientError.isHttpClientError(error)
                ? "BrowserTransportFailed"
                : "BrowserOperationFailed";
          yield* Effect.annotateCurrentSpan({
            "executor.outcome": interrupted ? "cancelled" : "failed",
            "error.type": kind,
            "executor.error.expected": expected,
          });
          if (connection !== undefined)
            yield* Effect.annotateCurrentSpan({
              "executor.browser.online": connection.online,
              "executor.page.visibility": connection.visibility,
              "executor.page.leaving": connection.leaving,
            });
          // The browser's error reporter listens for this; the server records the span itself.
          if (!interrupted && !expected && pageId !== undefined)
            window.dispatchEvent(
              new CustomEvent("executor:operation-failed", {
                detail: {
                  error_type: kind,
                  trace_id: span.traceId,
                  span_id: span.spanId,
                  page_id: pageId,
                },
              }),
            );
        } else {
          yield* Effect.annotateCurrentSpan("executor.outcome", "completed");
        }
        return {
          exit,
          trace: { traceId: span.traceId, spanId: span.spanId, sampled: span.sampled },
        };
      }).pipe(Effect.withParentSpan(span)),
    );
    return result;
  });

/** Observe transport failure and retain only its trace identity for the subsequent decoder. */
export const observeBrowserTransport = (client: HttpClient.HttpClient) =>
  client.pipe(
    HttpClient.transformResponse((effect) =>
      Effect.gen(function* () {
        yield* setResponseTrace(undefined);
        const result = yield* observe(effect, "ui.api.transport");
        if (Exit.isSuccess(result.exit)) yield* setResponseTrace(result.trace);
        return yield* result.exit;
      }),
    ),
  );

/** AtomHttpApi invokes this after status/body decoding, including handled schema failures. */
export const observeBrowserResponse = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const parent = yield* ResponseTrace;
    yield* setResponseTrace(undefined);
    const work = observe(effect, "ui.api");
    const result = yield* parent === undefined
      ? work
      : work.pipe(Effect.withParentSpan(Tracer.externalSpan(parent)));
    return yield* result.exit;
  });
