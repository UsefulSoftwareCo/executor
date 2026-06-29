import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Google Photos: the focused preset opens a Photos-scoped add flow",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Find the Google Photos preset from the integrations picker", async () => {
        await page.goto("/integrations", { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "Connect" }).click();
        const dialog = page.getByRole("dialog", { name: "Connect an integration" });
        await dialog.waitFor();
        await dialog.getByPlaceholder(/Search or paste a URL/).fill("google photos");
        await dialog.getByRole("link", { name: /^Google Photos\b/ }).waitFor();
      });

      await step("Open the Google Photos scoped add flow", async () => {
        const dialog = page.getByRole("dialog", { name: "Connect an integration" });
        await dialog.getByRole("link", { name: /^Google Photos\b/ }).click();
        await page.waitForURL(/\/integrations\/add\/google/);
        await page.getByRole("heading", { name: "Add Google" }).waitFor();
      });

      await step("The Photos preset defaults to the focused namespace and products", async () => {
        await page.locator('input[value="Google Photos"]').waitFor();
        await page.locator('input[value="google_photos"]').waitFor();
        await page.getByText("Google Photos Library").first().waitFor();
        await page.getByText("Google Photos Picker").first().waitFor();
        await page.getByText("2 Google APIs").waitFor();
        expect(await page.locator('input[value="Google"]').count()).toBe(0);
        expect(await page.locator('input[value="google"]').count()).toBe(0);
      });
    });
  }),
);
