/** The Apps view choice survives real navigation without changing app discovery. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({ id: Schema.String });
layer(HostedLive, { excludeTestServices: true })("Apps views", (it) => {
  it.effect(scenarios.appsViews.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Layout fixture",
          files: [
            {
              path: "index.ts",
              content: 'import { defineApp } from "apps"; export default defineApp({}, {});',
            },
            appsManifest,
          ],
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        const errors: string[] = [];
        yield* browser.use("Watch hydration", (page) => {
          page.on("pageerror", (error) => errors.push(String(error)));
          page.on("console", (message) => {
            if (
              message.type() === "error" &&
              /hydrat|Minified React error #(418|419|423|425)/i.test(message.text())
            )
              errors.push(message.text());
          });
          return page.goto(`/org/${actors.organization.slug}/apps`);
        });
        const selected = (view: string) =>
          browser.use(`Wait for ${view} view`, (page) =>
            page
              .getByRole("group", { name: "Apps view", exact: true })
              .getByRole("button", { name: view, exact: true, pressed: true })
              .waitFor({ state: "visible" }),
          );
        yield* selected("List");
        const height = (step: string) =>
          browser.use(step, (page) =>
            page
              .getByRole("link", { name: "Open Layout fixture", exact: true })
              .boundingBox()
              .then((box) => box?.height ?? 0),
          );
        expect(yield* height("List rows are compact")).toBeLessThanOrEqual(48);
        yield* browser.checkpoint("List is the compact default");
        yield* browser.use("Filter apps and switch to Cards", (page) =>
          page
            .getByRole("textbox", { name: "Search apps…" })
            .fill("Layout fixture")
            .then(() => page.getByRole("button", { name: "Cards", exact: true }).click()),
        );
        yield* selected("Cards");
        expect(yield* height("Cards retain their original height")).toBeGreaterThanOrEqual(137);
        expect(
          yield* browser.use("Search survives the switch", (page) =>
            page.getByRole("textbox", { name: "Search apps…" }).inputValue(),
          ),
        ).toBe("Layout fixture");
        yield* browser.checkpoint("Cards preserve search and app links");
        yield* browser.use("Reload with the saved Cards preference", (page) => page.reload());
        yield* selected("Cards");
        yield* browser.use("Open the same app", (page) =>
          page.getByRole("link", { name: "Open Layout fixture", exact: true }).click(),
        );
        yield* browser.use("App navigation still works", (page) =>
          page
            .getByRole("heading", { name: "Layout fixture overview", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Return to apps", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* selected("Cards");
        yield* browser.use("Choose List on a phone", (page) =>
          page
            .setViewportSize({ width: 390, height: 844 })
            .then(() => page.getByRole("button", { name: "List", exact: true }).click()),
        );
        yield* selected("List");
        expect(
          yield* browser.use("No horizontal overflow", (page) =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ),
        ).toBe(true);
        yield* browser.checkpoint("List and its controls fit a phone");
        yield* browser.use("Block browser storage", (page) =>
          page.addInitScript(() => {
            Object.defineProperty(Storage.prototype, "getItem", {
              value() {
                throw new DOMException("Blocked", "SecurityError");
              },
            });
            Object.defineProperty(Storage.prototype, "setItem", {
              value() {
                throw new DOMException("Blocked", "SecurityError");
              },
            });
          }),
        );
        yield* browser.use("Reload with blocked storage", (page) => page.reload());
        yield* selected("List");
        yield* browser.use("Switch without saving", (page) =>
          page.getByRole("button", { name: "Cards", exact: true }).click(),
        );
        yield* selected("Cards");
        expect(errors).toEqual([]);
      }),
    ),
  );
});
