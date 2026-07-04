// Google per-service picker fan-out: the add-Google flow lets a user check
// several Google products and submit them in one action; each checked preset
// becomes its OWN integration (google_calendar, google_gmail, google_drive),
// not one bundled "google" source. This drives the whole browser path:
//
//   1. Open /integrations/add/google (the Google-owned add flow).
//   2. Clear the featured defaults, then check exactly Calendar + Gmail + Drive.
//   3. Submit via `google-add-submit`. The flow fetches each preset's real
//      Google Discovery document (www.googleapis.com) and registers one
//      integration per product.
//   4. The result panel shows three `add-result-row-*` rows, each data-state
//      "added", each with an Open link.
//   5. Follow one Open link: the integration detail page shows the per-service
//      name ("Google Calendar"), proving the fan-out kept preset identities.
//   6. Back on the integrations list, all three separate integrations exist
//      (asserted by their distinct slugs in the list UI).
//   7. Re-open the add flow, check Calendar again, submit: its row now reports
//      data-state "skipped" (the integration already exists), proving the
//      idempotent add path.
//
// OUTBOUND DISCOVERY: unlike the emulator-backed scenarios, this exercises the
// real add path. The Google preset add flow HARDCODES the Discovery host
// (`normalizeGoogleDiscoveryUrl` only accepts googleapis.com HTTPS Discovery
// endpoints) and the OAuth authorize/token URLs (accounts.google.com /
// oauth2.googleapis.com). There is no baseUrl or custom-URL override that
// redirects a preset's Discovery fetch at the emulator, so this scenario adds
// the integrations against real Google Discovery documents (read-only, no
// credentials, no OAuth). The cloud e2e runners (and CI's blacksmith runners)
// have outbound internet, so the fetch resolves; the scenario asserts only on
// the product's own catalog state, never on Google account data.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { setPresetChecked } from "./support/picker";

scenario(
  "Google · the per-service picker fans out to separate integrations and skips existing ones",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the Google add flow", async () => {
        await page.goto("/integrations/add/google", { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "Add Google integration" }).waitFor();
        await page.getByText("Customize your Google connection").waitFor();
        // The picker mounts with the featured defaults checked.
        await page.getByTestId("preset-checkbox-google-calendar").waitFor();
      });

      await step("Clear the defaults, then check exactly Calendar + Gmail + Drive", async () => {
        // Clear every featured default, then select only the three under test.
        const featuredDefaults = [
          "google-calendar",
          "google-gmail",
          "google-sheets",
          "google-drive",
          "google-docs",
        ];
        for (const presetId of featuredDefaults) {
          await setPresetChecked(page, presetId, false);
        }

        for (const presetId of ["google-calendar", "google-gmail", "google-drive"]) {
          await setPresetChecked(page, presetId, true);
        }
        // Everything else is unchecked: this is a scoped three-product selection.
        expect(await page.getByTestId("preset-checkbox-google-sheets").isChecked()).toBe(false);
        expect(await page.getByTestId("preset-checkbox-google-docs").isChecked()).toBe(false);
      });

      await step("Submit the fan-out and see three added integrations", async () => {
        await page.getByTestId("google-add-submit").click();
        // The result panel appears once every product is registered. Discovery
        // fetch + spec compile per product; allow generous time.
        const results = page.getByTestId("google-add-results");
        await results.waitFor({ timeout: 120_000 });

        for (const presetId of ["google-calendar", "google-gmail", "google-drive"]) {
          const row = page.getByTestId(`add-result-row-${presetId}`);
          await row.waitFor({ timeout: 120_000 });
          expect(
            await row.getAttribute("data-state"),
            `${presetId} added as its own integration`,
          ).toBe("added");
          // Each added row links out to its own integration page.
          await row.getByRole("link", { name: "Open" }).waitFor();
        }
      });

      await step("Open one product: its integration page shows the per-service name", async () => {
        await page
          .getByTestId("add-result-row-google-calendar")
          .getByRole("link", { name: "Open" })
          .click();
        await page.waitForURL(/\/integrations\/google_calendar\b/);
        // The detail header renders the per-service name, not a generic
        // "Google". Scoped to the main region: the shell sidebar also lists
        // the new integration as "Google Calendar".
        await page
          .getByRole("main")
          .getByText("Google Calendar")
          .first()
          .waitFor({ timeout: 20_000 });
      });

      await step("The integrations list has three separate Google integrations", async () => {
        await page.goto("/integrations", { waitUntil: "networkidle" });
        // Each fanned-out integration is its own list entry, keyed by its slug
        // (the list renders the slug as each entry's description).
        for (const slug of ["google_calendar", "google_gmail", "google_drive"]) {
          await page
            .getByRole("main")
            .getByText(slug, { exact: true })
            .first()
            .waitFor({ timeout: 20_000 });
        }
      });

      await step("Re-adding an existing product reports it as skipped", async () => {
        await page.goto("/integrations/add/google", { waitUntil: "domcontentloaded" });
        await page.getByText("Customize your Google connection").waitFor();

        // Clear the featured defaults so only Calendar (already added) is checked.
        for (const presetId of ["google-gmail", "google-sheets", "google-drive", "google-docs"]) {
          await setPresetChecked(page, presetId, false);
        }
        await setPresetChecked(page, "google-calendar", true);

        await page.getByTestId("google-add-submit").click();
        const row = page.getByTestId("add-result-row-google-calendar");
        await row.waitFor({ timeout: 120_000 });
        expect(
          await row.getAttribute("data-state"),
          "an already-added product is skipped, not re-added or failed",
        ).toBe("skipped");
      });
    });
  }),
);
