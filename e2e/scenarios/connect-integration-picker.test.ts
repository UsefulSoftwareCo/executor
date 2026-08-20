import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { clickToReveal, visit } from "../src/surfaces/browser";

// The picker holds ~85 presets, and two providers contribute roughly half of
// them as bare service names. Browsing has to collapse those; searching has to
// uncollapse them again, or the search hands back the card it was looking past.
scenario(
  "Connect picker · providers collapse while browsing and open up on search",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      const dialog = page.getByRole("dialog", { name: "Connect an integration" });
      const search = () => dialog.getByPlaceholder(/Search or paste a URL/);
      const googleCard = () => dialog.getByRole("button", { name: /^Google\b.*services$/s });
      const allFacet = () => dialog.getByRole("button", { name: /^All\s+\d+$/ });

      await step("Open the connect picker", async () => {
        await visit(page, "/integrations");
        await clickToReveal(page.getByRole("button", { name: "Connect" }), dialog);
      });

      await step("A multi-service provider browses as one card, not its services", async () => {
        await googleCard().waitFor();
        expect(await googleCard().innerText()).toMatch(/\d+ services/);
        // The services behind the card stay behind it.
        expect(await dialog.getByRole("link", { name: /^Gmail\b/ }).count()).toBe(0);
      });

      await step("Opening the provider card reveals its services", async () => {
        await googleCard().click();
        await dialog.getByRole("link", { name: /^Gmail\b/ }).waitFor();
        await dialog.getByRole("link", { name: /^Google Drive\b/ }).waitFor();
        // Inside a provider the protocol facets would advertise catalog-wide
        // counts over a list that isn't the catalog, so they stand down.
        expect(await allFacet().count()).toBe(0);
      });

      await step("Going back returns to the browsable catalog", async () => {
        await dialog.getByRole("button", { name: /All integrations/ }).click();
        await googleCard().waitFor();
        await allFacet().waitFor();
        expect(await dialog.getByRole("link", { name: /^Gmail\b/ }).count()).toBe(0);
      });

      await step("Searching returns the services themselves, not the provider card", async () => {
        await search().fill("outlook");
        await dialog.getByRole("link", { name: /^Outlook Mail\b/ }).waitFor();
        await dialog.getByRole("link", { name: /^Outlook Calendar\b/ }).waitFor();
        expect(await dialog.getByRole("button", { name: /^Microsoft\b.*services$/s }).count()).toBe(
          0,
        );
      });

      await step("A protocol filter narrows the catalog to that protocol", async () => {
        await search().fill("");
        await dialog.getByRole("button", { name: /^MCP\s+\d+$/ }).click();
        await dialog.getByRole("link", { name: /^Context7\b/ }).waitFor();
        // Figma is OpenAPI-only, so the MCP facet must not offer it.
        expect(await dialog.getByRole("link", { name: /^Figma\b/ }).count()).toBe(0);
      });

      await step("On a phone the filters and the add path stay on one row", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        const facetTops = await dialog
          .getByRole("button", { name: /^(All|OpenAPI|MCP|GraphQL)\s+\d+$/ })
          .evaluateAll((chips) => chips.map((chip) => chip.getBoundingClientRect().top));
        expect(facetTops.length).toBeGreaterThan(1);
        expect(new Set(facetTops).size, "the facets scroll sideways, they do not wrap").toBe(1);

        // Three protocol buttons would wrap into a second row down here, so
        // they collapse into one menu that opens the same links.
        await dialog.getByRole("button", { name: "Add manually" }).waitFor();
        expect(await dialog.getByRole("link", { name: "Add OpenAPI" }).isVisible()).toBe(false);
        await dialog.getByRole("button", { name: "Add manually" }).click();
        await page.getByRole("menuitem", { name: "Add GraphQL" }).waitFor();
        await page.keyboard.press("Escape");
      });

      await step("Picking a service opens its add flow with the preset applied", async () => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await allFacet().click();
        await search().fill("gmail");
        await dialog.getByRole("link", { name: /^Gmail\b/ }).click();
        await page.waitForURL(/\/integrations\/add\/openapi/);
        await page.getByRole("heading", { name: "Add OpenAPI integration" }).waitFor();
        expect(new URL(page.url()).searchParams.get("preset")).toBe("google-gmail");
      });
    });
  }),
);
