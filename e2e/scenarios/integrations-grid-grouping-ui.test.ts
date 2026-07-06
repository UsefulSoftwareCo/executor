// Integrations grid grouping: a provider whose plugin fans out into several
// per-service integrations (Google -> Calendar, Gmail, Drive, plus a custom
// Discovery URL) collapses those siblings under ONE provider umbrella on the
// integrations list, while every non-family integration (the built-in
// "executor" source) stays flat. Each per-service row keeps its OWN product
// glyph, so the icons in the group are visibly distinct rather than one
// repeated Google logo.
//
// This drives the browser path end to end:
//   1. Fan out four Google integrations through the Google add flow (the same
//      real Discovery add path the google-per-service spec exercises).
//   2. On /integrations, assert a single "Google" umbrella (data-testid
//      `integration-group-google`) contains all four per-service entries.
//   3. Assert the non-family "executor" integration renders OUTSIDE any group
//      umbrella.
//   4. Assert Calendar, Gmail, and Drive resolve to three DISTINCT icon srcs
//      (per-service favicons), not one shared provider logo.
//
// OUTBOUND DISCOVERY: like google-per-service-add-ui, the add step fetches real
// Google Discovery documents (www.googleapis.com, read-only, no credentials).
// The grouping assertions themselves are pure DOM and touch no external state.
//
// Text lookups are scoped to getByRole("main"): selfhost shares a
// bootstrap-admin identity and the shell sidebar also lists these integrations,
// so a page-wide getByText would match the sidebar copy.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { clearCheckedPresets, setPresetChecked } from "./support/picker";

scenario(
  "Integrations · per-service integrations group under one provider umbrella with distinct icons",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const customDiscoveryUrl = "https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest";

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Fan out four Google integrations (Calendar, Gmail, Drive, custom)", async () => {
        await page.goto("/integrations/add/google", { waitUntil: "domcontentloaded" });
        await page.getByText("Customize your Google connection").waitFor();
        await page.getByTestId("preset-checkbox-google-calendar").waitFor();

        await clearCheckedPresets(page);
        for (const presetId of ["google-calendar", "google-gmail", "google-drive"]) {
          await setPresetChecked(page, presetId, true);
        }
        const customField = page.getByPlaceholder(
          "https://www.googleapis.com/discovery/v1/apis/<service>/<version>/rest",
        );
        await customField.fill(customDiscoveryUrl);
        await customField.press("Enter");
        await page.getByText(customDiscoveryUrl).waitFor();

        await page.getByTestId("google-add-submit").click();
        const results = page.getByTestId("google-add-results");
        await results.waitFor({ timeout: 120_000 });
        for (const presetId of ["google-calendar", "google-gmail", "google-drive"]) {
          const row = page.getByTestId(`add-result-row-${presetId}`);
          await row.waitFor({ timeout: 120_000 });
          expect(await row.getAttribute("data-state"), `${presetId} added`).toBe("added");
        }
        const customRow = page.getByTestId("add-result-row-custom");
        await customRow.waitFor({ timeout: 120_000 });
        expect(await customRow.getAttribute("data-state"), "custom Google service added").toBe(
          "added",
        );
      });

      await step("The four Google integrations sit under one Google umbrella", async () => {
        await page.goto("/integrations", { waitUntil: "networkidle" });
        const main = page.getByRole("main");

        // Exactly one provider umbrella, and it is the Google one.
        const group = main.getByTestId("integration-group-google");
        await group.waitFor({ timeout: 20_000 });
        expect(await main.getByTestId("integration-group-google").count()).toBe(1);

        // The umbrella header carries the provider name.
        await group
          .getByRole("button", { name: /Google/ })
          .first()
          .waitFor({ state: "visible", timeout: 20_000 });

        // Every per-service integration (including the custom one) is an entry
        // INSIDE the Google umbrella, not a flat sibling.
        for (const slug of ["google_calendar", "google_gmail", "google_drive", "google_custom"]) {
          const entry = group.getByTestId(`integration-entry-${slug}`);
          await entry.waitFor({ timeout: 20_000 });
          expect(await group.getByTestId(`integration-entry-${slug}`).count(), slug).toBe(1);
        }
      });

      await step("A non-family integration (executor) stays outside every group", async () => {
        const main = page.getByRole("main");
        const executor = main.getByTestId("integration-entry-executor");
        await executor.waitFor({ timeout: 20_000 });

        // The built-in executor source exists in the catalog...
        expect(await main.getByTestId("integration-entry-executor").count()).toBe(1);
        // ...but not nested within the Google provider umbrella.
        const group = main.getByTestId("integration-group-google");
        expect(
          await group.getByTestId("integration-entry-executor").count(),
          "executor is not grouped under Google",
        ).toBe(0);
      });

      await step("Per-service integrations render distinct product icons", async () => {
        const group = page.getByRole("main").getByTestId("integration-group-google");
        const iconSrc = async (slug: string): Promise<string | null> =>
          group.getByTestId(`integration-entry-${slug}`).locator("img").first().getAttribute("src");

        const calendar = await iconSrc("google_calendar");
        const gmail = await iconSrc("google_gmail");
        const drive = await iconSrc("google_drive");

        // Each service resolves to its own glyph URL (assert on src, not pixels).
        expect(calendar, "calendar has an icon").toBeTruthy();
        expect(gmail, "gmail has an icon").toBeTruthy();
        expect(drive, "drive has an icon").toBeTruthy();
        expect(
          new Set([calendar, gmail, drive]).size,
          "the three per-service icons are all distinct, not one repeated provider logo",
        ).toBe(3);
      });
    });
  }),
);
