// Cloud (browser): a failed API request is reported as a titled error.
//
// The console reports handled UI failures to the crash reporter, and every
// producer of one starts from an Effect `Cause` — a plain object with no name,
// message or stack. Handed that directly, the reporter has nothing to title
// the report with, so it files a message-less one and groups it on the
// reporting frame: unrelated frontend failures all land in a single nameless
// bucket that says only which function did the reporting, never what broke.
//
// The report is the product surface here, so this scenario reads it the way
// the outside world does. The browser SDK is configured to POST its envelopes
// same-origin (`tunnel`), so the suite intercepts that request and asserts on
// the payload the page actually tried to send.
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
  "Frontend errors · a failed API request is reported with a real message",
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
            body: "upstream exploded",
          });
        });
        await revisit(page);
      });

      expect(faulted, "the integrations request really did fail").toBeGreaterThan(0);

      // The report must name the failure. Reports are sent as the page
      // notices failures, so wait for one rather than sleeping.
      await expect
        .poll(() => reportedFailures().map((failure) => failure.value ?? ""), {
          message: "the reported failure says which request failed, and how",
          timeout: 20_000,
        })
        .toContainEqual(expect.stringMatching(/500 .*\/api\/integrations/));

      for (const failure of reportedFailures()) {
        // A report with no message is the bug: it cannot be titled, so it
        // groups on the reporting frame and swallows every other failure.
        expect(failure.value ?? "", "every report carries a message").not.toBe("");
        expect(failure.type ?? "", "every report carries an error name").not.toBe("");
        // What a reporter falls back to when it is handed something that is
        // not an error at all — the shape every message-less report had.
        expect(failure.value ?? "", "no report is a bag of keys").not.toMatch(
          /captured as exception with keys/,
        );
        // The other half of the bug, and the half a readable message can hide:
        // handed a non-error, the reporter still has no stack of its own to
        // group on and invents one from the reporting frame, so unrelated
        // failures keep merging into a single bucket. Only a real error clears
        // this flag.
        expect(
          failure.mechanism?.synthetic ?? false,
          "the report carries the failure's own stack, not the reporter's frame",
        ).toBe(false);
      }

      await page.unroute("**/api/integrations");
      await page.unroute("**/api/sentry-tunnel*");
    });
  }),
);
