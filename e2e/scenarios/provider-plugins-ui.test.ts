import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Provider plugins · Google and Microsoft own their add flows outside OpenAPI",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the integrations picker", async () => {
        await page.goto("/integrations", { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "Connect" }).click();
        await page.getByRole("dialog", { name: "Connect an integration" }).waitFor();
      });

      await step(
        "The provider list exposes OpenAPI, Google, and Microsoft separately",
        async () => {
          const dialog = page.getByRole("dialog", {
            name: "Connect an integration",
          });
          await dialog.getByRole("link", { name: "OpenAPI", exact: true }).waitFor();
          await dialog.getByRole("link", { name: "Google", exact: true }).waitFor();
          await dialog.getByRole("link", { name: "Microsoft", exact: true }).waitFor();
        },
      );

      await step("OpenAPI add remains generic", async () => {
        await page.goto("/integrations/add/openapi", {
          waitUntil: "domcontentloaded",
        });
        await page.getByRole("heading", { name: "Add OpenAPI Integration" }).waitFor();
        await page.getByText("OpenAPI Spec").waitFor();
        expect(await page.getByText("Customize your Google connection").count()).toBe(0);
        expect(await page.getByText("Customize Microsoft Graph").count()).toBe(0);
      });

      await step("Google has its own product picker", async () => {
        await page.goto("/integrations/add/google", {
          waitUntil: "domcontentloaded",
        });
        await page.getByRole("heading", { name: "Add Google" }).waitFor();
        await page.getByText("Customize your Google connection").waitFor();
        await page.getByText("Gmail").first().waitFor();
        await page.getByText("Google Calendar").first().waitFor();
      });

      await step("Microsoft has its own Graph scope picker", async () => {
        await page.goto("/integrations/add/microsoft", {
          waitUntil: "domcontentloaded",
        });
        await page.getByRole("heading", { name: "Add Microsoft Graph" }).waitFor();
        await page.getByText("Customize Microsoft Graph").waitFor();
        expect(await page.getByText("All Microsoft Graph", { exact: true }).count()).toBe(0);
        await page.getByText("Productivity").waitFor();
        await page.getByText("Directory and identity").waitFor();
        await page.getByText("Outlook Mail").waitFor();
        await page.getByText("OneDrive Files").waitFor();
        await page.getByText("OneNote", { exact: true }).waitFor();
        await page.getByText("Teams Channels").waitFor();
        await page.locator('img[src*="svgl.app/library/microsoft-outlook.svg"]').first().waitFor();
        await page.locator('img[src*="svgl.app/library/microsoft-onedrive.svg"]').waitFor();
        await page.getByRole("button", { name: /View scopes/ }).click();
        await page.getByText("offline_access").waitFor();
        await page.getByText("Mail.ReadWrite").waitFor();
      });
    });
  }),
);
