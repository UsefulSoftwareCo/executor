import { createProfile } from "../support/profiles.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp } from "apps";
export default defineApp({ accounts: {} }, async () => ({ queries: {} }));`;

layer(HostedLive, { excludeTestServices: true })("Empty state recovery", (it) => {
  it.effect(scenarios.emptyStateRecovery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const draft = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/drafts`, {
            name: `Empty draft ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }],
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${draft.id}`).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Use dark theme", (page) => page.emulateMedia({ colorScheme: "dark" }));
        for (const viewport of [
          { width: 1440, height: 960 },
          { width: 390, height: 844 },
        ]) {
          yield* browser.use("Set draft viewport", (page) => page.setViewportSize(viewport));
          yield* browser.use("Open draft overview", (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${draft.id}`),
          );
          yield* browser.use("Draft has a direct source action", (page) =>
            page.getByRole("link", { name: "Open source", exact: true }).waitFor(),
          );
          yield* browser.use("The source preview has loaded", (page) =>
            page.getByText("View the files that make this app work.", { exact: true }).waitFor(),
          );
          expect(
            yield* browser.use("One deployment state replaces repeated cards", (page) =>
              page.getByRole("heading", { name: "No deployment yet", exact: true }).count(),
            ),
          ).toBe(1);
          expect(
            yield* browser.use("Draft source is visible without scrolling", (page) =>
              page
                .getByRole("region", { name: "App source", exact: true })
                .evaluate((element) => element.getBoundingClientRect().top < window.innerHeight),
            ),
          ).toBe(true);
          yield* browser.checkpoint(`${viewport.width} draft overview`);
          yield* browser.use("Open draft schedules", (page) =>
            page
              .getByRole("navigation", { name: "App navigation" })
              .getByRole("link", { name: "Schedules", exact: true })
              .click(),
          );
          yield* browser.use("Schedules explains the missing deployment", (page) =>
            page.getByRole("heading", { name: "No deployment yet", exact: true }).waitFor(),
          );
          expect(
            yield* browser.use("No useless retry for a draft", (page) =>
              page.getByRole("button", { name: "Retry", exact: true }).count(),
            ),
          ).toBe(0);
          yield* browser.use("Draft schedules offer source after access resolves", (page) =>
            page.getByRole("link", { name: "Open source", exact: true }).waitFor(),
          );
          yield* browser.use("The draft header has finished loading", (page) =>
            page.locator("[data-slot=skeleton]").first().waitFor({ state: "hidden" }),
          );
          yield* browser.checkpoint(`${viewport.width} draft schedules`);
        }
        yield* browser.use("Open sharing without groups", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${draft.id}?view=settings`),
        );
        yield* browser.use("Choose sharing audience", (page) =>
          page.getByRole("combobox", { name: "Who can use this app?", exact: true }).click(),
        );
        yield* browser.use("Choose group sharing", (page) =>
          page.getByRole("option", { name: "Selected groups", exact: true }).click(),
        );
        yield* browser.use("Group setup has a next step", (page) =>
          page.getByRole("link", { name: "Open Groups", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Groups opens separately to preserve the draft", (page) =>
            page.getByRole("link", { name: "Open Groups", exact: true }).getAttribute("target"),
          ),
        ).toBe("_blank");
        yield* browser.checkpoint("Group sharing preserves the draft and explains setup");

        const deployed = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Empty capabilities ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }],
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${deployed.id}`).pipe(Effect.orDie),
        );
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${deployed.id}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${deployed.id}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        for (const viewport of [
          { width: 1440, height: 960 },
          { width: 390, height: 844 },
        ]) {
          yield* browser.use("Set empty overview viewport", (page) =>
            page.setViewportSize(viewport),
          );
          yield* browser.use("Open deployed empty overview", (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${deployed.id}`),
          );
          for (const title of ["No accounts required", "No tools", "No skills yet"]) {
            yield* browser.use(`Wait for ${title}`, (page) =>
              page.getByRole("heading", { name: title, exact: true }).waitFor(),
            );
          }
          yield* browser.use("The empty workflow result is explicit", (page) =>
            page.getByText("This app has no workflows.", { exact: true }).waitFor(),
          );
          yield* browser.use("Wait for source preview", (page) =>
            page.getByText("View the files that make this app work.", { exact: true }).waitFor(),
          );
          yield* browser.checkpoint(`${viewport.width} centered empty overview`);
          const layout = yield* browser.use(
            "Measure empty messages within their card bodies",
            (page) =>
              page.locator(".app-overview > div > section").evaluateAll((cards) =>
                cards.flatMap((card) => {
                  const empty = card.querySelector(".empty-state");
                  if (!empty) return [];
                  const bounds = empty.parentElement?.getBoundingClientRect();
                  if (!bounds) throw new Error("Empty overview card has no body");
                  const contextHeight =
                    card
                      .querySelector('[aria-label="Tool account context"]')
                      ?.getBoundingClientRect().height ?? 0;
                  const content = Array.from(empty.children).map((child) =>
                    child.getBoundingClientRect(),
                  );
                  const top = Math.min(...content.map((child) => child.top));
                  const bottom = Math.max(...content.map((child) => child.bottom));
                  return [
                    {
                      height: card.getBoundingClientRect().height,
                      verticalOffset: Math.abs(
                        (top + bottom) / 2 - (bounds.top + contextHeight + bounds.bottom) / 2,
                      ),
                      horizontalOffset: Math.max(
                        ...content.map((child) =>
                          Math.abs(
                            (child.left + child.right) / 2 - (bounds.left + bounds.right) / 2,
                          ),
                        ),
                      ),
                    },
                  ];
                }),
              ),
          );
          expect(layout).toHaveLength(3);
          for (const card of layout) {
            expect(card.height).toBe(240);
            expect(card.verticalOffset).toBeLessThanOrEqual(1);
            expect(card.horizontalOffset).toBeLessThanOrEqual(1);
          }
          expect(
            yield* browser.use("No horizontal overflow", (page) =>
              page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            ),
          ).toBe(true);
          if (viewport.width === 390) {
            for (const region of [
              "App tools preview",
              "App skills preview",
              "App workflows preview",
            ]) {
              yield* browser.use(`Scroll to ${region}`, (page) =>
                page.getByRole("region", { name: region, exact: true }).scrollIntoViewIfNeeded(),
              );
              yield* browser.checkpoint(`390 centered ${region}`);
            }
          }
        }
        yield* browser.use("Owner sees the authoring action", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${deployed.id}?view=skills`),
        );
        yield* browser.use("Author can copy a skills prompt", (page) =>
          page.getByRole("button", { name: "Copy prompt", exact: true }).waitFor(),
        );
        yield* browser.login(actors.member);
        for (const tab of ["skills", "schedules"] as const) {
          yield* browser.use(`Member opens empty ${tab}`, (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${deployed.id}?view=${tab}`),
          );
          yield* browser.use("The member has accurate guidance", (page) =>
            page
              .getByText(
                tab === "skills"
                  ? "The app owner can add skills for its common tasks."
                  : "The app owner can add schedules to run tasks automatically.",
                { exact: true },
              )
              .waitFor(),
          );
          expect(
            yield* browser.use("Restricted authoring actions stay visible and disabled", (page) =>
              (tab === "skills"
                ? page.getByRole("button", { name: "Copy prompt", exact: true })
                : page.getByRole("link", { name: "Open source", exact: true })
              ).isDisabled(),
            ),
          ).toBe(true);
          yield* browser.checkpoint(`Member empty ${tab}`);
        }
      }),
    ),
  );

  it.effect(scenarios.emptyAccountSearch.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Account search ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, object, secrets, string } from "apps";
const service = defineProvider({ name: "Search accounts", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { primary: service, many: service.many() } }, async () => ({ queries: {} }));`,
              },
            ],
          }),
        );
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${deployed.id}`);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const profile = yield* createProfile(actors.owner, `${prefix}/apps/${deployed.id}`);
        for (let index = 1; index <= 7; index++) {
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${deployed.id}/connections`, {
              requirement: "primary",
              profile: profile.id,
            }),
          );
          const saved = yield* body(
            Resource,
            yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              { method: "key", label: `Account ${index}`, fields: { token: "synthetic-only" } },
            ),
          );
          accounts.push(saved.id);
        }
        yield* browser.login(actors.owner);
        yield* browser.use("Use dark theme", (page) => page.emulateMedia({ colorScheme: "dark" }));
        yield* browser.use("Open multiple-account selection", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${deployed.id}?view=accounts`),
        );
        yield* browser.use("Open saved accounts", (page) =>
          page
            .getByRole("region", { name: "Search accounts (many)", exact: true })
            .getByRole("button", { name: "Add Search accounts account", exact: true })
            .click(),
        );
        yield* browser.use("Keep an unsaved account choice", (page) =>
          page.getByRole("checkbox", { name: /Account 1/ }).check(),
        );
        for (const viewport of [
          { width: 1440, height: 960 },
          { width: 390, height: 844 },
        ]) {
          yield* browser.use("Set account-picker viewport", (page) =>
            page.setViewportSize(viewport),
          );
          yield* browser.use("Search without a match", (page) =>
            page.getByLabel("Search saved accounts", { exact: true }).fill("does-not-exist"),
          );
          yield* browser.use("No matching accounts is explicit", (page) =>
            page.getByRole("heading", { name: "No matching accounts", exact: true }).waitFor(),
          );
          yield* browser.checkpoint(`${viewport.width} unmatched saved-account search`);
          yield* browser.use("Clear the search", (page) =>
            page.getByRole("button", { name: "Clear search", exact: true }).click(),
          );
          expect(
            yield* browser.use("The unsaved selection survives filtering", (page) =>
              page.getByRole("checkbox", { name: /Account 1/ }).isChecked(),
            ),
          ).toBe(true);
        }
      }),
    ),
  );
});
