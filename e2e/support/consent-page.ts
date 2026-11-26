import type { Page } from "playwright";

export type ConsentRow = "Organization" | "Access" | "Approvals" | "Code";

export const consentRow = (page: Page, label: ConsentRow) =>
  page.locator(`xpath=//dl/div/dt[normalize-space(.)="${label}"]/following-sibling::dd[1]`);

export const consentValue = (page: Page, label: ConsentRow) =>
  consentSettled(page).then(() =>
    consentRow(page, label)
      .innerText()
      .then((text) => text.trim()),
  );

export const consentSettled = (page: Page) =>
  Promise.all([
    page
      .getByRole("status", { name: "Loading organization", exact: true })
      .waitFor({ state: "detached" }),
    consentMenu(page, "Access")
      .and(page.locator('[aria-busy="true"]'))
      .waitFor({ state: "detached" }),
  ]).then(() => undefined);

export const consentMenu = (page: Page, label: ConsentRow) =>
  page.getByRole("combobox", { name: label, exact: true });

export const consentOption = (page: Page, title: string) =>
  page.getByRole("option").filter({ has: page.getByText(title, { exact: true }) });

export const peekConsent = (page: Page, label: ConsentRow, shown: (page: Page) => Promise<void>) =>
  consentMenu(page, label)
    .click()
    .then(() => shown(page))
    .then(() => page.keyboard.press("Escape"))
    .then(() => page.getByRole("listbox").waitFor({ state: "hidden" }));

export const chooseConsent = (page: Page, label: ConsentRow, title: string) =>
  consentMenu(page, label)
    .click()
    .then(() => consentOption(page, title).click())
    .then(() => page.getByRole("listbox").waitFor({ state: "hidden" }));

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
