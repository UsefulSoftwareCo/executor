/** Browser failures must reach both OTLP and Sentry after real response decoding, naming their page. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import {
  analyticsPushPath,
  awaitSentry,
  awaitSentryWholeEnvironment,
  countAnalyticsPushes,
  injectDashboardResponse,
  observeOperationFailures,
  incompleteDashboardDocument,
  docsCopyFailure,
  docsPageActionsChunk,
  failDocsCopy,
  holdReplayChunks,
  holdTelemetryExports,
  sentryReports,
  throwers,
} from "../support/browser-observability.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { enableSessionRecording } from "../support/product-analytics.ts";
const Failure = Schema.fromJsonString(
  Schema.Struct({
    trace_id: Schema.String,
    span_id: Schema.String,
    error_type: Schema.String,
    page_id: Schema.String,
  }),
);

/**
 * Open a fresh dashboard document whose resources read answers `body` with `status`, and check that
 * the failure it reports reaches both OTLP and Sentry, correlated by its trace and naming its page.
 */
const decodedFailure = (
  name: string,
  body: string,
  status: number,
  kind: "BrowserDecodeFailed" | "BrowserOperationFailed",
) =>
  Effect.gen(function* () {
    const actors = yield* Actors,
      telemetry = yield* Telemetry,
      evidence = yield* Evidence,
      target = yield* Target;
    const injected = yield* injectDashboardResponse(actors.organization.slug, body, status);
    // The failure reported for the request whose response was replaced, by its trace.
    const failure = yield* Schema.decodeUnknownEffect(Failure)(injected.failure);
    expect(failure.error_type).toBe(kind);
    const trace = yield* telemetry.query(failure.trace_id).pipe(
      Effect.flatMap((trace) =>
        trace.data.some(({ span }) => span.operationName === "ui.api" && span.status === "error")
          ? Effect.succeed(trace)
          : Effect.fail(new Error("Decoded browser failure was not delivered")),
      ),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 30 }),
    );
    expect(
      trace.data.some(
        ({ span }) => span.operationName === "ui.api.transport" && span.status === "ok",
      ),
    ).toBe(true);
    expect(JSON.stringify(trace)).not.toContain("do-not-export");
    // The browser's API spans name the page that reported the failure.
    const browserSpans = trace.data.filter(({ span }) =>
      ["ui.api", "ui.api.transport"].includes(span.operationName),
    );
    expect(browserSpans.length).toBeGreaterThan(0);
    expect(browserSpans.map(({ span }) => span.tags["executor.page.id"])).toEqual(
      browserSpans.map(() => failure.page_id),
    );
    const reported = yield* awaitSentry(
      { traces: [failure.trace_id] },
      (event) => event.contexts?.trace?.trace_id === failure.trace_id,
    );
    expect(reported).toHaveLength(1);
    // No browser file names the build; the page reads its release from the document.
    expect(reported[0]?.release).toBe(target.metadata.commit);
    expect(JSON.stringify(reported)).not.toContain("do-not-export");
    yield* evidence.json(`${name}-failure.json`, { failure, trace, reported });
    return failure;
  });

/** Sign the owner in and record the page's operation failures, on the managed Cloud target. */
const signedIn = Effect.gen(function* () {
  const browser = yield* Browser,
    actors = yield* Actors,
    target = yield* Target;
  expect(target.metadata.mode).toBe("managed");
  yield* browser.login(actors.owner);
  yield* observeOperationFailures;
});

layer(HostedLive, { excludeTestServices: true })("Browser observability", (it) => {
  it.effect(scenarios.browserFailureSchema.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        yield* signedIn;
        const pushes = yield* countAnalyticsPushes;
        const failure = yield* decodedFailure(
          "schema",
          '{"privateFixture":"do-not-export"}',
          200,
          "BrowserDecodeFailed",
        );
        // The page sent analytics events before the report, and none became a breadcrumb on it:
        // the dashboard's analytics are not sent to the error tracker.
        expect(yield* pushes.count).toBeGreaterThan(0);
        const [report] = yield* sentryReports(failure.trace_id);
        expect(report?.breadcrumbs.some(({ category }) => category === "fetch")).toBe(true);
        expect(
          report?.breadcrumbs.filter(
            ({ path }) => path !== undefined && analyticsPushPath.test(path),
          ),
        ).toEqual([]);
      }).pipe(Effect.scoped),
    ),
  );
  it.effect(scenarios.browserFailureJson.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        yield* signedIn;
        const first = yield* decodedFailure("json", "{", 200, "BrowserDecodeFailed");
        const second = yield* decodedFailure("json-again", "{", 200, "BrowserDecodeFailed");
        // Each failure came from a fresh document, and each document has its own page id.
        expect(second.page_id).not.toBe(first.page_id);
      }),
    ),
  );
  it.effect(scenarios.browserFailureServer.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        yield* signedIn;
        yield* decodedFailure(
          "server",
          '{"_tag":"AuthenticationUnavailable"}',
          503,
          "BrowserOperationFailed",
        );
      }),
    ),
  );
  it.effect(scenarios.browserFailureEntryModule.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors,
          evidence = yield* Evidence;
        yield* signedIn;
        let blockedEntryRequests = 0;
        yield* browser.use("Fail the built dashboard entry module", (page) =>
          page.route("**/assets/main-*.js", (route) => {
            blockedEntryRequests++;
            return route.abort("failed");
          }),
        );
        yield* browser.use("Open the dashboard with a missing entry module", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        const moduleFailure = yield* awaitSentry(
          { organizationSlug: actors.organization.slug },
          (event) =>
            event.exception?.values.some((value) =>
              value.value.includes("Failed to fetch dynamically imported module"),
            ) === true,
        );
        yield* evidence.json("entry-module-failure.json", moduleFailure);
        expect(blockedEntryRequests).toBeGreaterThan(0);
        yield* browser.use("Restore the dashboard entry module", (page) =>
          page.unroute("**/assets/main-*.js"),
        );
      }),
    ),
  );
  it.effect(scenarios.browserFailureBoot.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          evidence = yield* Evidence;
        yield* signedIn;
        yield* incompleteDashboardDocument(actors.organization.slug);
        const boot = yield* awaitSentry(
          { organizationSlug: actors.organization.slug },
          (event) =>
            event.exception?.values.some(
              (value) => value.value === "Dashboard document is incomplete",
            ) === true,
        );
        yield* evidence.json("boot-failure.json", boot);
      }),
    ),
  );
  it.effect(scenarios.browserFailureDocs.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          evidence = yield* Evidence;
        yield* signedIn;
        yield* browser.use("Open documentation", (page) => page.goto("/docs/"));
        yield* browser.use("Confirm documentation is rendered", (page) =>
          page.getByRole("heading", { level: 1 }).waitFor(),
        );
        // A real failure raised by the documentation's own code, captured automatically.
        yield* failDocsCopy;
        // The docs are no organization's page: any scenario that breaks the docs copy reports this.
        const docs = yield* awaitSentryWholeEnvironment(docsCopyFailure("/docs/"));
        expect(docs[0] === undefined ? [] : throwers(docs[0])).toEqual([
          expect.stringMatching(docsPageActionsChunk),
        ]);
        yield* evidence.json("docs-failure.json", docs);
      }),
    ),
  );
  // A failure reported while the page's own trace and log exports are still in flight, as when
  // load slows their collector, still reaches Sentry. The browser refuses a keepalive request once
  // the page's keepalive bodies in flight would pass 64 KiB, so the report cannot count on room the
  // exports left.
  it.effect(scenarios.browserReportsWhileExporting.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors,
          evidence = yield* Evidence;
        yield* signedIn;
        const whileExporting = yield* Effect.gen(function* () {
          const exports = yield* holdTelemetryExports;
          const injected = yield* injectDashboardResponse(
            actors.organization.slug,
            "{",
            200,
            Effect.gen(function* () {
              yield* exports.held;
              // Work the page records while its first exports are held goes in the next ones.
              for (let round = 1; round <= 3; round++) {
                yield* browser.use(`Open Groups in the browser (${round} of 3)`, (page) =>
                  page
                    .getByRole("navigation")
                    .getByRole("link", { name: /^Groups/ })
                    .click()
                    .then(() => page.waitForURL(/\/groups$/)),
                );
                yield* browser.use(`Go back to the organization page (${round} of 3)`, (page) =>
                  page.goBack().then(() => page.waitForURL(/\/organization$/)),
                );
              }
              yield* exports.next;
            }),
          );
          // What was held when the page reported the failure, before waiting for the report.
          const heldExportBytes = yield* exports.heldBytes;
          const failure = yield* Schema.decodeUnknownEffect(Failure)(injected.failure);
          expect(failure.error_type).toBe("BrowserDecodeFailed");
          const reported = yield* awaitSentry(
            { traces: [failure.trace_id] },
            (event) => event.contexts?.trace?.trace_id === failure.trace_id,
          );
          const reports = yield* sentryReports(failure.trace_id);
          return {
            failure,
            reported,
            heldExportBytes,
            reportBytes: reports.map(({ bytes }) => bytes),
          };
        }).pipe(Effect.scoped);
        expect(whileExporting.reported).toHaveLength(1);
        // The held exports and the report together were more than the page's 64 KiB.
        expect(whileExporting.reportBytes).toHaveLength(1);
        expect(
          whileExporting.heldExportBytes + (whileExporting.reportBytes[0] ?? 0),
        ).toBeGreaterThan(65_536);
        yield* evidence.json("failure-while-exporting.json", whileExporting);
      }),
    ),
  );
  // A failure reported while session replay is recording, and its chunks are still in flight,
  // still reaches Sentry. PostHog's requests leave the page's keepalive quota to its reports.
  it.effect(scenarios.browserReportsWhileReplaying.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors,
          evidence = yield* Evidence;
        yield* signedIn;
        yield* browser.use("Turn session recording on", enableSessionRecording);
        const whileReplaying = yield* Effect.gen(function* () {
          const chunks = yield* holdReplayChunks;
          const injected = yield* injectDashboardResponse(
            actors.organization.slug,
            "{",
            200,
            Effect.gen(function* () {
              // Groups is a page replay records; clicks there are the interaction it waits for.
              yield* browser.use("Open Groups in the browser", (page) =>
                page
                  .getByRole("navigation")
                  .getByRole("link", { name: /^Groups/ })
                  .click()
                  .then(() => page.waitForURL(/\/groups$/)),
              );
              // Replay ships its chunks once the person interacts; click until one is held.
              yield* browser
                // The page's heading does nothing when clicked, unlike its empty-state actions.
                .use("Interact with the recorded page", (page) =>
                  page.getByRole("heading", { level: 1, name: "Groups" }).click(),
                )
                .pipe(
                  Effect.andThen(chunks.sizes),
                  Effect.repeat({
                    schedule: Schedule.spaced("250 millis"),
                    until: (sizes) => sizes.length > 0,
                  }),
                  Effect.timeout("30 seconds"),
                );
            }),
          );
          // What was held when the page reported the failure, before waiting for the report.
          const heldChunks = yield* chunks.sizes;
          const failure = yield* Schema.decodeUnknownEffect(Failure)(injected.failure);
          const reported = yield* awaitSentry(
            { traces: [failure.trace_id] },
            (event) => event.contexts?.trace?.trace_id === failure.trace_id,
          );
          const reports = yield* sentryReports(failure.trace_id);
          return { failure, reported, heldChunks, reportBytes: reports.map(({ bytes }) => bytes) };
        }).pipe(Effect.scoped);
        expect(whileReplaying.reported).toHaveLength(1);
        expect(whileReplaying.heldChunks.length).toBeGreaterThan(0);
        yield* evidence.json("failure-while-replaying.json", whileReplaying);
      }),
    ),
  );
});
