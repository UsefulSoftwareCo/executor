/** Inject response and document failures through Playwright's real network boundary. */
import { Effect, FileSystem, Schedule, Schema } from "effect";
import { Browser } from "./browser.ts";
import { Target } from "./platform.ts";

const Envelope = Schema.fromJsonString(Schema.Struct({ envelope: Schema.String }));
/** The safe subset of a delivered Sentry event that scenarios assert on. */
export const SentryEvent = Schema.fromJsonString(
  Schema.Struct({
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

/** Every event the managed Cloud target's loopback Sentry receiver has accepted so far. */
export const sentryEvents = Effect.gen(function* () {
  const target = yield* Target;
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(`${target.directory}/sentry.ndjson`);
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) =>
      Schema.decodeUnknownSync(Envelope)(line)
        .envelope.split("\n")
        .slice(2)
        .filter(Boolean)
        .map((value) => Schema.decodeUnknownSync(SentryEvent)(value)),
    );
});

/** Wait until at least one delivered event matches. */
export const awaitSentry = (predicate: (event: SentryEvent) => boolean) =>
  sentryEvents.pipe(
    Effect.map((events) => events.filter(predicate)),
    Effect.repeat({
      schedule: Schedule.spaced("200 millis"),
      until: (events) => events.length > 0,
    }),
    Effect.timeout("15 seconds"),
  );

/** Keep the real server request and trace, then replace only the response under test. */
export const injectDashboardResponse = (slug: string, body: string, status: number) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    let trace: string | undefined;
    yield* browser.use("Leave the previous document", (page) => page.goto("about:blank"));
    yield* browser.use("Replace the resource response", (page) =>
      page.route("**/api/organizations/*/resources*", (route) =>
        route.fetch().then((response) => {
          trace = route.request().headers()["traceparent"]?.split("-")[1];
          return route.fulfill({ response, status, body, contentType: "application/json" });
        }),
      ),
    );
    yield* browser.use("Open the dashboard", (page) => page.goto(`/org/${slug}/apps`));
    yield* browser.use("Wait for the decoded operation failure", (page) =>
      page.waitForFunction(() => document.documentElement.hasAttribute("data-observed-failure")),
    );
    yield* browser.use("Restore the resource route", (page) =>
      page.unroute("**/api/organizations/*/resources*"),
    );
    return trace;
  });

/** Corrupt synthetic private entry data before any authored dashboard code executes. */
export const corruptDashboardEntry = (slug: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use("Leave the previous document", (page) => page.goto("about:blank"));
    yield* browser.use("Corrupt the private entry before module execution", (page) =>
      page.addInitScript(() => {
        const observer = new MutationObserver(() => {
          if (document.head === null) return;
          const entry =
            document.getElementById("executor-entry") ?? document.createElement("script");
          entry.id = "executor-entry";
          entry.setAttribute("type", "application/json");
          entry.textContent = '{"invalid":true}';
          if (!entry.isConnected) document.head.append(entry);
          document.documentElement.setAttribute("data-corrupt-entry", "true");
          observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
      }),
    );
    yield* browser.use("Open the corrupt document", (page) => page.goto(`/org/${slug}/apps`));
  });

/**
 * Replace every dashboard resource response with an undecodable body while the
 * real request and its trace still happen. Each read then fails in the
 * dashboard's own decoder, which reports it with the request's trace.
 */
export const breakDashboardReads = Effect.gen(function* () {
  const browser = yield* Browser;
  const traces: Array<string> = [];
  yield* browser.use("Break the resource responses", (page) =>
    page.route("**/api/organizations/*/resources*", (route) =>
      route.fetch().then((response) => {
        const trace = route.request().headers()["traceparent"]?.split("-")[1];
        if (trace !== undefined) traces.push(trace);
        return route.fulfill({ response, body: "{", contentType: "application/json" });
      }),
    ),
  );
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
