import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("App filters", (it) => {
  it.effect(scenarios.appFilters.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const suffix = randomUUID().slice(0, 8);
        const names = [`Filter retained ${suffix}`, `Filter managed ${suffix}`];
        for (const [index, actor] of [actors.owner, actors.member].entries()) {
          const app = yield* body(
            App,
            yield* api.request(actor, "POST", `${prefix}/apps/deploy`, {
              name: names[index],
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp, query, object } from "apps";
export default defineApp({ accounts: {} }, { queries: {
  status: query({ input: object({}) }, async () => "ready")
} });`,
                },
              ],
            }),
          );
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(
              Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
              Effect.orDie,
            ),
          );
          const access = yield* body(
            Schema.Struct({ revision: Schema.String }),
            yield* api.request(actor, "GET", `${prefix}/apps/${app.id}/access`),
          );
          expect(
            (yield* api.request(actor, "PATCH", `${prefix}/apps/${app.id}/access`, {
              revision: access.revision,
              audience: { kind: "private" },
            })).status,
          ).toBe(200);
        }
        const paths = [actors.organization.slug, actors.organization.id].map(
          (reference) => `/api/organizations/${reference}/resources`,
        );
        yield* browser.login(actors.owner);
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          for (const outcome of ["continue", "fail"] as const) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* browser.use("Set viewport", (page) => page.setViewportSize(viewport));
                yield* browser.use("Open Apps with a fresh filter selection", (page) =>
                  page.goto(`/org/${actors.organization.slug}/apps`),
                );
                yield* browser.use("Wait for the available app", (page) =>
                  page.getByRole("link", { name: `Open ${names[0]}`, exact: true }).waitFor(),
                );
                yield* browser.use("Search the fixture apps", (page) =>
                  page.getByRole("textbox", { name: "Search apps…" }).fill(suffix),
                );
                yield* browser.use("Open filters", (page) =>
                  page.getByRole("button", { name: "Filters", exact: true }).click(),
                );
                yield* browser.use("Open group selection", (page) =>
                  page.getByRole("combobox", { name: "Filter apps by group" }).click(),
                );
                yield* browser.use("Choose private apps", (page) =>
                  page.getByRole("option", { name: "Private apps", exact: true }).click(),
                );
                yield* browser.use("The group menu has closed", (page) =>
                  page.getByRole("listbox").waitFor({ state: "hidden" }),
                );
                const checkRetained = (phase: string) =>
                  Effect.gen(function* () {
                    expect(
                      yield* browser.use(`${phase}: no skeleton`, (page) =>
                        page.getByRole("status", { name: "Loading apps", exact: true }).count(),
                      ),
                    ).toBe(0);
                    expect(
                      yield* browser.use(`${phase}: previous card`, (page) =>
                        page
                          .getByRole("link", { name: `Open ${names[0]}`, exact: true })
                          .isVisible(),
                      ),
                    ).toBe(true);
                    expect(
                      yield* browser.use(`${phase}: no new card yet`, (page) =>
                        page.getByRole("link", { name: `Open ${names[1]}`, exact: true }).count(),
                      ),
                    ).toBe(0);
                    expect(
                      yield* browser.use(`${phase}: search retained`, (page) =>
                        page.getByRole("textbox", { name: "Search apps…" }).inputValue(),
                      ),
                    ).toBe(suffix);
                    expect(
                      yield* browser.use(`${phase}: filters remain open`, (page) =>
                        page.getByRole("dialog", { name: "App filters" }).isVisible(),
                      ),
                    ).toBe(true);
                  });
                yield* checkRetained("The group filter keeps the current cards and search");
                const held = yield* holdQuery(paths, outcome);
                yield* browser.use("Open access selection", (page) =>
                  page.getByRole("combobox", { name: "App list" }).click(),
                );
                yield* browser.use("Switch to management mode", (page) =>
                  page.getByRole("option", { name: "Manage apps", exact: true }).click(),
                );
                yield* browser.use("The access menu has closed", (page) =>
                  page.getByRole("listbox").waitFor({ state: "hidden" }),
                );
                expect(paths).toContain(yield* held.requested);
                yield* checkRetained("The last cards remain during the held filter request");
                yield* browser.checkpoint(
                  `${viewport.width}: previous cards while ${outcome} is held`,
                );
                yield* held.release;
                if (outcome === "fail") {
                  yield* browser.use("The filter error offers retry", (page) =>
                    page.getByRole("button", { name: "Retry", exact: true }).waitFor(),
                  );
                  yield* checkRetained("The filter error preserves cards and the open controls");
                  const retry = yield* holdQuery(paths, "continue");
                  yield* browser.use("Close the popover to reach the retry action", (page) =>
                    page.keyboard.press("Escape"),
                  );
                  yield* browser.use("Retry the new filter", (page) =>
                    page.getByRole("button", { name: "Retry", exact: true }).click(),
                  );
                  expect(paths).toContain(yield* retry.requested);
                  yield* browser.use("Reopen the selected filters during retry", (page) =>
                    page.getByRole("button", { name: "Filters 2 active", exact: true }).click(),
                  );
                  yield* checkRetained("Retry keeps the last successful result");
                  yield* retry.release;
                }
                yield* browser.use("The new result replaces the previous cards", (page) =>
                  page.getByRole("link", { name: `Open ${names[1]}`, exact: true }).waitFor(),
                );
                expect(
                  yield* browser.use("The available app remains", (page) =>
                    page.getByRole("link", { name: `Open ${names[0]}`, exact: true }).isVisible(),
                  ),
                ).toBe(true);
                expect(
                  yield* browser.use("Search survives the result change", (page) =>
                    page.getByRole("textbox", { name: "Search apps…" }).inputValue(),
                  ),
                ).toBe(suffix);
                expect(
                  yield* browser.use("The access choice remains", (page) =>
                    page.getByRole("combobox", { name: "App list" }).innerText(),
                  ),
                ).toBe("Manage apps");
                yield* browser.checkpoint(
                  `${viewport.width}: management results replace retained cards`,
                );
              }),
            );
          }
        }
      }),
    ),
  );
});
