import type { Page } from "playwright";

export const enterClientDetails = (page: Page) => {
  const dialog = page.getByRole("dialog");
  return dialog
    .getByRole("combobox", { name: "Who can use this client", exact: true })
    .click()
    .then(() => page.getByRole("option", { name: "Only this account", exact: true }).click())
    .then(() => page.getByRole("listbox").waitFor({ state: "hidden" }));
};
