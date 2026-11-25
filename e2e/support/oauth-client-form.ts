import type { Locator } from "playwright";

export const formOrder = (parts: Readonly<Record<string, Locator>>) =>
  Promise.all(
    Object.entries(parts).map(([name, part]) =>
      part.boundingBox().then((bounds) => {
        if (bounds === null) throw new Error(`The form's ${name} must be visible`);
        return { name, top: bounds.y };
      }),
    ),
  ).then((placed) => placed.toSorted((a, b) => a.top - b.top).map(({ name }) => name));

export const accessBeforeConnect = (form: Locator) =>
  form
    .locator("[data-credential-access]")
    .evaluate(
      (line) => line.nextElementSibling?.getAttribute("aria-label") === "Connection options",
    );
