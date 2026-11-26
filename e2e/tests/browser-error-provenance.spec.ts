import { expect, layer } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import {
  awaitSentry,
  awaitSentryWholeEnvironment,
  breakDashboardReads,
  captureThroughPage,
  docsCopyFailure,
  docsPageActionsChunk,
  failDocsCopy,
  sentryEventsWholeEnvironment,
  throwers,
  type SentryEvent,
} from "../support/browser-observability.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const mentions = (event: SentryEvent, text: string) =>
  event.exception?.values.some((value) => value.value.includes(text)) === true;

const docsPage = "/docs/api-keys";
const docsControl = docsCopyFailure(docsPage);

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
    yield* browser.use("Run an injected document script", (page) =>
      page.addScriptTag({ content: `window.__firefox__[${JSON.stringify(reader)}];` }),
    );
    yield* browser.use("Register an injected focus listener", (page) =>
      page.addScriptTag({
        content: `document.addEventListener("focusin", function caret() {
          window.webkit[${JSON.stringify(bridge)}].postMessage({});
        }, { once: true });`,
      }),
    );
    yield* browser.use("Move keyboard focus", (page) => page.keyboard.press("Tab"));
    yield* browser.use("Let the page's queued timers run", (page) =>
      page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0))),
    );
    yield* browser.use("Run conflicting wallet injections", (page) =>
      page.addScriptTag({
        content: `Object.defineProperty(window, ${JSON.stringify(wallet)}, { value: {} });
          Object.defineProperty(window, ${JSON.stringify(wallet)}, { value: {} });`,
      }),
    );
    yield* browser.use("Reject with a bare value", (page) =>
      page.addScriptTag({
        content: `Promise.reject("Object Not Found Matching Id:3, ParamCount:4 " + ${JSON.stringify(scanner)});`,
      }),
    );
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
    yield* browser.use("Raise an evaluated failure", (page) =>
      page.evaluate((message) => {
        window.dispatchEvent(new ErrorEvent("error", { error: new Error(message), message }));
      }, evaluated),
    );
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

const deliveredOf = (foreign: ReadonlyArray<string>) =>
  sentryEventsWholeEnvironment.pipe(
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

        const traces = yield* breakDashboardReads;
        yield* browser.use("Open the dashboard", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("The failed read is shown", (page) =>
          page.getByRole("button", { name: "Retry" }).first().waitFor(),
        );
        yield* awaitSentry(
          { traces: [traces[0]!] },
          (event) => event.contexts?.trace?.trace_id === traces[0],
        );
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
        yield* awaitSentry(
          { traces: [traces.at(-1)!] },
          (event) => event.contexts?.trace?.trace_id === traces.at(-1),
        );
        delivered.dashboard = yield* deliveredOf(dashboard);
        yield* browser.use("Restore the resource responses", (page) =>
          page.unroute("**/api/organizations/*/resources*"),
        );

        yield* browser.use("Open the marketing site", (page) => page.goto("/home"));
        const marketing = yield* raiseForeignFailures("marketing", pageErrors);
        const sentinel = `marketing-sentinel-${randomUUID().slice(0, 8)}`;
        yield* captureThroughPage(sentinel);
        const [marketingSentinel] = yield* awaitSentryWholeEnvironment((event) =>
          mentions(event, sentinel),
        );
        expect(marketingSentinel?.tags?.surface).toBe("marketing");
        expect(new URL(marketingSentinel?.request?.url ?? "http://invalid/").pathname).toBe(
          "/home",
        );
        delivered.marketing = yield* deliveredOf(marketing);

        yield* browser.use("Open the documentation", (page) => page.goto(docsPage));
        yield* browser.use("The documentation is rendered", (page) =>
          page.getByRole("heading", { level: 1 }).first().waitFor(),
        );
        yield* failDocsCopy;
        const [docsReady] = yield* awaitSentryWholeEnvironment(docsControl);
        expect(docsReady === undefined ? [] : throwers(docsReady)).toEqual([
          expect.stringMatching(docsPageActionsChunk),
        ]);
        const docs = yield* raiseForeignFailures("docs", pageErrors);
        yield* failDocsCopy;
        yield* sentryEventsWholeEnvironment.pipe(
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
