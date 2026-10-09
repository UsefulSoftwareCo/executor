/**
 * The OAuth connect form, as hosted dialogs and the local connection page render it. With client
 * entry it reads, top to bottom: what happened or what to do, the redirect URL, the client
 * fields, where the sign-in goes, and the Connect action.
 */
import type { Locator } from "playwright";

/** Name each visible part of the form in its on-screen order, top to bottom. */
export const formOrder = (parts: Readonly<Record<string, Locator>>) =>
  Promise.all(
    Object.entries(parts).map(([name, part]) =>
      part.boundingBox().then((bounds) => {
        if (bounds === null) throw new Error(`The form's ${name} must be visible`);
        return { name, top: bounds.y };
      }),
    ),
  ).then((placed) => placed.toSorted((a, b) => a.top - b.top).map(({ name }) => name));

/** Whether the line saying where the sign-in goes sits directly above the Connect action. */
export const accessBeforeConnect = (form: Locator) =>
  form
    .locator("[data-credential-access]")
    .evaluate(
      (line) => line.nextElementSibling?.getAttribute("aria-label") === "Connection options",
    );
