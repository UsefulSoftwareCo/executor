import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const librarySpecUrl = "https://integrations.sh/specs/google/google-photos-library.json";
const pickerSpecUrl = "https://integrations.sh/specs/google/google-photos-picker.json";

// Photos Library and Photos Picker are independent registry products. The
// picker must preserve that distinction all the way into the selected add flow.
scenario(
  "Google Photos products are separate registry cards with separate add flows",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Stub the two Google Photos registry products", async () => {
        await page.route("https://integrations.sh/api/search*", (route) =>
          route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            json: {
              results: [
                {
                  domain: "photos.google.com",
                  name: "Google Photos Library",
                  description: "Create and manage app-created photos.",
                  kinds: ["openapi"],
                  url: "https://integrations.sh/photos.google.com/",
                },
                {
                  domain: "photos.google.com",
                  name: "Google Photos Picker",
                  description: "Let people select photos for an app.",
                  kinds: ["openapi"],
                  url: "https://integrations.sh/photos.google.com/",
                },
              ],
            },
          }),
        );
        await page.route("https://integrations.sh/api/photos.google.com/surface", (route) =>
          route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            json: {
              version: 3,
              domain: "photos.google.com",
              surfaces: [
                { type: "http", slug: "google-photos-library", spec: librarySpecUrl },
                { type: "http", slug: "google-photos-picker", spec: pickerSpecUrl },
              ],
            },
          }),
        );
      });

      await step("Search for Photos and see two separate product cards", async () => {
        await visit(page, "/integrations/browse");
        await page.getByPlaceholder(/Search integrations, or paste a URL/).fill("photos");
        const cards = page.getByTestId("catalog-photos.google.com-openapi");
        await cards.filter({ hasText: "Google Photos Library API" }).waitFor();
        await cards.filter({ hasText: "Google Photos Picker API" }).waitFor();
      });

      await step("Add Photos Library in place; the Picker card is untouched", async () => {
        await page
          .getByTestId("catalog-photos.google.com-openapi")
          .filter({ hasText: "Google Photos Library API" })
          .getByRole("button", { name: "Add Google Photos Library API" })
          .click();
        const libraryCard = page
          .getByTestId("catalog-photos.google.com-openapi")
          .filter({ hasText: "Google Photos Library API" });
        await libraryCard
          .getByRole("link", { name: "View Google Photos Library API" })
          .waitFor({ timeout: 120_000 });
        expect(new URL(page.url()).pathname).toMatch(/\/integrations\/browse$/);
        // Product identity survived: the LIBRARY slug became the namespace…
        const href = await libraryCard
          .getByRole("link", { name: "View Google Photos Library API" })
          .getAttribute("href");
        expect(href).toContain("/integrations/google_photos_library");
        // …and the Picker card, same domain and kind, still offers Add.
        await page
          .getByTestId("catalog-photos.google.com-openapi")
          .filter({ hasText: "Google Photos Picker API" })
          .getByRole("button", { name: "Add Google Photos Picker API" })
          .waitFor();
      });

      await step("Adding the SECOND same-kind card keeps its own identity", async () => {
        // The regression this guards: selection re-derived the surface by
        // KIND, so the second product of a kind inherited the first's slug,
        // auth, and overrides.
        await page
          .getByTestId("catalog-photos.google.com-openapi")
          .filter({ hasText: "Google Photos Picker API" })
          .getByRole("button", { name: "Add Google Photos Picker API" })
          .click();
        const pickerCard = page
          .getByTestId("catalog-photos.google.com-openapi")
          .filter({ hasText: "Google Photos Picker API" });
        await pickerCard
          .getByRole("link", { name: "View Google Photos Picker API" })
          .waitFor({ timeout: 120_000 });
        const href = await pickerCard
          .getByRole("link", { name: "View Google Photos Picker API" })
          .getAttribute("href");
        expect(href).toContain("/integrations/google_photos_picker");
      });
    });
  }),
);
