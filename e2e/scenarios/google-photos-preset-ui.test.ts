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
        await page.getByRole("heading", { name: "Add Google integration" }).waitFor();
      });

      await step("The Photos preset pre-checks both Photos products for fan-out", async () => {
        // The focused flow initializes the multi-select picker with exactly
        // the two Photos presets checked; each is added as its own
        // integration on submit.
        const library = page.getByRole("checkbox", { name: /Google Photos Library/ });
        const picker = page.getByRole("checkbox", { name: /Google Photos Picker/ });
        await library.waitFor();
        await picker.waitFor();
        expect(await library.isChecked()).toBe(true);
        expect(await picker.isChecked()).toBe(true);
        // Other products stay unchecked: the flow is Photos-scoped, not the
        // featured default selection.
        expect(await page.getByRole("checkbox", { name: /Google Calendar/ }).isChecked()).toBe(
          false,
        );
        // The scope preview counts exactly the two checked Photos products.
        await page.getByRole("button", { name: /^View scopes 2$/ }).waitFor();
      });

      await step("Multi-select keeps preset identities: no name/namespace form", async () => {
        // With two products checked there is no single-integration identity
        // form; the settings section spells out that presets keep their own
        // names and namespaces.
        await page.getByText("Google product settings").waitFor();
        await page.getByText("Selected products keep their preset names and namespaces.").waitFor();
        expect(await page.locator('input[value="Google Photos"]').count()).toBe(0);
        expect(await page.locator('input[value="google_photos"]').count()).toBe(0);
        expect(await page.locator('input[value="Google"]').count()).toBe(0);
        expect(await page.locator('input[value="google"]').count()).toBe(0);
        // The submit button is armed for the checked selection.
        const connect = page.getByRole("button", { name: "Connect Google" });
        await connect.waitFor();
        expect(await connect.isEnabled()).toBe(true);
      });
    });
  }),
);
