import type { Page } from "playwright";

export const nameAccountDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Name this account", exact: true });

export const accountNameField = (page: Page) =>
  nameAccountDialog(page).getByRole("textbox", { name: "Account name", exact: true });

export const accountNamePrompt = (page: Page) =>
  accountNameField(page).waitFor({ state: "visible" });

export const nameConnectedAccount = (page: Page, label?: string) =>
  accountNamePrompt(page)
    .then(() => (label === undefined ? undefined : accountNameField(page).fill(label)))
    .then(() =>
      nameAccountDialog(page).getByRole("button", { name: "Save name", exact: true }).click(),
    )
    .then(() => nameAccountDialog(page).waitFor({ state: "hidden" }));

export const dismissAccountName = (page: Page) =>
  accountNamePrompt(page)
    .then(() => page.keyboard.press("Escape"))
    .then(() => nameAccountDialog(page).waitFor({ state: "hidden" }));
