import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

scenario(
  "Accessibility · reduced motion removes dialog animation and control transitions",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the API key dialog with normal motion", async () => {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await visit(page, "/api-keys");
        await page.getByRole("button", { name: "New key" }).click();
        await page.getByRole("dialog").waitFor();
        const duration = await page
          .getByRole("dialog")
          .evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration));
        expect(duration, "normal motion retains the dialog transition").toBeGreaterThan(0.00001);
      });

      await step("Enable reduced motion while the dialog is open", async () => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const styles = await page.getByRole("dialog").evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            animation: Number.parseFloat(style.animationDuration),
            iterations: style.animationIterationCount,
            transition: Number.parseFloat(style.transitionDuration),
            scroll: style.scrollBehavior,
          };
        });
        expect(styles).toEqual({
          animation: 0.00001,
          iterations: "1",
          transition: 0.00001,
          scroll: "auto",
        });
        await page.locator("#create-key-name").fill("Reduced motion check");
        expect(await page.locator("#create-key-name").inputValue()).toBe("Reduced motion check");
      });

      await step("Restore normal motion without losing the form", async () => {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        expect(await page.locator("#create-key-name").inputValue()).toBe("Reduced motion check");
        const duration = await page
          .getByRole("dialog")
          .evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration));
        expect(duration).toBeGreaterThan(0.00001);
      });
    });
  }),
);
