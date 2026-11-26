import type { Locator, Page } from "playwright";

export const accountChoices = (
  root: Page | Locator,
  provider: string,
  options: { readonly includeHidden?: boolean } = {},
) => root.getByRole("list", { name: `${provider} accounts`, exact: true, ...options });

export const linkedChoice = (root: Page | Locator, provider: string, label: string) => {
  const list = accountChoices(root, provider);
  return list
    .getByRole("radio", { name: label, exact: true, checked: true })
    .or(list.getByRole("checkbox", { name: label, exact: true, checked: true }));
};

export const linkedChoices = (root: Page | Locator, provider: string) => {
  const list = accountChoices(root, provider);
  return list
    .getByRole("radio", { checked: true })
    .or(list.getByRole("checkbox", { checked: true }));
};

export const linkedLabels = (root: Page | Locator, provider: string) =>
  linkedChoices(root, provider).evaluateAll((controls) =>
    controls.map((control) => control.getAttribute("aria-label") ?? ""),
  );

export const chooseAccount = (root: Page | Locator, provider: string, label: string) => {
  const list = accountChoices(root, provider);
  return list
    .getByRole("radio", { name: label, exact: true })
    .or(list.getByRole("checkbox", { name: label, exact: true }))
    .click();
};
