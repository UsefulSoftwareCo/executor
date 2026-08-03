import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Google Photos: separated catalog presets open a Photos service add flow",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step(
        "Find the separated Google Photos presets from the integrations picker",
        async () => {
          await page.goto("/integrations", { waitUntil: "networkidle" });
          await page.getByRole("button", { name: "Connect" }).click();
          const dialog = page.getByRole("dialog", { name: "Connect an integration" });
          await dialog.waitFor();
          await dialog.getByPlaceholder(/Search or paste a URL/).fill("google photos");
          await dialog.getByRole("link", { name: /^Google Photos Library\b/ }).waitFor();
          await dialog.getByRole("link", { name: /^Google Photos Picker\b/ }).waitFor();
        },
      );

      await step("Open the Google Photos Library add flow", async () => {
        const dialog = page.getByRole("dialog", { name: "Connect an integration" });
        await dialog.getByRole("link", { name: /^Google Photos Library\b/ }).click();
        await page.waitForURL(/\/integrations\/add\/openapi/);
        await page.getByRole("heading", { name: "Add OpenAPI integration" }).waitFor();
      });

      await step("The Library link carries the focused OpenAPI preset", async () => {
        const url = new URL(page.url());
        expect(url.searchParams.get("preset")).toBe("google-photos-library");
        expect(url.searchParams.get("url")).toContain("photoslibrary");
        await expect.poll(() => page.locator("textarea").inputValue()).toContain("photoslibrary");
      });
    });
  }),
);
