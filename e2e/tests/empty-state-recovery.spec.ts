import { linkedAccountIds } from "../support/app-accounts.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const source = `import { defineApp, router } from "apps";
export default defineApp({}, async () => ({ tools: router({}) }));`;

layer(HostedLive, { excludeTestServices: true })("Empty state recovery", (it) => {
  it.effect(scenarios.emptyStateRecovery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const undeployed = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps`, {
            name: `Empty app ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${undeployed.id}`).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Use dark theme", (page) => page.emulateMedia({ colorScheme: "dark" }));
        for (const viewport of [
          { width: 1440, height: 960 },
          { width: 390, height: 844 },
        ]) {
          yield* browser.use("Set undeployed app viewport", (page) =>
            page.setViewportSize(viewport),
          );
          yield* browser.use("Open undeployed app overview", (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${undeployed.id}`),
          );
          yield* browser.use("Undeployed app has a direct source action", (page) =>
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
            yield* browser.use("Undeployed app source is visible without scrolling", (page) =>
              page
                .getByRole("region", { name: "App source", exact: true })
                .evaluate((element) => element.getBoundingClientRect().top < window.innerHeight),
            ),
          ).toBe(true);
          yield* browser.checkpoint(`${viewport.width} undeployed overview`);
          yield* browser.use("Open undeployed app schedules", (page) =>
            page
              .getByRole("navigation", { name: "App navigation" })
              .getByRole("link", { name: "Schedules", exact: true })
              .click(),
          );
          yield* browser.use("Schedules explains the missing deployment", (page) =>
            page.getByRole("heading", { name: "No deployment yet", exact: true }).waitFor(),
          );
          expect(
            yield* browser.use("No useless retry for an undeployed app", (page) =>
              page.getByRole("button", { name: "Retry", exact: true }).count(),
            ),
          ).toBe(0);
          yield* browser.use(
            "Undeployed app schedules offer source after access resolves",
            (page) => page.getByRole("link", { name: "Open source", exact: true }).waitFor(),
          );
          yield* browser.use("The undeployed app header has finished loading", (page) =>
            page.locator("[data-slot=skeleton]").first().waitFor({ state: "hidden" }),
          );
          yield* browser.checkpoint(`${viewport.width} undeployed schedules`);
        }
        yield* browser.use("Open sharing without groups", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${undeployed.id}?view=settings`),
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
            files: [{ path: "index.ts", content: source }, appsManifest],
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
        yield* browser.use("Author can start a skill from the empty state", (page) =>
          page
            .getByRole("heading", { name: "Give your app its first skill", exact: true })
            .locator("..")
            .getByRole("button", { name: "New skill", exact: true })
            .click()
            .then(() =>
              page
                .getByRole("dialog", { name: "New skill", exact: true })
                .getByLabel("Name", { exact: true })
                .fill("First skill"),
            ),
        );
        yield* browser.checkpoint("Owner can author a first skill directly");
        yield* browser.use("Cancel the skill draft without changing the empty app", (page) =>
          page
            .getByRole("dialog", { name: "New skill", exact: true })
            .getByRole("button", { name: "Cancel", exact: true })
            .click(),
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

  it.effect(scenarios.emptyAccountTools.title, (context) =>
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
            name: `Per-account tools ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { accountRouter, defineApp, defineProvider, object, router, secrets, string } from "apps";
const service = defineProvider({ name: "Per-account service", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service: service.many() } } }, async ({ user: { accounts }, signal }) => ({
  tools: await accountRouter(accounts.service, async () => router({}), { signal }),
}));`,
              },
              appsManifest,
            ],
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${deployed.id}`).pipe(Effect.orDie),
        );
        // A many-account requirement with no linked account is valid, so tool discovery runs
        // and the app lists nothing. The page must ask for an account rather than report no tools.
        const appPath = `${prefix}/apps/${deployed.id}`,
          url = `/org/${actors.organization.slug}/apps/${deployed.id}`;
        expect(yield* linkedAccountIds(actors.owner, appPath)).toEqual([]);
        yield* browser.login(actors.owner);
        yield* browser.use("Use dark theme", (page) => page.emulateMedia({ colorScheme: "dark" }));
        yield* browser.use("Open the tools of an app without linked accounts", (page) =>
          page.goto(`${url}?view=tools`),
        );
        yield* browser.use("Tools ask for an account", (page) =>
          page.getByRole("heading", { name: "No accounts linked", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Tools do not claim the app exposes nothing", (page) =>
            page.getByRole("heading", { name: "No tools", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Tools ask for an account");
        yield* browser.use("The account step is one click away", (page) =>
          page
            .locator(".tools-section")
            .getByRole("link", { name: "Accounts", exact: true })
            .click(),
        );
        yield* browser.use("Accounts opens for the same app", (page) =>
          page.waitForURL(
            (next) =>
              next.pathname === url &&
              next.searchParams.get("view") === "accounts" &&
              // The page made no account choice, so none is carried.
              (next.searchParams.get("accounts") ?? "{}") === "{}",
          ),
        );
        yield* browser.use("Open the overview of an app without linked accounts", (page) =>
          page.goto(url),
        );
        yield* browser.use("The overview tools card asks for an account", (page) =>
          page
            .getByRole("region", { name: "App tools preview", exact: true })
            .getByRole("heading", { name: "No accounts linked", exact: true })
            .waitFor(),
        );
        yield* browser.checkpoint("Overview tools ask for an account");
      }),
    ),
  );
});
