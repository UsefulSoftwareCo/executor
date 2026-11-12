/**
 * The sign-in page's summary rows, as a person reads and changes them. A row's value is plain text
 * or a menu labelled by the row; these read and choose both the same way.
 */
import type { Page } from "playwright";

export type ConsentRow = "Organization" | "Access" | "Approvals" | "Code";

/** The row's value cell, whichever form it takes. */
export const consentRow = (page: Page, label: ConsentRow) =>
  page.locator(`xpath=//dl/div/dt[normalize-space(.)="${label}"]/following-sibling::dd[1]`);

/** Wait until no row is still loading, then read the row's value as shown. */
export const consentValue = (page: Page, label: ConsentRow) =>
  consentSettled(page).then(() =>
    consentRow(page, label)
      .innerText()
      .then((text) => text.trim()),
  );

/** Rows read in the browser show a status while they load. */
export const consentSettled = (page: Page) =>
  Promise.all(
    ["Loading organization", "Loading access"].map((name) =>
      page.getByRole("status", { name, exact: true }).waitFor({ state: "detached" }),
    ),
  ).then(() => undefined);

/** The menu that sets a row, when the person may change it. */
export const consentMenu = (page: Page, label: ConsentRow) =>
  page.getByRole("combobox", { name: label, exact: true });

/** An entry of the open menu, by its title; entries also carry a one-line description. */
export const consentOption = (page: Page, title: string) =>
  page.getByRole("option").filter({ has: page.getByText(title, { exact: true }) });

/** Open a row's menu and choose the entry with this title. */
export const chooseConsent = (page: Page, label: ConsentRow, title: string) =>
  consentMenu(page, label)
    .click()
    .then(() => consentOption(page, title).click())
    .then(() => page.getByRole("listbox").waitFor({ state: "hidden" }));

/**
 * Approve for this organization. With one organization the row names it; with several it is a
 * menu. Another scenario may have given the owner a temporary organization meanwhile.
 */
export const chooseConsentOrganization = (page: Page, name: string) =>
  consentSettled(page)
    .then(() => consentMenu(page, "Organization").count())
    .then((menus) =>
      menus === 0
        ? consentRow(page, "Organization")
            .innerText()
            .then((shown) => {
              if (shown.trim() !== name)
                throw new Error(`The consent names organization "${shown}", not "${name}"`);
            })
        : chooseConsent(page, "Organization", name),
    );
