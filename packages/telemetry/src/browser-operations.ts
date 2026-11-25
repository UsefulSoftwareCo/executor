import { Cause, Context, Effect, Exit, Schema, SchemaAST, Tracer } from "effect";
import { HttpClient, HttpClientError } from "effect/http";
import { isConnectionFailure } from "@executor-js/utils/connection-failure";
import { randomUuid } from "@executor-js/utils/random-uuid";
import { TraceContext } from "./trace-context.ts";

const pageIds = new WeakMap<Document, string>();
export const browserPageId = (): string | undefined => {
  if (typeof document === "undefined") return undefined;
  const existing = pageIds.get(document);
  if (existing !== undefined) return existing;
  const created = randomUuid();
  pageIds.set(document, created);
  return created;
};

interface Departure {
  navigationStart: number | undefined;
  hidden: boolean;
  navigation: EventTarget | undefined;
}
const navigationFailureWindow = 1_000;
const departures = new WeakMap<Document, Departure>();
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
    navigation.addEventListener("navigate", (event) => {
      if (leavesDocument(event)) departure.navigationStart = performance.now();
    });
    const stays = () => {
      departure.navigationStart = undefined;
    };
    navigation.addEventListener("navigateerror", stays);
    navigation.addEventListener("navigatesuccess", stays);
  }
  return departure;
};
const leavesDocument = (event: Event): boolean => {
  const destination: unknown = Reflect.get(event, "destination");
  return (
    typeof destination === "object" &&
    destination !== null &&
    Reflect.get(destination, "sameDocument") === false &&
    typeof Reflect.get(event, "downloadRequest") !== "string"
  );
};

const intercepted = (navigation: EventTarget | undefined): boolean => {
  const transition: unknown =
    navigation === undefined ? undefined : Reflect.get(navigation, "transition");
  return typeof transition === "object" && transition !== null;
};

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
    fiber.setContext(Context.add(fiber.context, ResponseTrace, value));
    return Effect.void;
  });
const observe = <A, E, R>(effect: Effect.Effect<A, E, R>, name: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.useSpan(name, (span) =>
      Effect.gen(function* () {
        const pageId = browserPageId();
        if (pageId !== undefined) yield* Effect.annotateCurrentSpan("executor.page.id", pageId);
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
