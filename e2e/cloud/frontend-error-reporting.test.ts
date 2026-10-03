// Inspect the browser's actual Sentry envelope for a failed API request.
// Reporting must preserve classification and source positions while omitting
// the response body, request credentials and raw error message.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { revisit, visit } from "../src/surfaces/browser";

type ReportedException = {
  readonly type?: string;
  readonly value?: string;
  // The reporter marks an exception `synthetic` when it was handed something
  // that was not a real error and had to invent a stack for it — the stack of
  // whatever frame did the reporting.
  readonly mechanism?: { readonly synthetic?: boolean };
  readonly stacktrace?: {
    readonly frames?: ReadonlyArray<{ readonly filename?: string; readonly lineno?: number }>;
  };
};

type ReportedEvent = {
  readonly tags?: Record<string, string>;
  readonly exception?: { readonly values?: ReadonlyArray<ReportedException> };
};

/**
 * An envelope is newline-delimited JSON — a header, then `{type}` / payload
 * pairs. Only the error payloads matter here and they are the ones carrying
 * `exception`, so pick those out rather than modelling the whole format.
 */
const errorEventsIn = (body: string): ReadonlyArray<ReportedEvent> =>
  body
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as ReportedEvent;
        return parsed.exception ? [parsed] : [];
      } catch {
        return [];
      }
    });

scenario(
  "Frontend errors · a failed API request is reported without request data",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const browser = yield* Browser;
    const target = yield* Target;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      const reports: Array<ReportedEvent> = [];
      await page.route("**/api/sentry-tunnel*", async (route) => {
        reports.push(...errorEventsIn(route.request().postData() ?? ""));
        await route.fulfill({ status: 200, body: "" });
      });

      // Everything the UI reports about a request it made itself.
      const reportedFailures = (): ReadonlyArray<ReportedException> =>
        reports
          .filter((event) => event.tags?.["executor.ui.surface"] === "api_client")
          .flatMap((event) => event.exception?.values ?? []);

      await step("Open the integrations console", async () => {
        await visit(page, "/integrations");
        // The connect dialog became the full-page picker; the header's Add
        // link is the page's stable loaded-signal now.
        await page.getByRole("link", { name: "Add integration" }).first().waitFor();
      });

      let faulted = 0;
      await step("Reload it with the integrations API failing", async () => {
        await page.route("**/api/integrations", async (route) => {
          if (route.request().method() !== "GET") {
            await route.continue();
            return;
          }
          faulted += 1;
          await route.fulfill({
            status: 500,
            contentType: "text/plain",
            body: "SYNTHETIC_PRIVATE_RESPONSE_MARKER",
          });
        });
        await revisit(page);
      });

      expect(faulted, "the integrations request really did fail").toBeGreaterThan(0);

      // The report must name the failure. Reports are sent as the page
      // notices failures, so wait for one rather than sleeping.
      await expect
        .poll(() => reportedFailures().map((failure) => failure.value ?? ""), {
          message: "the failed API request produces a classified report",
          timeout: 20_000,
        })
        .toContain("API request failed (decode_or_transport)");

      const serialized = JSON.stringify(reports);
      expect(serialized).not.toContain("SYNTHETIC_PRIVATE_RESPONSE_MARKER");
      expect(serialized).not.toContain("500 GET");
      for (const credential of Object.values(identity.headers ?? {})) {
        expect(serialized, "request credentials stay out of the report").not.toContain(credential);
      }
      const apiReports = reports.filter(
        (event) => event.tags?.["executor.ui.surface"] === "api_client",
      );
      expect(apiReports.length).toBeGreaterThan(0);
      for (const report of apiReports) {
        expect(report.tags).toMatchObject({
          "executor.ui.surface": "api_client",
          "executor.ui.action": "decode_or_transport",
          "executor.ui.severity": "error",
        });
      }
      expect(
        reportedFailures().some((failure) =>
          failure.stacktrace?.frames?.some(
            (frame) => frame.filename !== undefined && frame.lineno !== undefined,
          ),
        ),
        "reported failures retain actionable source positions",
      ).toBe(true);
      for (const failure of reportedFailures()) {
        expect(failure.value).toBe("API request failed (decode_or_transport)");
        expect(failure.type).toBeTruthy();
        expect(failure.mechanism?.synthetic, "the failure carries its own stack").not.toBe(true);
      }

      await page.unroute("**/api/integrations");
      await page.unroute("**/api/sentry-tunnel*");
    });
  }),
);
