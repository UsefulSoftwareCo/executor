/** Inject response and document failures through Playwright's real network boundary. */
import { Effect, Schedule, Schema } from "effect";
import { Browser } from "./browser.ts";
import { replaceResponses } from "./browser-responses.ts";
import { collectorLinesWholeEnvironment, field, parseLeniently } from "./collector-events.ts";
import { scopeOf, type Scope } from "./scope.ts";

/** The safe subset of a delivered Sentry event that scenarios assert on. */
export const SentryEvent = Schema.fromJsonString(
  Schema.Struct({
    release: Schema.optional(Schema.String),
    tags: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    request: Schema.optional(Schema.Struct({ url: Schema.optional(Schema.String) })),
    contexts: Schema.optional(
      Schema.Struct({ trace: Schema.optional(Schema.Struct({ trace_id: Schema.String })) }),
    ),
    exception: Schema.optional(
      Schema.Struct({
        values: Schema.Array(
          Schema.Struct({
            value: Schema.String,
            mechanism: Schema.optional(Schema.Struct({ type: Schema.String })),
            stacktrace: Schema.optional(
              Schema.Struct({
                frames: Schema.Array(Schema.Struct({ filename: Schema.optional(Schema.String) })),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);
export type SentryEvent = typeof SentryEvent.Type;

/** Whether the browser SDK captured the event from page-wide handlers or wrapped browser APIs. */
export const automaticCapture = (event: SentryEvent) =>
  event.exception?.values.some((value) => value.mechanism?.type.startsWith("auto.browser.")) ===
  true;

/**
 * Which browser reports a read returns, by one kind: those of the scenario's own traces, of its
 * own page (the `page_id` its reporter tags), or of a dashboard page of its own organization (by
 * slug). A scope naming two kinds does not typecheck; a missing or empty ID, or no traces, is a
 * defect.
 */
export type BrowserSentryScope = Scope<{
  readonly traces: ReadonlyArray<string>;
  readonly page: string;
  readonly organizationSlug: string;
}>;

/** Every event item the receiver has accepted so far, as sent, from every scenario sharing it. */
const eventItems = collectorLinesWholeEnvironment("sentry.ndjson").pipe(
  Effect.map((lines) =>
    lines.flatMap((line) => {
      const envelope = field(parseLeniently(line), "envelope");
      return typeof envelope === "string" ? envelope.split("\n").slice(2).filter(Boolean) : [];
    }),
  ),
);
/**
 * Each envelope the receiver accepted that carries an event of trace `trace`, as sent: its size,
 * and the category and URL path of each breadcrumb its event carries.
 */
export const sentryReports = (trace: string) =>
  collectorLinesWholeEnvironment("sentry.ndjson").pipe(
    Effect.map((lines) =>
      lines.flatMap((line) => {
        const envelope = field(parseLeniently(line), "envelope");
        if (typeof envelope !== "string") return [];
        const event = envelope
          .split("\n")
          .slice(2)
          .map(parseLeniently)
          .find((item) => field(item, "contexts", "trace", "trace_id") === trace);
        if (event === undefined) return [];
        const crumbs = field(event, "breadcrumbs");
        const values = field(event, "breadcrumbs", "values");
        const list: ReadonlyArray<unknown> = Array.isArray(values)
          ? values
          : Array.isArray(crumbs)
            ? crumbs
            : [];
        return [
          {
            bytes: new TextEncoder().encode(envelope).byteLength,
            breadcrumbs: list.map((crumb) => {
              const url = field(crumb, "data", "url");
              return {
                category: String(field(crumb, "category") ?? ""),
                path:
                  typeof url === "string" && URL.canParse(url, "http://page.invalid")
                    ? new URL(url, "http://page.invalid").pathname
                    : undefined,
              };
            }),
          },
        ];
      }),
    ),
  );
const decode = (items: ReadonlyArray<string>) =>
  items.map((item) => Schema.decodeUnknownSync(SentryEvent)(item));

/**
 * Every event the managed Cloud target's loopback Sentry receiver has accepted so far, from every
 * scenario sharing it: only for finding a marker this scenario raised, or checking that one is
 * reported nowhere.
 */
export const sentryEventsWholeEnvironment = eventItems.pipe(Effect.map(decode));

/**
 * The events in `scope` accepted so far. Each item is matched to the scope leniently, so another
 * scenario's malformed event is passed over; the scenario's own are then decoded strictly.
 */
export const sentryEvents = (scope: BrowserSentryScope) =>
  Effect.gen(function* () {
    const { kind, value } = yield* scopeOf("A browser Sentry read", scope);
    const owned = (item: unknown) => {
      if (kind === "traces") {
        const trace = field(item, "contexts", "trace", "trace_id");
        return typeof trace === "string" && value.includes(trace);
      }
      if (kind === "page") return field(item, "tags", "page_id") === value;
      const url = field(item, "request", "url");
      return (
        typeof url === "string" &&
        URL.canParse(url) &&
        new URL(url).pathname.startsWith(`/org/${String(value)}/`)
      );
    };
    if (kind !== "traces" && kind !== "page" && kind !== "organizationSlug")
      return yield* Effect.die(new Error(`A browser Sentry read has no scope named ${kind}`));
    return decode((yield* eventItems).filter((item) => owned(parseLeniently(item))));
  });

const awaitAny = (
  events: typeof sentryEventsWholeEnvironment,
  predicate: (event: SentryEvent) => boolean,
) =>
  events.pipe(
    Effect.map((events) => events.filter(predicate)),
    Effect.repeat({
      schedule: Schedule.spaced("200 millis"),
      until: (events) => events.length > 0,
    }),
    Effect.timeout("15 seconds"),
  );
/** Wait until at least one delivered event in `scope` matches. */
export const awaitSentry = (
  scope: BrowserSentryScope,
  predicate: (event: SentryEvent) => boolean,
) => awaitAny(sentryEvents(scope), predicate);
/** Wait until at least one delivered event matches, from any scenario sharing the receiver. */
export const awaitSentryWholeEnvironment = (predicate: (event: SentryEvent) => boolean) =>
  awaitAny(sentryEventsWholeEnvironment, predicate);

/**
 * Record each operation failure the page reports, as the safe metadata its event carries, in the
 * document's `data-observed-failures` attribute. Applies to every document the page opens after.
 */
export const observeOperationFailures = Effect.gen(function* () {
  const browser = yield* Browser;
  yield* browser.use("Observe only safe operation failure metadata", (page) =>
    page.addInitScript(() => {
      window.addEventListener("executor:operation-failed", (event) => {
        if (!(event instanceof CustomEvent)) return;
        const root = document.documentElement;
        const seen: unknown = JSON.parse(root.getAttribute("data-observed-failures") ?? "[]");
        root.setAttribute(
          "data-observed-failures",
          JSON.stringify([...(Array.isArray(seen) ? seen : []), event.detail]),
        );
      });
    }),
  );
});

/**
 * Keep the browser's real server request and trace, then replace only the response under test.
 * Returns the trace of the replaced request and the failure the page reported for it, as JSON,
 * which `observeOperationFailures` records; another request's failure, such as a slow server's
 * 503 on the opened page, is passed over. `beforeFailing` runs on the opened page before the
 * browser sends the request that fails.
 */
export const injectDashboardResponse = <E = never, R = never>(
  slug: string,
  body: string,
  status: number,
  beforeFailing: Effect.Effect<unknown, E, R> = Effect.void,
) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    let trace: string | undefined;
    yield* browser.use("Leave the previous document", (page) => page.goto("about:blank"));
    yield* replaceResponses("*/api/organizations/*/resources*", (response) => {
      trace = response.requestHeaders["traceparent"]?.split("-")[1];
      return { status, body, contentType: "application/json" };
    });
    // Pages render on the server with their data, so the browser reads resources only when it
    // navigates to them itself.
    yield* browser.use("Open a page that does not read resources", (page) =>
      page.goto(`/org/${slug}/organization`),
    );
    yield* beforeFailing;
    yield* browser.use("Navigate to Apps in the browser", (page) =>
      page.getByRole("navigation").getByRole("link", { name: /^Apps/ }).click(),
    );
    const replaced = yield* Effect.sync(() => trace).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("50 millis"),
        until: (trace) => trace !== undefined,
      }),
      Effect.timeout("15 seconds"),
    );
    const failure = yield* browser.use("Wait for the decoded operation failure", (page) =>
      page
        .waitForFunction((trace) => {
          const seen: unknown = JSON.parse(
            document.documentElement.getAttribute("data-observed-failures") ?? "[]",
          );
          const match = Array.isArray(seen)
            ? seen.find(
                (failure: unknown) =>
                  typeof failure === "object" &&
                  failure !== null &&
                  Reflect.get(failure, "trace_id") === trace,
              )
            : undefined;
          return match === undefined ? false : JSON.stringify(match);
        }, replaced)
        .then((handle) => handle.jsonValue()),
    );
    return { trace: replaced, failure: String(failure) };
  }).pipe(Effect.scoped);

/**
 * Until the scope closes, hold the page's trace and log exports before they leave the browser, as
 * a collector slowed by load holds them. Their keepalive bodies stay in flight meanwhile. `held`
 * waits until a trace export is held. `next` lets the held exports go and waits until a new trace
 * export is held: one export of each kind runs at a time, so it carries everything the page
 * recorded meanwhile. `heldBytes` is the bytes of the export bodies held since then. The exporter
 * gives up on a request after five seconds and sends the same body again; a body counts once.
 */
export const holdTelemetryExports = Effect.gen(function* () {
  const browser = yield* Browser;
  const exports = (url: URL) => /^\/api\/telemetry\/(?:traces|logs)$/.test(url.pathname);
  const phase = () => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let traceHeld = () => {};
    const trace = new Promise<void>((resolve) => {
      traceHeld = resolve;
    });
    return { release, released, traceHeld, trace, bytes: 0 };
  };
  let current = phase();
  const seen = new Set<string>();
  yield* Effect.acquireRelease(
    browser.use("Hold the page's telemetry exports before they leave", (page) =>
      page.route(exports, (route) => {
        const held = current;
        const body = route.request().postDataBuffer() ?? Buffer.alloc(0);
        const key = `${route.request().url()} ${body.toString("base64")}`;
        if (!seen.has(key)) {
          seen.add(key);
          held.bytes += body.byteLength;
          if (new URL(route.request().url()).pathname.endsWith("/traces")) held.traceHeld();
        }
        return held.released.then(() => route.fallback());
      }),
    ),
    () =>
      Effect.sync(() => current.release()).pipe(
        Effect.andThen(
          browser.use("Let the held telemetry exports go", (page) => page.unroute(exports)),
        ),
        Effect.orDie,
      ),
  );
  const awaitTrace = (name: string) =>
    browser.use(name, () => current.trace).pipe(Effect.timeout("15 seconds"));
  return {
    held: awaitTrace("Wait until the page's trace export is held"),
    next: Effect.suspend(() => {
      const previous = current;
      current = phase();
      previous.release();
      return awaitTrace("Let the held exports go and wait until the next trace export is held");
    }),
    heldBytes: Effect.sync(() => current.bytes),
  };
});

/**
 * Until the scope closes, hold the session replay chunks PostHog sends from the page, as a slow
 * analytics proxy holds them. `sizes` is each held chunk's body size, in the order sent. A resent
 * body counts once.
 */
export const holdReplayChunks = Effect.gen(function* () {
  const browser = yield* Browser;
  const chunks = (url: URL) => /^\/api\/[a-f0-9]{16}\/s\/?$/.test(url.pathname);
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sizes: Array<number> = [];
  const seen = new Set<string>();
  yield* Effect.acquireRelease(
    browser.use("Hold the page's session replay chunks before they leave", (page) =>
      page.route(chunks, (route) => {
        const body = route.request().postDataBuffer() ?? Buffer.alloc(0);
        const key = body.toString("base64");
        if (!seen.has(key)) {
          seen.add(key);
          sizes.push(body.byteLength);
        }
        return released.then(() => route.fallback());
      }),
    ),
    () =>
      Effect.sync(release).pipe(
        Effect.andThen(
          browser.use("Let the held replay chunks go", (page) => page.unroute(chunks)),
        ),
        Effect.orDie,
      ),
  );
  return {
    sizes: Effect.sync(() => [...sizes]),
  };
});

/**
 * Count, until the scope closes, the analytics events the page sends to the PostHog proxy's event
 * path; `count` is how many it has sent so far.
 */
export const countAnalyticsPushes = Effect.gen(function* () {
  const browser = yield* Browser;
  let count = 0;
  const pushes = (url: URL) => /^\/api\/[a-f0-9]{16}\/push$/.test(url.pathname);
  yield* Effect.acquireRelease(
    browser.use("Count the page's analytics events", (page) =>
      page.route(pushes, (route) => {
        count++;
        return route.fallback();
      }),
    ),
    () =>
      browser
        .use("Stop counting analytics events", (page) => page.unroute(pushes))
        .pipe(Effect.orDie),
  );
  return { count: Effect.sync(() => count) };
});

/** The URL path of the dashboard's analytics events, as their breadcrumbs would name it. */
export const analyticsPushPath = /^\/api\/[a-f0-9]{16}\/push$/;

/** Withhold the server's bootstrap data so the dashboard's browser entry cannot start. */
export const incompleteDashboardDocument = (slug: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use("Leave the previous document", (page) => page.goto("about:blank"));
    yield* browser.use("Drop the document's bootstrap data before any script runs", (page) =>
      page.addInitScript(() => {
        Object.defineProperty(window, "$_TSR", {
          configurable: false,
          get: () => undefined,
          set: () => {},
        });
        document.documentElement.setAttribute("data-incomplete-document", "true");
      }),
    );
    yield* browser.use("Open the incomplete document", (page) => page.goto(`/org/${slug}/apps`));
  });

/**
 * Replace every dashboard resource response with an undecodable body while the
 * real request and its trace still happen. Each read then fails in the
 * dashboard's own decoder, which reports it with the request's trace.
 */
export const breakDashboardReads = Effect.gen(function* () {
  const traces: Array<string> = [];
  yield* replaceResponses("*/api/organizations/*/resources*", (response) => {
    const trace = response.requestHeaders["traceparent"]?.split("-")[1];
    if (trace !== undefined) traces.push(trace);
    return { status: response.status, body: "{", contentType: "application/json" };
  });
  return traces;
});

/**
 * Press the documentation's "Copy page" action while its Markdown request is
 * missing. Blume's own loader throws for the 404 and its clipboard helper
 * leaves the derived write unhandled, so the page raises a failure whose only
 * frame is the page-actions chunk. That unhandled write is a Blume 1.7.3 defect;
 * when an upgrade handles it, the delivery assertions built on this fail.
 */
export const failDocsCopy = Effect.gen(function* () {
  const browser = yield* Browser;
  yield* browser.use("Make the page's Markdown missing", (page) =>
    page.route(
      (url) => url.pathname.startsWith("/docs/") && url.pathname.endsWith(".md"),
      (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "" }),
    ),
  );
  yield* browser.use("Copy the page as Markdown", (page) =>
    page.locator("[data-blume-copy-page]").first().click(),
  );
});

/** The innermost frame of each reported exception, where the failure was raised. */
export const throwers = (event: SentryEvent) =>
  event.exception?.values.map((value) => value.stacktrace?.frames.at(-1)?.filename ?? "") ?? [];

/** Blume's missing-Markdown failure on one documentation page, captured automatically. */
export const docsCopyFailure = (pathname: string) => (event: SentryEvent) =>
  event.tags?.surface === "docs" &&
  event.request?.url !== undefined &&
  new URL(event.request.url).pathname.replace(/\/$/, "") === pathname.replace(/\/$/, "") &&
  automaticCapture(event) &&
  event.exception?.values.some((value) => /^Fetching \S+\.md failed \(404\)$/.test(value.value)) ===
    true;

/** The chunk directory and module Blume's page actions are built into. */
export const docsPageActionsChunk =
  /\/docs\/_astro\/PageActions\.astro_astro_type_script_[^/]*\.js$/;

/**
 * Report an explicit exception through the open page's own Sentry client. It
 * proves the surface's reporting is live without passing through the automatic
 * capture boundary, for surfaces whose code has no failure a scenario can raise.
 */
export const captureThroughPage = (message: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const captured = yield* browser.use("Report through the page's error client", (page) =>
      page.evaluate((message) => {
        const carrier: unknown = Reflect.get(globalThis, "__SENTRY__");
        if (typeof carrier !== "object" || carrier === null) return false;
        const version: unknown = Reflect.get(carrier, "version");
        const sdk: unknown =
          typeof version === "string" ? Reflect.get(carrier, version) : undefined;
        const scope: unknown =
          typeof sdk === "object" && sdk !== null
            ? Reflect.get(sdk, "defaultCurrentScope")
            : undefined;
        if (typeof scope !== "object" || scope === null) return false;
        const client: unknown = Reflect.apply(Reflect.get(scope, "getClient"), scope, []);
        if (typeof client !== "object" || client === null) return false;
        Reflect.apply(Reflect.get(client, "captureException"), client, [new Error(message)]);
        return true;
      }, message),
    );
    if (!captured) return yield* Effect.die(new Error("The page has no running error client"));
  });
