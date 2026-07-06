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
//
// SHARED-STATE ROBUSTNESS: on selfhost every scenario acts as the same
// bootstrap admin, so google-per-service-add-ui may already have created these
// integrations before this file runs (or vice versa, in either order). The add
// flow's submit button is DISABLED when the custom slug (`google_custom`)
// already exists (`customSlugAlreadyExists` gates `canAdd` in
// AddGoogleSource), so this spec first checks the grid, adds only what is
// missing, and removes ONLY what it created in an `ensuring` finalizer so the
// google-per-service spec finds a clean slate if it runs after this file.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { clearCheckedPresets, setPresetChecked } from "./support/picker";

const coreApi = composePluginApi([] as const);

scenario(
  "Integrations · per-service integrations group under one provider umbrella with distinct icons",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client } = yield* Api;
    const identity = yield* target.newIdentity();
    const api = yield* client(coreApi, identity);
    const customDiscoveryUrl = "https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest";
    // Slugs this test creates (as opposed to found already existing); the
    // finalizer removes exactly these so no state leaks into the shared
    // selfhost instance, and pre-existing integrations are left alone.
    const createdSlugs: string[] = [];

    const session = browser.session(identity, async ({ page, step }) => {
      await step(
        "Ensure the four Google integrations exist (Calendar, Gmail, Drive, custom)",
        async () => {
          // This step is about ensuring grid preconditions, not about the add
          // path (google-per-service-add-ui owns that): it adds only the missing
          // integrations and tolerates "skipped" rows. The real grouping/icon
          // assertions live in the steps below.
          //
          // preset id -> integration slug (dashes become underscores; custom -> google_custom)
          const presetToSlug: Record<string, string> = {
            "google-calendar": "google_calendar",
            "google-gmail": "google_gmail",
            "google-drive": "google_drive",
          };
          const customSlug = "google_custom";

          await page.goto("/integrations", { waitUntil: "networkidle" });
          const existingMain = page.getByRole("main");
          const slugExists = async (slug: string): Promise<boolean> =>
            (await existingMain.getByTestId(`integration-entry-${slug}`).count()) > 0;

          const missingPresetIds: string[] = [];
          for (const [presetId, slug] of Object.entries(presetToSlug)) {
            if (!(await slugExists(slug))) missingPresetIds.push(presetId);
          }
          const customMissing = !(await slugExists(customSlug));

          // Everything the grid asserts on already exists: the add flow's submit
          // would be disabled (custom slug collision), so skip it entirely and
          // go straight to the grid.
          if (missingPresetIds.length === 0 && !customMissing) return;

          // Record intent BEFORE submitting so a mid-add failure still gets its
          // partial state cleaned up by the finalizer.
          for (const presetId of missingPresetIds) createdSlugs.push(presetToSlug[presetId]!);
          if (customMissing) createdSlugs.push(customSlug);

          await page.goto("/integrations/add/google", {
            waitUntil: "domcontentloaded",
          });
          await page.getByText("Customize your Google connection").waitFor();
          await page.getByTestId("preset-checkbox-google-calendar").waitFor();

          // Clear the featured defaults, then select exactly the missing presets:
          // submitting an already-existing preset is harmless ("skipped") but
          // leaving defaults checked would create integrations this test never
          // asserts on.
          await clearCheckedPresets(page);
          for (const presetId of missingPresetIds) {
            await setPresetChecked(page, presetId, true);
          }

          // Only add the custom Discovery URL when google_custom is missing: if
          // it already exists, filling it flips customSlugAlreadyExists true and
          // disables the submit button.
          if (customMissing) {
            const customField = page.getByPlaceholder(
              "https://www.googleapis.com/discovery/v1/apis/<service>/<version>/rest",
            );
            await customField.fill(customDiscoveryUrl);
            await customField.press("Enter");
            await page.getByText(customDiscoveryUrl).waitFor();
          }

          await page.getByTestId("google-add-submit").click();
          const results = page.getByTestId("google-add-results");
          await results.waitFor({ timeout: 120_000 });

          // Each submitted preset resolves to a row that is either freshly
          // "added" or "skipped" (raced with another writer) - both leave the
          // integration present, which is all the grid needs.
          for (const presetId of missingPresetIds) {
            const row = page.getByTestId(`add-result-row-${presetId}`);
            await row.waitFor({ timeout: 120_000 });
            expect(
              ["added", "skipped"],
              `${presetId} present (added or already existed)`,
            ).toContain(await row.getAttribute("data-state"));
          }
          if (customMissing) {
            const customRow = page.getByTestId("add-result-row-custom");
            await customRow.waitFor({ timeout: 120_000 });
            expect(
              ["added", "skipped"],
              "custom Google service present (added or already existed)",
            ).toContain(await customRow.getAttribute("data-state"));
          }
        },
      );

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

    yield* session.pipe(
      Effect.ensuring(
        // Remove ONLY the integrations this test created (never pre-existing
        // ones): on selfhost the next scenario acts as the same admin, and a
        // leaked google_custom disables the Google add flow's submit button.
        Effect.forEach(
          createdSlugs,
          (slug) =>
            api.integrations
              .remove({ params: { slug: IntegrationSlug.make(slug) } })
              .pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    );
  }),
);
