import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { clickToReveal, visit } from "../src/surfaces/browser";

scenario(
  "Provider catalog · Google and Microsoft services are OpenAPI presets",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the integrations picker from the sidebar", async () => {
        await visit(page, "/policies");
        await clickToReveal(
          page
            .getByRole("navigation")
            .getByRole("button", { name: "Add integration", exact: true }),
          page.getByRole("dialog", { name: "Connect an integration" }),
        );
      });

      await step("The picker exposes OpenAPI plus provider service presets", async () => {
        const dialog = page.getByRole("dialog", {
          name: "Connect an integration",
        });
        const search = dialog.getByPlaceholder(/Search or paste a URL/);
        await dialog.getByRole("link", { name: "OpenAPI", exact: true }).waitFor();

        await search.fill("gmail");
        await dialog.getByRole("link", { name: /^Gmail\b/ }).waitFor();

        await search.fill("onedrive");
        await dialog.getByRole("link", { name: /^OneDrive Files\b/ }).waitFor();
      });

      await step("OpenAPI add remains generic", async () => {
        await page.goto("/integrations/add/openapi", {
          waitUntil: "domcontentloaded",
        });
        await page.getByRole("heading", { name: "Add OpenAPI integration" }).waitFor();
        await page.getByText("OpenAPI Spec").waitFor();
        expect(await page.getByText("Customize your Google connection").count()).toBe(0);
        expect(await page.getByText("Customize Microsoft Graph").count()).toBe(0);
      });

      await step("A Google service preset opens the OpenAPI add flow", async () => {
        await page.goto(
          "/integrations/add/openapi?preset=google-gmail&url=https%3A%2F%2Fwww.googleapis.com%2Fdiscovery%2Fv1%2Fapis%2Fgmail%2Fv1%2Frest",
          { waitUntil: "domcontentloaded" },
        );
        await page.getByRole("heading", { name: "Add OpenAPI integration" }).waitFor();
        await expect.poll(() => page.locator("textarea").inputValue()).toContain("gmail");
      });

      await step("A Microsoft service preset opens the OpenAPI add flow", async () => {
        await page.goto(
          "/integrations/add/openapi?preset=microsoft-files&url=https%3A%2F%2Fgithub.com%2FUsefulSoftwareCo%2Fexecutor%2Freleases%2Fdownload%2Fgraph-slices%2Ffiles.yaml",
          { waitUntil: "domcontentloaded" },
        );
        await page.getByRole("heading", { name: "Add OpenAPI integration" }).waitFor();
        await expect
          .poll(() => page.locator("textarea").inputValue())
          .toContain("graph-slices/files.yaml");
      });
    });
  }),
);
