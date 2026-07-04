// Microsoft per-workload picker fan-out: the mirror of the Google per-service
// spec. The add-Microsoft flow lets a user check several Graph workloads and
// submit them in one action; each checked workload becomes its OWN integration
// (microsoft_mail, microsoft_calendar), each a scope-filtered slice of the
// Graph, not one bundled "microsoft_graph" source. This drives the whole
// browser path: clear the featured defaults, check exactly Mail + Calendar,
// submit, assert two `add-result-row-*` rows added, follow one Open link to a
// per-workload integration page, confirm both slugs in the list, then re-add
// Mail and see it reported skipped.
//
// OUTBOUND SPEC (same shape as the Google spec, scoped-out reasons below):
// `microsoft.addWorkloads` fetches the real Microsoft Graph OpenAPI document
// (the 37MB msgraph-metadata YAML on raw.githubusercontent.com) and streams it
// through the block-YAML profile compiler per workload; `specUrl` must point at
// the trusted Microsoft Graph source (graph.microsoft.com / msgraph-metadata),
// and the emulator's small custom Graph spec is NOT in that streaming profile
// (see microsoft-emulator.test.ts's skip). So, like the Google add spec, this
// exercises the REAL add path against the canonical Graph spec (read-only, no
// credentials, no OAuth); it asserts only on the product's own catalog state.
//
// Because the 37MB spec is fetched and stream-compiled once per workload at
// {concurrency: 1}, the add step is slow; the timeouts below are generous.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { setPresetChecked } from "./support/picker";

scenario(
  "Microsoft · the per-workload picker fans out to separate integrations and skips existing ones",
  { timeout: 420_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the Microsoft add flow", async () => {
        await page.goto("/integrations/add/microsoft", { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "Add Microsoft integration" }).waitFor();
        await page.getByText("Customize Microsoft Graph").waitFor();
        await page.getByTestId("preset-checkbox-mail").waitFor();
      });

      await step("Clear the defaults, then check exactly Mail + Calendar", async () => {
        // The featured defaults (profile, mail, calendar, contacts, tasks, files)
        // start checked; clear them, then select only the two under test.
        for (const presetId of ["profile", "mail", "calendar", "contacts", "tasks", "files"]) {
          await setPresetChecked(page, presetId, false);
        }
        for (const presetId of ["mail", "calendar"]) {
          await setPresetChecked(page, presetId, true);
        }
        expect(await page.getByTestId("preset-checkbox-contacts").isChecked()).toBe(false);
        expect(await page.getByTestId("preset-checkbox-files").isChecked()).toBe(false);
      });

      await step("Submit the fan-out and see two added integrations", async () => {
        await page.getByTestId("microsoft-add-submit").click();
        // Each workload fetches + stream-compiles the 37MB Graph spec; allow a
        // wide window for the result panel to populate.
        await page.getByTestId("microsoft-add-results").waitFor({ timeout: 300_000 });

        for (const presetId of ["mail", "calendar"]) {
          const row = page.getByTestId(`add-result-row-${presetId}`);
          await row.waitFor({ timeout: 300_000 });
          expect(
            await row.getAttribute("data-state"),
            `${presetId} added as its own integration`,
          ).toBe("added");
          await row.getByRole("link", { name: "Open" }).waitFor();
        }
      });

      await step(
        "Open one workload: its integration page shows the per-workload name",
        async () => {
          await page.getByTestId("add-result-row-mail").getByRole("link", { name: "Open" }).click();
          await page.waitForURL(/\/integrations\/microsoft_mail\b/);
          // Scoped to the main region: the shell sidebar also lists the new
          // integration as "Outlook Mail", so a page-wide lookup would match
          // the sidebar link instead of the detail page under test.
          await page
            .getByRole("main")
            .getByText("Outlook Mail")
            .first()
            .waitFor({ timeout: 20_000 });
        },
      );

      await step("The integrations list has two separate Microsoft integrations", async () => {
        await page.goto("/integrations", { waitUntil: "networkidle" });
        for (const slug of ["microsoft_mail", "microsoft_calendar"]) {
          await page
            .getByRole("main")
            .getByText(slug, { exact: true })
            .first()
            .waitFor({ timeout: 20_000 });
        }
      });

      await step("Re-adding an existing workload reports it as skipped", async () => {
        await page.goto("/integrations/add/microsoft", { waitUntil: "domcontentloaded" });
        await page.getByText("Customize Microsoft Graph").waitFor();

        for (const presetId of ["profile", "mail", "calendar", "contacts", "tasks", "files"]) {
          await setPresetChecked(page, presetId, false);
        }
        await setPresetChecked(page, "mail", true);

        await page.getByTestId("microsoft-add-submit").click();
        const row = page.getByTestId("add-result-row-mail");
        await row.waitFor({ timeout: 300_000 });
        expect(
          await row.getAttribute("data-state"),
          "an already-added workload is skipped, not re-added or failed",
        ).toBe("skipped");
      });
    });
  }),
);
