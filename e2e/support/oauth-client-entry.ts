import type { Page } from "playwright";

/**
 * Administrators without a client for the service are offered registration first; entering
 * details for one account is a deliberate choice under Advanced.
 */
export const enterClientDetails = (page: Page) => {
  const dialog = page.getByRole("dialog");
  return dialog
    .getByText("Advanced", { exact: true })
    .click()
    .then(() =>
      dialog
        .getByRole("checkbox", { name: "Enter client details for this account", exact: true })
        .check(),
    );
};
