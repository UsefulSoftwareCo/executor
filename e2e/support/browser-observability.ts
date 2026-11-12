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

/** Keep the browser's real server request and trace, then replace only the response under test. */
export const injectDashboardResponse = (slug: string, body: string, status: number) =>
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
    yield* browser.use("Navigate to Apps in the browser", (page) =>
      page.getByRole("navigation").getByRole("link", { name: /^Apps/ }).click(),
    );
    yield* browser.use("Wait for the decoded operation failure", (page) =>
      page.waitForFunction(() => document.documentElement.hasAttribute("data-observed-failure")),
    );
    return trace;
  }).pipe(Effect.scoped);

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
