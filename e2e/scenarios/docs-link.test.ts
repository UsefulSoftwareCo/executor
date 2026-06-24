import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

// A user inside the console should be able to reach the documentation without
// leaving the app for the marketing site (the original friction: docs were
// only discoverable from the home page). The shell renders a persistent Docs
// link in the sidebar footer that opens the published docs in a new tab.
scenario(
  "Shell · the sidebar links to the docs from inside the app",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the console", async () => {
        await page.goto("/", { waitUntil: "networkidle" });
        await page.getByText("Integrations").first().waitFor();
      });

      await step("The sidebar exposes a Docs link", async () => {
        const docs = page.getByRole("link", { name: "Docs", exact: true });
        await docs.waitFor();
        expect(
          await docs.getAttribute("href"),
          "Docs link points at the published documentation",
        ).toBe("https://executor.sh/docs");
        expect(await docs.getAttribute("target"), "Docs open in a new tab").toBe("_blank");
      });
    });
  }),
);
