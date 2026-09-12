// An empty Toolkits grid must fit the viewport: with no toolkits in either
// scope, both the Workspace and Personal add cards sit above the fold and the
// grid does not scroll. Regression: each shelf reserved a fixed ~3-row
// min-height, so two empty shelves stacked past the viewport and the page
// scrolled with nothing to see.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

scenario(
  "Toolkits · empty grid fits the viewport without scrolling",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the Toolkits page with no toolkits in either scope", async () => {
        await visit(page, "/default/toolkits/");
        await page.getByRole("heading", { name: "Toolkits", level: 1 }).waitFor();
        await page.getByRole("heading", { name: "Workspace" }).waitFor();
        await page.getByRole("heading", { name: "Personal" }).waitFor();
        await page.getByRole("button", { name: "Add workspace toolkit" }).waitFor();
        await page.getByRole("button", { name: "Add personal toolkit" }).waitFor();
        await page.locator('main [data-slot="skeleton"]').first().waitFor({ state: "detached" });
      });

      await step("The empty grid does not overflow its scroll container", async () => {
        // Walk up from the Personal add card to its nearest scrollable
        // ancestor; on an empty grid that ancestor must have nothing to
        // scroll. This is the user-visible contract — both add cards are
        // reachable without scrolling — measured at the scroll boundary.
        const overflow = await page.evaluate(() => {
          const addCard = [...document.querySelectorAll("button")].find(
            (button) => button.getAttribute("aria-label") === "Add personal toolkit",
          );
          let node: HTMLElement | null = addCard ?? null;
          while (node && node.scrollHeight <= node.clientHeight + 1) {
            node = node.parentElement;
          }
          if (!node) return null;
          return {
            tag: node.tagName,
            scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight,
          };
        });
        expect(overflow, "no scrollable ancestor overflows for an empty grid").toBeNull();
      });
    });
  }),
);
