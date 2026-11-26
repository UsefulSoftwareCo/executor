import { Clock, Duration, Effect, Schedule, Schema } from "effect";
import type { Request as PlaywrightRequest } from "playwright";
import { Browser } from "./browser.ts";
import { driver } from "./platform.ts";
import { replaceResponses } from "./browser-responses.ts";
import { collectorLinesWholeEnvironment, field, parseLeniently } from "./collector-events.ts";
import { scopeOf, type Scope } from "./scope.ts";

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

export const automaticCapture = (event: SentryEvent) =>
  event.exception?.values.some((value) => value.mechanism?.type.startsWith("auto.browser.")) ===
  true;

export type BrowserSentryScope = Scope<{
  readonly traces: ReadonlyArray<string>;
  readonly page: string;
  readonly organizationSlug: string;
}>;

const eventItems = collectorLinesWholeEnvironment("sentry.ndjson").pipe(
  Effect.map((lines) =>
    lines.flatMap((line) => {
      const envelope = field(parseLeniently(line), "envelope");
      return typeof envelope === "string" ? envelope.split("\n").slice(2).filter(Boolean) : [];
    }),
  ),
);
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

export const sentryEventsWholeEnvironment = eventItems.pipe(Effect.map(decode));

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
export const awaitSentry = (
  scope: BrowserSentryScope,
  predicate: (event: SentryEvent) => boolean,
) => awaitAny(sentryEvents(scope), predicate);
export const awaitSentryWholeEnvironment = (predicate: (event: SentryEvent) => boolean) =>
  awaitAny(sentryEventsWholeEnvironment, predicate);

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

export const holdUnseenKeepalive = Effect.gen(function* () {
  const browser = yield* Browser;
  const path = unseenKeepalivePath;
  const unseen = (url: URL) => url.pathname === path;
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = () => {};
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const handled = new Set<Promise<void>>();
  yield* Effect.acquireRelease(
    browser.use("Hold another sender's keepalive request", (page) =>
      page.route(unseen, (route) => {
        arrived();
        const handling = released.then(() => route.fallback());
        handled.add(handling);
        return handling;
      }),
    ),
    () =>
      Effect.sync(release).pipe(
        Effect.andThen(driver("Let the other sender's request go", () => Promise.all(handled))),
        Effect.andThen(
          browser.use("Stop holding the other sender's requests", (page) => page.unroute(unseen)),
        ),
        Effect.orDie,
      ),
  );
  return {
    send: (bytes: number) =>
      browser
        .use("Send another sender's keepalive request", (page) =>
          page.evaluate(
            ({ path, bytes }) => {
              void fetch(path, { method: "POST", body: "x".repeat(bytes), keepalive: true }).catch(
                () => {},
              );
            },
            { path, bytes },
          ),
        )
        .pipe(
          Effect.andThen(
            browser
              .use("Wait until the other sender's request is held", () => arrival)
              .pipe(Effect.timeout("15 seconds")),
          ),
        ),
  };
});

const unseenKeepalivePath = "/__unseen-keepalive";

export const recordTelemetryExports = Effect.gen(function* () {
  const browser = yield* Browser;
  const bodies: Array<string> = [];
  const exports = (url: URL) => /^\/api\/telemetry\/(?:traces|logs)$/.test(url.pathname);
  const inFlight = new Set<PlaywrightRequest>();
  const started = (request: PlaywrightRequest) => {
    if (new URL(request.url()).pathname !== unseenKeepalivePath) inFlight.add(request);
  };
  const ended = (request: PlaywrightRequest) => {
    inFlight.delete(request);
  };
  yield* Effect.acquireRelease(
    browser.use("Record the page's telemetry exports", (page) => {
      page.on("request", started);
      page.on("requestfinished", ended);
      page.on("requestfailed", ended);
      return page.route(exports, (route) => {
        bodies.push(route.request().postData() ?? "");
        return route.fallback();
      });
    }),
    () =>
      browser
        .use("Stop recording telemetry exports", (page) => {
          page.off("request", started);
          page.off("requestfinished", ended);
          page.off("requestfailed", ended);
          return page.unroute(exports);
        })
        .pipe(Effect.orDie),
  );
  return {
    bodies: Effect.sync(() => [...bodies]),
    idle: (quiet: Duration.Input) =>
      Effect.gen(function* () {
        let seen = -1;
        let since = 0;
        while (true) {
          const now = yield* Clock.currentTimeMillis;
          if (bodies.length !== seen || inFlight.size > 0) {
            seen = bodies.length;
            since = now;
          } else if (now - since >= Duration.toMillis(Duration.fromInputUnsafe(quiet))) return;
          yield* Effect.sleep("100 millis");
        }
      }).pipe(Effect.timeout("20 seconds")),
  };
});

export const countAnalyticsPushes = Effect.gen(function* () {
  const browser = yield* Browser;
  const pageIds: Array<string | undefined> = [];
  const pushes = (url: URL) => /^\/api\/[a-f0-9]{16}\/push$/.test(url.pathname);
  yield* Effect.acquireRelease(
    browser.use("Record the page's analytics events", (page) =>
      page.route(pushes, (route) => {
        const pageId = field(
          parseLeniently(route.request().postData() ?? ""),
          "properties",
          "page_id",
        );
        pageIds.push(typeof pageId === "string" ? pageId : undefined);
        return route.fallback();
      }),
    ),
    () =>
      browser
        .use("Stop recording analytics events", (page) => page.unroute(pushes))
        .pipe(Effect.orDie),
  );
  return { pageIds: Effect.sync(() => [...pageIds]) };
});

export const analyticsPushPath = /^\/api\/[a-f0-9]{16}\/push$/;

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

export const breakDashboardReads = Effect.gen(function* () {
  const traces: Array<string> = [];
  yield* replaceResponses("*/api/organizations/*/resources*", (response) => {
    const trace = response.requestHeaders["traceparent"]?.split("-")[1];
    if (trace !== undefined) traces.push(trace);
    return { status: response.status, body: "{", contentType: "application/json" };
  });
  return traces;
});

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

export const throwers = (event: SentryEvent) =>
  event.exception?.values.map((value) => value.stacktrace?.frames.at(-1)?.filename ?? "") ?? [];

export const docsCopyFailure = (pathname: string) => (event: SentryEvent) =>
  event.tags?.surface === "docs" &&
  event.request?.url !== undefined &&
  new URL(event.request.url).pathname.replace(/\/$/, "") === pathname.replace(/\/$/, "") &&
  automaticCapture(event) &&
  event.exception?.values.some((value) => /^Fetching \S+\.md failed \(404\)$/.test(value.value)) ===
    true;

export const docsPageActionsChunk =
  /\/docs\/_astro\/PageActions\.astro_astro_type_script_[^/]*\.js$/;

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
