import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Locator } from "playwright";
import { Browser } from "./browser.ts";

export const appIconFile = {
  path: "ui/icon.svg",
  content:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#2f9e6e"/></svg>',
};

const shownIcon = (mark: Locator) =>
  mark
    .elementHandle()
    .then((element) =>
      mark.page().waitForFunction((element) => {
        const image = element.querySelector('img[data-icon="app"]');
        return element.isConnected && (!(image instanceof HTMLImageElement) || image.complete);
      }, element),
    )
    .then(() =>
      mark.evaluate((element) => {
        const image = element.querySelector('img[data-icon="app"]');
        return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
          ? new URL(image.src).pathname
          : "";
      }),
    );

const cube = (mark: Locator) =>
  Promise.all([mark.locator("img").count(), mark.locator("svg").count()]);

export const retainedAppIcons = (
  pages: { readonly list: string; readonly detail: string },
  withIcon: { readonly id: string; readonly name: string },
  withoutIcon: { readonly id: string; readonly name: string },
  iconPath: string,
) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use("Open the app list", (page) =>
      page.goto(pages.list).then(() => page.getByRole("heading", { name: /^Apps/u }).waitFor()),
    );
    expect(
      yield* browser.use("The dashboard serves the app's icon to its session", (page) =>
        page.evaluate(
          ([withIcon, withoutIcon]) =>
            Promise.all(
              [withIcon, withoutIcon].map((path) =>
                fetch(path).then((response) => ({
                  status: response.status,
                  type: response.headers.get("content-type"),
                  policy: response.headers
                    .get("content-security-policy")
                    ?.startsWith("default-src 'none'"),
                })),
              ),
            ),
          [iconPath, iconPath.replace(withIcon.id, withoutIcon.id)] as const,
        ),
      ),
    ).toMatchObject([{ status: 200, type: "image/svg+xml", policy: true }, { status: 404 }]);
    const images = yield* browser.use("Read the icon images", (page) =>
      page.locator("img").evaluateAll((all) => all.map((image) => (image as HTMLImageElement).src)),
    );
    expect(
      images.some((src) => src.includes(iconPath)),
      JSON.stringify(images),
    ).toBe(true);
    const card = (name: string) => (page: import("playwright").Page) =>
      page.getByRole("link", { name: new RegExp(`^Open ${name}`, "u") }).locator(".provider-icon");
    yield* browser.use("The app's own icon replaces the cube once it loads", (page) =>
      card(withIcon.name)(page).locator('img[data-icon="app"]').waitFor(),
    );
    yield* browser.use("The app without an icon settles on the cube", (page) =>
      Promise.all([
        card(withoutIcon.name)(page).locator("svg").waitFor(),
        card(withoutIcon.name)(page).locator("img").waitFor({ state: "detached" }),
      ]),
    );
    expect(
      yield* browser.use("Read the app list's icons", (page) =>
        Promise.all([shownIcon(card(withIcon.name)(page)), cube(card(withoutIcon.name)(page))]),
      ),
    ).toEqual([iconPath, [0, 1]]);
    yield* browser.checkpoint("The app list shows an app's own icon and the cube without one");
    yield* browser.use("Open the app with an icon", (page) =>
      page
        .goto(pages.detail)
        .then(() => page.locator('header .provider-icon-large img[data-icon="app"]').waitFor()),
    );
    expect(
      yield* browser.use("Read the app page's icon", (page) =>
        shownIcon(page.locator("header .provider-icon-large")),
      ),
    ).toBe(iconPath);
  });
