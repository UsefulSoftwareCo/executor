import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { holdQuery } from "../support/query-transition.ts";
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
              const metadata = yield* holdQuery(["/api/auth/organization/list"], "continue", {
                allRequests: true,
              });
              yield* browser.use("Open settings with unknown organization values", (page) =>
                page.goto(`/org/${actors.organization.slug}/organization`),
              );
              yield* metadata.requested;
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
              const before = yield* browser.use("Record static card positions", (page) =>
                page.locator(".organization-settings h2").evaluateAll((headings) =>
                  headings.map((heading) => ({
                    text: heading.textContent,
                    y: heading.getBoundingClientRect().y,
                  })),
                ),
              );
              expect(
                yield* browser.use("Settings values have small placeholders", (page) =>
                  page.getByLabel("Loading name", { exact: true }).count(),
                ),
              ).toBe(1);
              expect(
                yield* browser.use("Unloaded settings cannot be saved", (page) =>
                  page
                    .getByRole("button", { name: "Save", exact: true })
                    .evaluateAll((buttons) =>
                      buttons.every((button) => button.matches(":disabled")),
                    ),
                ),
              ).toBe(true);
              yield* browser.checkpoint(`${viewport.width} settings values pending`);
              yield* metadata.release;
              yield* browser.use("The name input loads", (page) =>
                page
                  .getByRole("textbox", { name: "Organization name", exact: true })
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
              yield* browser.use("Members finish loading", (page) =>
                page
                  .getByRole("table", { name: "Members", exact: true })
                  .waitFor({ state: "visible" }),
              );
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
              const metadata = yield* holdQuery(["/api/auth/organization/list"], "continue", {
                allRequests: true,
              });
              const tokens = yield* holdQuery(["/api/auth/api-key/list"], "continue", {
                allRequests: true,
              });
              yield* browser.use("Open API keys while metadata and tokens are held", (page) =>
                page.goto(`/org/${actors.organization.slug}/api-keys`),
              );
              yield* metadata.requested;
              expect(
                yield* browser.use(
                  "The API keys heading never becomes Organization settings",
                  (page) =>
                    page.getByRole("heading", { name: "API keys", exact: true }).isVisible(),
                ),
              ).toBe(true);
              yield* tokens.requested;
              yield* browser.use("Only token values are pending", (page) =>
                page
                  .getByRole("status", { name: "Loading tokens", exact: true })
                  .waitFor({ state: "visible" }),
              );
              expect(
                yield* browser.use("Connection instructions are already visible", (page) =>
                  page
                    .getByRole("heading", { name: "Connect an MCP client", exact: true })
                    .isVisible(),
                ),
              ).toBe(true);
              yield* browser.checkpoint(`${viewport.width} API keys values pending`);
              yield* tokens.release;
              yield* browser.use("Token data resolves before organization metadata", (page) =>
                page
                  .getByRole("status", { name: "Loading tokens", exact: true })
                  .waitFor({ state: "hidden" }),
              );
              expect(
                yield* browser.use("Create waits for verified organization details", (page) =>
                  page.getByRole("button", { name: "Create token", exact: true }).isDisabled(),
                ),
              ).toBe(true);
              yield* browser.checkpoint(`${viewport.width} API keys before metadata`);
              yield* metadata.release;
              yield* browser.use("Create becomes usable", (page) =>
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
              yield* browser.checkpoint(`${viewport.width} API keys loaded`);
            }),
          );
        }
      }),
    ),
  );
});
