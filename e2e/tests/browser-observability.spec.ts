/** Browser failures must reach both OTLP and Sentry after real response decoding. */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schedule, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import {
  injectDashboardResponse,
  corruptDashboardEntry,
} from "../support/browser-observability.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
const Failure = Schema.fromJsonString(
  Schema.Struct({
    trace_id: Schema.String,
    span_id: Schema.String,
    error_type: Schema.String,
    page_id: Schema.String,
  }),
);
const Envelope = Schema.fromJsonString(Schema.Struct({ envelope: Schema.String }));
const Event = Schema.fromJsonString(
  Schema.Struct({
    tags: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    contexts: Schema.optional(
      Schema.Struct({ trace: Schema.optional(Schema.Struct({ trace_id: Schema.String })) }),
    ),
    exception: Schema.optional(
      Schema.Struct({ values: Schema.Array(Schema.Struct({ value: Schema.String })) }),
    ),
  }),
);
layer(HostedLive, { excludeTestServices: true })("Browser observability", (it) => {
  it.effect(scenarios.browserObservability.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors,
          telemetry = yield* Telemetry;
        const evidence = yield* Evidence,
          target = yield* Target,
          fs = yield* FileSystem.FileSystem;
        expect(target.metadata.mode).toBe("managed");
        const events = fs.readFileString(`${target.directory}/sentry.ndjson`).pipe(
          Effect.map((text) =>
            text
              .trim()
              .split("\n")
              .filter(Boolean)
              .flatMap((line) =>
                Schema.decodeUnknownSync(Envelope)(line)
                  .envelope.split("\n")
                  .slice(2)
                  .filter(Boolean)
                  .map((value) => Schema.decodeUnknownSync(Event)(value)),
              ),
          ),
        );
        const sentry = (predicate: (event: typeof Event.Type) => boolean) =>
          events.pipe(
            Effect.map((events) => events.filter(predicate)),
            Effect.repeat({
              schedule: Schedule.spaced("200 millis"),
              until: (events) => events.length > 0,
            }),
            Effect.timeout("15 seconds"),
          );
        yield* browser.login(actors.owner);
        yield* browser.use("Observe only safe operation failure metadata", (page) =>
          page.addInitScript(() => {
            window.addEventListener("executor:operation-failed", (event) => {
              if (event instanceof CustomEvent)
                document.documentElement.setAttribute(
                  "data-observed-failure",
                  JSON.stringify(event.detail),
                );
            });
          }),
        );
        for (const [name, body, status, kind] of [
          ["schema", '{"privateFixture":"do-not-export"}', 200, "BrowserDecodeFailed"],
          ["json", "{", 200, "BrowserDecodeFailed"],
          ["server", '{"_tag":"AuthenticationUnavailable"}', 503, "BrowserOperationFailed"],
        ] as const) {
          const requestTrace = yield* injectDashboardResponse(
            actors.organization.slug,
            body,
            status,
          );
          const failure = yield* Schema.decodeUnknownEffect(Failure)(
            yield* browser.use("Read the safe failure identity", (page) =>
              page.locator("html").getAttribute("data-observed-failure"),
            ),
          );
          expect(failure.error_type).toBe(kind);
          expect(failure.trace_id).toBe(requestTrace);
          const trace = yield* telemetry.query(failure.trace_id).pipe(
            Effect.flatMap((trace) =>
              trace.data.some(
                ({ span }) => span.operationName === "ui.api" && span.status === "error",
              )
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
          const reported = yield* sentry(
            (event) => event.contexts?.trace?.trace_id === failure.trace_id,
          );
          expect(reported).toHaveLength(1);
          expect(JSON.stringify(reported)).not.toContain("do-not-export");
          yield* evidence.json(`${name}-failure.json`, { failure, trace, reported });
        }
        yield* browser.use("Leave the decoded failure document", (page) =>
          page.goto("about:blank"),
        );
        yield* browser.use("Fail the dashboard entry module", (page) =>
          page.route("**/src/main.tsx", (route) => route.abort("failed")),
        );
        yield* browser.use("Open the dashboard with a missing entry module", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        const moduleFailure = yield* sentry(
          (event) =>
            event.exception?.values.some((value) =>
              value.value.includes("Failed to fetch dynamically imported module"),
            ) === true,
        );
        yield* evidence.json("entry-module-failure.json", moduleFailure);
        yield* browser.use("Restore the dashboard entry module", (page) =>
          page.unroute("**/src/main.tsx"),
        );
        yield* corruptDashboardEntry(actors.organization.slug);
        const boot = yield* sentry(
          (event) =>
            event.exception?.values.some((value) => value.value === "Invalid entry document") ===
            true,
        );
        yield* evidence.json("boot-failure.json", boot);
        yield* browser.use("Open documentation", (page) => page.goto("/docs/"));
        yield* browser.use("Confirm documentation is rendered", (page) =>
          page.getByRole("heading", { level: 1 }).waitFor(),
        );
        yield* browser.use("Raise a synthetic documentation failure", (page) =>
          page.evaluate(() => {
            window.dispatchEvent(
              new ErrorEvent("error", {
                error: new Error("SyntheticDocsFailure"),
                message: "SyntheticDocsFailure",
              }),
            );
          }),
        );
        const docs = yield* sentry(
          (event) =>
            event.tags?.surface === "docs" &&
            event.exception?.values.some((value) => value.value === "SyntheticDocsFailure") ===
              true,
        );
        yield* evidence.json("docs-failure.json", docs);
      }),
    ),
  );
});
