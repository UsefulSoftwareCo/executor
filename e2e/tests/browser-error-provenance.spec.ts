/**
 * Page-wide error handlers see failures from every script on the page. Only
 * failures raised by our own built chunks may reach Sentry automatically;
 * injected page code, extension listeners, bare rejection values and proxied
 * vendor scripts on our origin are someone else's failures. Each surface's own
 * reports raised on the same documents must still arrive.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import {
  awaitSentry,
  breakDashboardReads,
  captureThroughPage,
  docsCopyFailure,
  docsPageActionsChunk,
  failDocsCopy,
  sentryEvents,
  throwers,
  type SentryEvent,
} from "../support/browser-observability.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const mentions = (event: SentryEvent, text: string) =>
  event.exception?.values.some((value) => value.value.includes(text)) === true;

/** A documentation page no other scenario copies from, so its reports are this scenario's own. */
const docsPage = "/docs/api-keys";
const docsControl = docsCopyFailure(docsPage);

/** Raise six foreign failures on the open document and return the text each one carries. */
const raiseForeignFailures = (surface: string, pageErrors: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const run = randomUUID().slice(0, 8);
    const marker = (kind: string) => `${kind}-${surface}-${run}`;
    const reader = marker("reader"),
      bridge = marker("messageHandlers"),
      wallet = marker("ethereum"),
      scanner = marker("MethodName"),
      vendorTimeout = marker("vendor-timeout"),
      evaluated = marker("devtools");
    // In-app browser reader scripts evaluated in the page's own document.
    yield* browser.use("Run an injected document script", (page) =>
      page.addScriptTag({ content: `window.__firefox__[${JSON.stringify(reader)}];` }),
    );
    // An injected bridge listener fails when the page moves focus.
    yield* browser.use("Register an injected focus listener", (page) =>
      page.addScriptTag({
        content: `document.addEventListener("focusin", function caret() {
          window.webkit[${JSON.stringify(bridge)}].postMessage({});
        }, { once: true });`,
      }),
    );
    yield* browser.use("Move keyboard focus", (page) => page.keyboard.press("Tab"));
    // Sentry ignores the page's next uncaught error until a timer it queued when
    // the wrapped listener rethrew has run; a later timer runs after it.
    yield* browser.use("Let the page's queued timers run", (page) =>
      page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0))),
    );
    // Two wallet extensions race to define the same provider.
    yield* browser.use("Run conflicting wallet injections", (page) =>
      page.addScriptTag({
        content: `Object.defineProperty(window, ${JSON.stringify(wallet)}, { value: {} });
          Object.defineProperty(window, ${JSON.stringify(wallet)}, { value: {} });`,
      }),
    );
    // Link scanners reject with a bare string.
    yield* browser.use("Reject with a bare value", (page) =>
      page.addScriptTag({
        content: `Promise.reject("Object Not Found Matching Id:3, ParamCount:4 " + ${JSON.stringify(scanner)});`,
      }),
    );
    // A vendor library served through our own origin, outside our built chunks.
    const vendor = `/api/0123456789abcdef/static/array-${run}.js`;
    yield* browser.use("Serve a proxied vendor script", (page) =>
      page.route(`**${vendor}`, (route) =>
        route.fulfill({
          contentType: "text/javascript",
          body: `setTimeout(function timeout() {
            var error = new Error("Request timed out after 3000ms " + ${JSON.stringify(vendorTimeout)});
            error.name = "AbortError";
            Promise.reject(error);
          }, 0);`,
        }),
      ),
    );
    yield* browser.use("Load the proxied vendor script", (page) =>
      page.addScriptTag({ url: vendor }),
    );
    // Code evaluated by developer tools or automation.
    yield* browser.use("Raise an evaluated failure", (page) =>
      page.evaluate((message) => {
        window.dispatchEvent(new ErrorEvent("error", { error: new Error(message), message }));
      }, evaluated),
    );
    // Every script-raised failure reached the page's own uncaught-error handlers.
    const raised = [reader, bridge, wallet, scanner, vendorTimeout];
    const unobserved = () =>
      raised.filter((text) => !pageErrors.some((message) => message.includes(text)));
    yield* Effect.sync(unobserved).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("100 millis"),
        until: (missing) => missing.length === 0,
      }),
      Effect.timeoutOption("10 seconds"),
    );
    expect(unobserved(), surface).toEqual([]);
    return [...raised, evaluated];
  });

/** Every delivered report of these failures, and where each one was reported from. */
const deliveredOf = (foreign: ReadonlyArray<string>) =>
  sentryEvents.pipe(
    Effect.map((events) =>
      events
        .filter((event) => foreign.some((text) => mentions(event, text)))
        .map((event) => ({
          surface: event.tags?.surface,
          path: event.request?.url === undefined ? undefined : new URL(event.request.url).pathname,
          values: event.exception?.values.map((value) => value.value),
        })),
    ),
  );

layer(HostedLive, { excludeTestServices: true })("Browser error provenance", (it) => {
  it.effect(scenarios.browserErrorProvenance.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        const evidence = yield* Evidence;
        const target = yield* Target;
        expect(target.metadata.mode).toBe("managed");
        const pageErrors: Array<string> = [];
        yield* browser.login(actors.owner);
        yield* browser.use("Record uncaught page errors", (page) => {
          page.on("pageerror", (error) => pageErrors.push(error.message));
          return Promise.resolve();
        });
        const delivered: Record<string, ReadonlyArray<unknown>> = {};

        // Dashboard: its own decoder reports each broken read before and after the foreign
        // failures. Those reports are explicit, so they bypass the automatic boundary.
        const traces = yield* breakDashboardReads;
        yield* browser.use("Open the dashboard", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("The failed read is shown", (page) =>
          page.getByRole("button", { name: "Retry" }).first().waitFor(),
        );
        yield* awaitSentry((event) => event.contexts?.trace?.trace_id === traces[0]);
        const dashboard = yield* raiseForeignFailures("dashboard", pageErrors);
        const readsBefore = traces.length;
        yield* browser.use("Retry the failed read", (page) =>
          page.getByRole("button", { name: "Retry" }).first().click(),
        );
        yield* Effect.sync(() => traces.length).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: (reads) => reads > readsBefore,
          }),
          Effect.timeout("10 seconds"),
        );
        yield* awaitSentry((event) => event.contexts?.trace?.trace_id === traces.at(-1));
        delivered.dashboard = yield* deliveredOf(dashboard);
        yield* browser.use("Restore the resource responses", (page) =>
          page.unroute("**/api/organizations/*/resources*"),
        );

        // Marketing's code has no failure a scenario can raise, so its own error client
        // reports a sentinel after the foreign failures; the transport keeps their order.
        yield* browser.use("Open the marketing site", (page) => page.goto("/home"));
        yield* browser.use("Dismiss the early preview notice", (page) =>
          page.getByRole("button", { name: "Got it" }).click(),
        );
        const marketing = yield* raiseForeignFailures("marketing", pageErrors);
        const sentinel = `marketing-sentinel-${randomUUID().slice(0, 8)}`;
        yield* captureThroughPage(sentinel);
        const [marketingSentinel] = yield* awaitSentry((event) => mentions(event, sentinel));
        expect(marketingSentinel?.tags?.surface).toBe("marketing");
        expect(new URL(marketingSentinel?.request?.url ?? "http://invalid/").pathname).toBe(
          "/home",
        );
        delivered.marketing = yield* deliveredOf(marketing);

        // Docs: Blume's own copy action fails before and after the foreign failures,
        // raised from its page-actions chunk and captured automatically.
        yield* browser.use("Open the documentation", (page) => page.goto(docsPage));
        yield* browser.use("The documentation is rendered", (page) =>
          page.getByRole("heading", { level: 1 }).first().waitFor(),
        );
        yield* failDocsCopy;
        const [docsReady] = yield* awaitSentry(docsControl);
        expect(docsReady === undefined ? [] : throwers(docsReady)).toEqual([
          expect.stringMatching(docsPageActionsChunk),
        ]);
        const docs = yield* raiseForeignFailures("docs", pageErrors);
        yield* failDocsCopy;
        yield* sentryEvents.pipe(
          Effect.map((events) => events.filter(docsControl)),
          Effect.repeat({
            schedule: Schedule.spaced("200 millis"),
            until: (events) => events.length >= 2,
          }),
          Effect.timeout("15 seconds"),
        );
        delivered.docs = yield* deliveredOf(docs);

        yield* evidence.json("foreign-failures.json", { dashboard, marketing, docs, delivered });
        expect(delivered).toEqual({ dashboard: [], marketing: [], docs: [] });
      }),
    ),
  );
});
