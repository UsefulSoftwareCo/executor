import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { holdQuery } from "../support/query-transition.ts";
import { openThroughBrowser } from "../support/in-app-navigation.ts";
import { scenarios } from "../test-plan.ts";

const viewports = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
];

layer(HostedLive, { excludeTestServices: true })("Settings page loading", (it) => {
  it.effect(scenarios.settingsLoading.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        yield* browser.login(actors.owner);
        for (const viewport of viewports) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* browser.use("Set viewport", (page) => page.setViewportSize(viewport));
              const reads: string[] = [];
              yield* browser.use("Watch member reads", (page) => {
                page.on("request", (request) => {
                  if (new URL(request.url()).pathname === "/api/auth/organization/list-members")
                    reads.push(request.url());
                });
                return Promise.resolve();
              });
              const response = yield* browser.use("Open settings", (page) =>
                page.goto(`/org/${actors.organization.slug}/organization`),
              );
              if (response === null) throw new Error("Settings did not return a document");
              const html = yield* browser.use("Read the settings document", () => response.text());
              expect(html).toContain('aria-label="Members"');
              expect(html).toMatch(/aria-label="Role for [^"@]+@[^"]+"/);
              expect(reads).toEqual([]);
              const members = yield* holdQuery(
                ["/api/auth/organization/list-members"],
                "continue",
                {
                  allRequests: true,
                },
              );
              yield* openThroughBrowser(
                "Open settings while members are held",
                `/org/${actors.organization.slug}/organization`,
              );
              yield* members.requested;
              for (const name of [
                "Organization name",
                "Organization icon",
                "Organization URL",
                "Members",
              ]) {
                expect(
                  yield* browser.use(`Static ${name} heading is visible`, (page) =>
                    page.getByRole("heading", { name, exact: true }).isVisible(),
                  ),
                ).toBe(true);
              }
              expect(
                yield* browser.use("The organization name is already known", (page) =>
                  page
                    .getByRole("textbox", {
                      name: "Organization name",
                      exact: true,
                    })
                    .inputValue(),
                ),
              ).toMatch(/\S/);
              expect(
                yield* browser.use("Only member rows are pending", (page) =>
                  page
                    .getByRole("status", {
                      name: "Loading members",
                      exact: true,
                    })
                    .isVisible(),
                ),
              ).toBe(true);
              const before = yield* browser.use("Record static card positions", (page) =>
                page.locator(".organization-settings h2").evaluateAll((headings) =>
                  headings.map((heading) => ({
                    text: heading.textContent,
                    y: heading.getBoundingClientRect().y,
                  })),
                ),
              );
              yield* browser.checkpoint(`${viewport.width} settings members pending`);
              yield* members.release;
              yield* browser.use("Members finish loading", (page) =>
                page
                  .getByRole("table", { name: "Members", exact: true })
                  .waitFor({ state: "visible" }),
              );
              const after = yield* browser.use("Record loaded card positions", (page) =>
                page.locator(".organization-settings h2").evaluateAll((headings) =>
                  headings.map((heading) => ({
                    text: heading.textContent,
                    y: heading.getBoundingClientRect().y,
                  })),
                ),
              );
              expect(after.length).toBe(before.length);
              for (const heading of before) {
                const loaded = after.find((item) => item.text === heading.text);
                expect(loaded).toBeDefined();
                if (loaded === undefined) throw new Error("A static settings heading disappeared");
                expect(Math.abs(loaded.y - heading.y)).toBeLessThanOrEqual(2);
              }
              yield* browser.checkpoint(`${viewport.width} settings loaded`);
            }),
          );
        }
      }),
    ),
  );

  it.effect(scenarios.apiKeysLoading.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        yield* browser.login(actors.owner);
        for (const viewport of viewports) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* browser.use("Set viewport", (page) => page.setViewportSize(viewport));
              const tokens = yield* holdQuery(["/api/auth/api-key/list"], "continue", {
                allRequests: true,
              });
              yield* openThroughBrowser(
                "Open account tokens while tokens are held",
                `/account/tokens?organization=${actors.organization.slug}`,
              );
              yield* tokens.requested;
              expect(
                yield* browser.use("The Tokens heading is present before tokens resolve", (page) =>
                  page.getByRole("heading", { name: "Tokens", exact: true }).isVisible(),
                ),
              ).toBe(true);
              yield* browser.use("Only token values are pending", (page) =>
                page
                  .getByRole("status", {
                    name: "Loading tokens",
                    exact: true,
                  })
                  .waitFor({ state: "visible" }),
              );
              expect(
                yield* browser.use("Token guidance is already visible", (page) =>
                  page.getByText(/^Tokens have your current permissions/).isVisible(),
                ),
              ).toBe(true);
              yield* browser.checkpoint(`${viewport.width} Tokens values pending`);
              yield* tokens.release;
              yield* browser.use("Tokens resolve", (page) =>
                page
                  .getByRole("status", {
                    name: "Loading tokens",
                    exact: true,
                  })
                  .waitFor({ state: "hidden" }),
              );
              yield* browser.use("Create is usable", (page) =>
                page.getByRole("button", { name: "Create token", exact: true }).click(),
              );
              yield* browser.use("A token name can be entered", (page) =>
                page.getByRole("textbox", { name: "Name", exact: true }).fill("Loading check"),
              );
              expect(
                yield* browser.use("The form retains the entered name", (page) =>
                  page.getByRole("textbox", { name: "Name", exact: true }).inputValue(),
                ),
              ).toBe("Loading check");
              yield* browser.use("Close without creating a token", (page) =>
                page.getByRole("button", { name: "Cancel", exact: true }).click(),
              );
              yield* browser.checkpoint(`${viewport.width} Tokens loaded`);
            }),
          );
        }
      }),
    ),
  );
});
