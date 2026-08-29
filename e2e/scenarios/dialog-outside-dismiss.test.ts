// Cross-target (browser): a dialog decides from its contents whether a click
// outside closes it. While it holds a form field — including the one-time key
// reveal's read-only inputs — a stray click on the page behind it must not
// discard what the user typed or was shown. A field-free confirm dialog has
// nothing to lose, so the same click dismisses it without firing its action.
// The API keys page exercises both kinds in one flow.
import { Effect } from "effect";
import { expect } from "@effect/vitest";
import { AccountApi, addGroup } from "@executor-js/api";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const accountApi = addGroup(AccountApi);

const KEY_NAME = "outside-click-check";

scenario(
  "Dialogs (UI) · Outside click keeps a form open, closes a field-free confirm",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(accountApi, identity);

    const session = browser.session(identity, async ({ page, step }) => {
      const createDialog = page.getByRole("dialog").filter({ hasText: "Create API key" });
      const revokeDialog = page.getByRole("dialog").filter({ hasText: "Revoke API key" });
      const nameInput = page.locator("#create-key-name");
      const keyRow = page.getByText(KEY_NAME, { exact: true });
      // The overlay covers the whole viewport and the dialog panel is centered,
      // so the top-left corner is always outside the panel.
      const clickOutside = async () => {
        await page.mouse.click(8, 8);
        // Dismissal is synchronous with the pointer event; this beat only gives
        // a wrongly-dismissed dialog time to actually unmount before the
        // "still open" assertions run.
        await page.waitForTimeout(400);
      };

      await step("Open the create dialog and name the key", async () => {
        await visit(page, "/api-keys");
        await page.getByRole("button", { name: "New key" }).click();
        await nameInput.waitFor();
        await nameInput.fill(KEY_NAME);
      });

      await step("A stray outside click does not discard the form", async () => {
        await clickOutside();
        await createDialog.waitFor({ state: "visible" });
        expect(await nameInput.inputValue(), "the typed name survives the stray click").toBe(
          KEY_NAME,
        );
      });

      await step("The one-time key reveal also survives an outside click", async () => {
        await createDialog.getByRole("button", { name: "Create key" }).click();
        await createDialog.getByText("It is only shown once.").waitFor();
        await clickOutside();
        await createDialog.getByText("It is only shown once.").waitFor({ state: "visible" });
      });

      await step("Closing the reveal deliberately lands the key in the list", async () => {
        // "Close" also names the corner X; the footer's ghost button is the
        // deliberate path under test.
        await createDialog
          .locator("[data-slot='dialog-footer']")
          .getByRole("button", { name: "Close" })
          .click();
        await createDialog.waitFor({ state: "detached" });
        await keyRow.waitFor();
      });

      await step("An outside click dismisses the field-free revoke confirm", async () => {
        await page.getByRole("button", { name: `Revoke ${KEY_NAME}` }).click();
        await revokeDialog.waitFor({ state: "visible" });
        await clickOutside();
        await revokeDialog.waitFor({ state: "detached" });
        // Dismissal closed the dialog without firing the revoke.
        await keyRow.waitFor({ state: "visible" });
      });

      await step("Confirming the revoke still removes the key", async () => {
        await page.getByRole("button", { name: `Revoke ${KEY_NAME}` }).click();
        await revokeDialog.getByRole("button", { name: "Revoke key" }).click();
        await revokeDialog.waitFor({ state: "detached" });
        await keyRow.waitFor({ state: "detached" });
      });
    });

    // The final step revokes the key through the UI; this sweep only matters
    // when a mid-test failure aborts the session before that step runs.
    yield* Effect.ensuring(
      session,
      Effect.gen(function* () {
        const { apiKeys } = yield* client.account.listApiKeys();
        yield* Effect.forEach(
          apiKeys.filter((key) => key.name === KEY_NAME),
          (key) => client.account.revokeApiKey({ params: { apiKeyId: key.id } }),
        );
      }).pipe(Effect.ignore),
    );
  }),
);
