import type { Page } from "playwright";

/**
 * Administrators without a client for the service enter one in the connect form, registered for
 * everyone before sign-in unless they keep it to the one account, as these scenarios do.
 */
export const enterClientDetails = (page: Page) => {
  const dialog = page.getByRole("dialog");
  return dialog
    .getByRole("combobox", { name: "Who can use this client", exact: true })
    .click()
    .then(() => page.getByRole("option", { name: "Only this account", exact: true }).click())
    .then(() => page.getByRole("listbox").waitFor({ state: "hidden" }));
};
