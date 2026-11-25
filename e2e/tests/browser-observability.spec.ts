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
  holdUnseenKeepalive,
  recordTelemetryExports,
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

const decodedFailure = <E = never, R = never>(
  name: string,
  body: string,
  status: number,
  kind: "BrowserDecodeFailed" | "BrowserOperationFailed",
  beforeFailing: Effect.Effect<unknown, E, R> = Effect.void,
) =>
  Effect.gen(function* () {
    const actors = yield* Actors,
      telemetry = yield* Telemetry,
      evidence = yield* Evidence,
      target = yield* Target;
    const injected = yield* injectDashboardResponse(
      actors.organization.slug,
      body,
      status,
      beforeFailing,
    );
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
    expect(reported[0]?.release).toBe(target.metadata.commit);
    expect(JSON.stringify(reported)).not.toContain("do-not-export");
    yield* evidence.json(`${name}-failure.json`, { failure, trace, reported });
    return failure;
  });

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
        const evidence = yield* Evidence;
        yield* signedIn;
        const pushes = yield* countAnalyticsPushes;
        let sentBeforeFailure: ReadonlyArray<string | undefined> = [];
        const failure = yield* decodedFailure(
          "schema",
          '{"privateFixture":"do-not-export"}',
          200,
          "BrowserDecodeFailed",
          Effect.map(pushes.pageIds, (pageIds) => {
            sentBeforeFailure = pageIds;
          }),
        );
        const ownBeforeFailure = sentBeforeFailure.filter((id) => id === failure.page_id).length;
        yield* evidence.json("analytics-before-failure.json", {
          failingPage: ownBeforeFailure,
          otherPages: sentBeforeFailure.length - ownBeforeFailure,
        });
        expect(ownBeforeFailure).toBeGreaterThan(0);
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
        yield* failDocsCopy;
        const docs = yield* awaitSentryWholeEnvironment(docsCopyFailure("/docs/"));
        expect(docs[0] === undefined ? [] : throwers(docs[0])).toEqual([
          expect.stringMatching(docsPageActionsChunk),
        ]);
        yield* evidence.json("docs-failure.json", docs);
      }),
    ),
  );
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
        expect(whileExporting.reportBytes).toHaveLength(1);
        expect(
          whileExporting.heldExportBytes + (whileExporting.reportBytes[0] ?? 0),
        ).toBeGreaterThan(65_536);
        yield* evidence.json("failure-while-exporting.json", whileExporting);
      }),
    ),
  );
  it.effect(scenarios.browserReportsWhileQuotaFull.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        yield* signedIn;
        const unseen = yield* holdUnseenKeepalive;
        const unseenBytes = 60_000;
        const injected = yield* injectDashboardResponse(
          actors.organization.slug,
          "{",
          200,
          unseen.send(unseenBytes),
        );
        const failure = yield* Schema.decodeUnknownEffect(Failure)(injected.failure);
        const reported = yield* awaitSentry(
          { traces: [failure.trace_id] },
          (event) => event.contexts?.trace?.trace_id === failure.trace_id,
        );
        expect(reported).toHaveLength(1);
        const reports = yield* sentryReports(failure.trace_id);
        expect(reports).toHaveLength(1);
        expect(unseenBytes + (reports[0]?.bytes ?? 0)).toBeGreaterThan(65_536);
        const resends = yield* telemetry
          .spans(
            "ui.keepalive.resend",
            { page: failure.page_id },
            {
              "executor.keepalive.sender": "error-reports",
            },
          )
          .pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              until: (spans) => spans.length > 0,
            }),
            Effect.timeout("15 seconds"),
          );
        expect(resends.map((tags) => tags["executor.keepalive.outcome"])).toEqual(["resent"]);
        const failedResends = yield* telemetry.spans(
          "ui.keepalive.resend",
          { page: failure.page_id },
          { "executor.keepalive.outcome": "resend-failed" },
        );
        expect(failedResends).toEqual([]);
        yield* evidence.json("failure-while-quota-full.json", {
          failure,
          reported,
          unseenBytes,
          reportBytes: reports.map(({ bytes }) => bytes),
          resends,
        });
      }).pipe(Effect.scoped),
    ),
  );
  it.effect(scenarios.browserIdleWhileQuotaHeld.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors,
          evidence = yield* Evidence;
        yield* signedIn;
        const unseen = yield* holdUnseenKeepalive;
        const exports = yield* recordTelemetryExports;
        yield* browser.use("Open a page that does not read resources", (page) =>
          page.goto(`/org/${actors.organization.slug}/organization`),
        );
        yield* exports.idle("2 seconds");
        yield* unseen.send(65_000);
        yield* browser.use("Open Groups in the browser", (page) =>
          page
            .getByRole("navigation")
            .getByRole("link", { name: /^Groups/ })
            .click()
            .then(() => page.waitForURL(/\/groups$/)),
        );
        yield* exports.idle("2 seconds").pipe(Effect.orElseSucceed(() => undefined));
        const settled = (yield* exports.bodies).length;
        yield* Effect.sleep("5 seconds");
        const idle = (yield* exports.bodies).slice(settled);
        const quiet = idle.length;
        yield* browser.use("Go back to the organization page", (page) =>
          page.goBack().then(() => page.waitForURL(/\/organization$/)),
        );
        const carried = yield* exports.bodies.pipe(
          Effect.map((bodies) =>
            bodies
              .slice(settled + quiet)
              .filter((body) => body.includes("executor.keepalive.export_resends")),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("250 millis"),
            until: (bodies) => bodies.length > 0,
          }),
          Effect.timeout("15 seconds"),
          Effect.orElseSucceed(() => []),
        );
        yield* evidence.json("idle-while-quota-held.json", {
          exportsBeforeQuiet: settled,
          exportsWhileIdle: quiet,
          idleExportsOfResendRecords: idle.filter((body) => body.includes("ui.keepalive.resend"))
            .length,
          exportsCarryingResends: carried.length,
        });
        expect(quiet, "exports the idle page started").toBe(0);
        expect(carried.length).toBeGreaterThan(0);
      }).pipe(Effect.scoped),
    ),
  );
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
              yield* browser.use("Open Groups in the browser", (page) =>
                page
                  .getByRole("navigation")
                  .getByRole("link", { name: /^Groups/ })
                  .click()
                  .then(() => page.waitForURL(/\/groups$/)),
              );
              yield* browser
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
