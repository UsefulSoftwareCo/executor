/**
 * The app Accounts tab's choices for one requirement: a list named `<Provider> accounts` with
 * every account the caller could link, each with a radio (plain requirement) or a checkbox
 * (many()) that is checked while the account is linked.
 */
import type { Locator, Page } from "playwright";

/** One requirement's list of choices, named after its provider. */
export const accountChoices = (
  root: Page | Locator,
  provider: string,
  options: { readonly includeHidden?: boolean } = {},
) => root.getByRole("list", { name: `${provider} accounts`, exact: true, ...options });

/** The control of a linked account in one requirement's choices. */
export const linkedChoice = (root: Page | Locator, provider: string, label: string) => {
  const list = accountChoices(root, provider);
  return list
    .getByRole("radio", { name: label, exact: true, checked: true })
    .or(list.getByRole("checkbox", { name: label, exact: true, checked: true }));
};

/** The controls of every linked account in one requirement's choices. */
export const linkedChoices = (root: Page | Locator, provider: string) => {
  const list = accountChoices(root, provider);
  return list
    .getByRole("radio", { checked: true })
    .or(list.getByRole("checkbox", { checked: true }));
};

/** The labels of the linked accounts in one requirement's choices, in the order shown. */
export const linkedLabels = (root: Page | Locator, provider: string) =>
  linkedChoices(root, provider).evaluateAll((controls) =>
    controls.map((control) => control.getAttribute("aria-label") ?? ""),
  );

/** Link an account the caller could use by selecting its radio or checkbox. */
export const chooseAccount = (root: Page | Locator, provider: string, label: string) => {
  const list = accountChoices(root, provider);
  return list
    .getByRole("radio", { name: label, exact: true })
    .or(list.getByRole("checkbox", { name: label, exact: true }))
    .click();
};
