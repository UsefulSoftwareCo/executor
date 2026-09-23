import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Empty states", (it) => {
  it.effect(scenarios.emptyStates.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser;
        yield* browser.login(actors.owner);
        yield* browser.use("Use the dark theme", (page) =>
          page.emulateMedia({ colorScheme: "dark" }),
        );
        for (const viewport of [
          { width: 1440, height: 960 },
          { width: 390, height: 844 },
        ]) {
          yield* browser.use("Set empty-state viewport", (page) => page.setViewportSize(viewport));
          for (const section of ["groups", "apps", "accounts"] as const) {
            yield* browser.use(`Open empty ${section}`, (page) =>
              page.goto(`/org/${actors.organization.slug}/${section}`),
            );
            if (section === "apps" || section === "accounts") {
              yield* browser.use(`Search ${section} without a match`, (page) =>
                page.getByPlaceholder(`Search ${section}…`).fill("no-matching-item"),
              );
            }
            yield* browser.use(`Wait for ${section} empty state`, (page) =>
              page.locator(".empty-state").waitFor(),
            );
            yield* browser.checkpoint(`${viewport.width} empty ${section}`);
            if (section === "apps" || section === "accounts") {
              yield* browser.use(`Clear the ${section} search`, (page) =>
                page.getByRole("button", { name: "Clear search", exact: true }).click(),
              );
              yield* browser.use(`The ${section} list returns`, (page) =>
                page.locator(section === "apps" ? ".app-cards" : ".inventory").waitFor(),
              );
            }
          }
        }
        yield* browser.use("Return to Groups", (page) =>
          page.goto(`/org/${actors.organization.slug}/groups`),
        );
        yield* browser.use("Groups has loaded", (page) =>
          page.getByRole("heading", { name: "No groups yet", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("No search control before the first group", (page) =>
            page.getByRole("textbox", { name: "Search groups", exact: true }).count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("Creation is in the empty state", (page) =>
            page
              .locator(".empty-state")
              .getByRole("button", { name: "Create group", exact: true })
              .count(),
          ),
        ).toBe(1);
        yield* browser.use("Open the first group form from its empty state", (page) =>
          page
            .locator(".empty-state")
            .getByRole("button", { name: "Create group", exact: true })
            .click(),
        );
        yield* browser.use("The group form opens", (page) => page.getByRole("dialog").waitFor());
        yield* browser.use("Close without creating a group", (page) =>
          page.keyboard.press("Escape"),
        );

        // Controlled HTTP results exercise first-use states without deleting the built-in app or its token.
        yield* browser.use("Provide an empty authorized resource directory", (page) =>
          page.route("**/api/organizations/*/resources*", (route) =>
            route.fulfill({ json: { apps: [], accounts: [], pendingApp: false } }),
          ),
        );
        yield* browser.use("Provide an empty personal token list", (page) =>
          page.route("**/api/auth/api-key/list*", (route) =>
            route.fulfill({ json: { apiKeys: [], total: 0 } }),
          ),
        );
        for (const viewport of [
          { width: 1440, height: 960 },
          { width: 390, height: 844 },
        ]) {
          yield* browser.use("Set first-use viewport", (page) => page.setViewportSize(viewport));
          for (const section of ["apps", "accounts", "api-keys"] as const) {
            yield* browser.use(`Open first-use ${section}`, (page) =>
              page.goto(`/org/${actors.organization.slug}/${section}`),
            );
            yield* browser.use("The next action is visible", (page) =>
              page
                .locator(".empty-state")
                .getByRole(section === "api-keys" ? "button" : "link", {
                  name:
                    section === "apps"
                      ? "Add app"
                      : section === "accounts"
                        ? "Choose an app"
                        : "Create token",
                  exact: true,
                })
                .waitFor(),
            );
            expect(
              yield* browser.use("Empty lists do not offer search", (page) =>
                page.getByPlaceholder(/^Search (apps|accounts)/).count(),
              ),
            ).toBe(0);
            expect(
              yield* browser.use("Page fits the viewport", (page) =>
                page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
              ),
            ).toBe(true);
            yield* browser.checkpoint(`${viewport.width} first-use ${section}`);
          }
        }
        yield* browser.use("Open the empty token form", (page) =>
          page
            .locator(".empty-state")
            .getByRole("button", { name: "Create token", exact: true })
            .click(),
        );
        yield* browser.use("Token form opens", (page) => page.getByRole("dialog").waitFor());
        yield* browser.use("Close without creating a credential", (page) =>
          page.keyboard.press("Escape"),
        );
        yield* browser.use("Open filtered Apps", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("Open app filters", (page) =>
          page.getByRole("button", { name: "Filters", exact: true }).click(),
        );
        yield* browser.use("Open group filter", (page) =>
          page.getByRole("combobox", { name: "Filter apps by group", exact: true }).click(),
        );
        yield* browser.use("Choose private apps", (page) =>
          page.getByRole("option", { name: "Private apps", exact: true }).click(),
        );
        yield* browser.use("The group menu has closed", (page) =>
          page.getByRole("listbox").waitFor({ state: "hidden" }),
        );
        yield* browser.use("Close the filters to use the empty-state action", (page) =>
          page.keyboard.press("Escape"),
        );
        yield* browser.use("Filtered absence has a distinct message", (page) =>
          page.getByRole("heading", { name: "No apps match these filters", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("Filtered apps offer clear filters");
        yield* browser.use("Clear app filters", (page) =>
          page.getByRole("button", { name: "Clear filters", exact: true }).click(),
        );
        yield* browser.use("The unfiltered first-use state returns", (page) =>
          page.getByRole("heading", { name: "No apps available", exact: true }).waitFor(),
        );
        yield* browser.use("Choose an app from Accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/accounts`),
        );
        yield* browser.use("Follow account setup", (page) =>
          page.getByRole("link", { name: "Choose an app", exact: true }).click(),
        );
        yield* browser.use("Account setup reaches Apps", (page) =>
          page.waitForURL(`**/org/${actors.organization.slug}/apps`),
        );

        yield* browser.use("Fail the catalog reads", (page) =>
          page.route(
            /\/api\/(?:catalog(?:\?|$)|organizations\/[^/]+\/app-publications(?:\?|$))/,
            (route) => route.abort("failed"),
          ),
        );
        yield* browser.use("Open Add app during the failure", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/add`),
        );
        yield* browser.use("The catalog error is visible", (page) =>
          page.getByText("Unable to complete this request", { exact: true }).first().waitFor(),
        );
        expect(
          yield* browser.use("Failure is not a search result", (page) =>
            page.getByRole("heading", { name: "No matching apps", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Catalog error without a false empty search result");

        const group = yield* body(
          Schema.Struct({ id: Schema.String, revision: Schema.String }),
          yield* api.request(
            actors.owner,
            "POST",
            `/api/organizations/${actors.organization.id}/groups`,
            {
              name: `New team ${randomUUID().slice(0, 8)}`,
              description: "",
              memberIds: [],
            },
          ),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(
              actors.owner,
              "DELETE",
              `/api/organizations/${actors.organization.id}/groups/${group.id}`,
              {
                revision: group.revision,
              },
            )
            .pipe(Effect.orDie),
        );
        for (const viewport of [
          { width: 1440, height: 960 },
          { width: 390, height: 844 },
        ]) {
          yield* browser.use("Set group detail viewport", (page) => page.setViewportSize(viewport));
          yield* browser.use("Open a group with no members or shared apps", (page) =>
            page.goto(`/org/${actors.organization.slug}/groups/${group.id}`),
          );
          yield* browser.use("Empty members offer setup", (page) =>
            page.getByRole("button", { name: "Add members", exact: true }).waitFor(),
          );
          yield* browser.use("Empty group apps offer navigation", (page) =>
            page.getByRole("link", { name: "Browse apps", exact: true }).waitFor(),
          );
          yield* browser.checkpoint(`${viewport.width} empty group sections`);
        }
        yield* browser.use("Open member setup", (page) =>
          page.getByRole("button", { name: "Add members", exact: true }).click(),
        );
        yield* browser.use("Member setup opens the group editor", (page) =>
          page.getByRole("dialog", { name: "Edit group", exact: true }).waitFor(),
        );
      }),
    ),
  );
});
