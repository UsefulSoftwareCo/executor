import { dashboardLoadingProbe } from "../support/dashboard-loading.ts";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Inventory } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
import { seedOrganization } from "../sdk/index.ts";

layer(HostedLive, { excludeTestServices: true })("Dashboard loading", (it) => {
  it.effect(scenarios.dashboardLoading.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser,
          evidence = yield* Evidence;
        yield* seedOrganization({ seed: 7, apps: 2, accounts: 4, records: 20 });
        const inventory = yield* body(
          Inventory,
          yield* api.request(
            actors.owner,
            "GET",
            `/api/organizations/${actors.organization.id}/inventory`,
          ),
        );
        expect(inventory.apps.length).toBeGreaterThan(0);
        expect(inventory.accounts.length).toBeGreaterThan(0);
        yield* browser.login(actors.owner);
        yield* browser.use("Confirm the session and save its display hint", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("The first session is confirmed", (page) =>
          page.getByRole("heading", { name: /^Apps(?:\s*\d+)?$/ }).waitFor({ state: "visible" }),
        );
        for (const viewport of [
          { name: "Desktop", width: 1280, height: 800 },
          { name: "Mobile", width: 390, height: 844 },
        ]) {
          for (const section of ["apps", "accounts"] as const) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const probe = yield* dashboardLoadingProbe;
                yield* browser.use(`${viewport.name}: set the viewport`, (page) =>
                  page.setViewportSize({ width: viewport.width, height: viewport.height }),
                );
                yield* browser.use(`Open ${section}`, (page) =>
                  page.goto(`/org/${actors.organization.slug}/${section}`),
                );
                yield* probe.resourcesRequested;
                yield* probe.sessionRequested;
                yield* browser.use("The destination heading is visible", (page) =>
                  page
                    .getByRole("heading", {
                      name: section === "apps" ? "Apps" : "Accounts",
                      exact: true,
                    })
                    .waitFor({ state: "visible" }),
                );
                yield* browser.use("Content has its own skeleton", (page) =>
                  page
                    .getByRole("status", { name: `Loading ${section}`, exact: true })
                    .waitFor({ state: "visible" }),
                );
                const requests = probe.requests;
                expect(requests).toContain(
                  `/api/organizations/${actors.organization.slug}/resources`,
                );
                expect(requests.some((path) => path.includes("passkey"))).toBe(false);
                expect(
                  yield* browser.use("The shell is already visible", (page) =>
                    page.locator(".shell").count(),
                  ),
                ).toBe(1);
                expect(
                  yield* browser.use("No full-page auth spinner", (page) =>
                    page.locator(".auth-pending").count(),
                  ),
                ).toBe(0);
                const before = yield* browser.use("Record the page heading position", (page) =>
                  page.getByRole("heading", { level: 1 }).boundingBox(),
                );
                yield* browser.checkpoint(
                  `${viewport.name} ${section}: content skeleton inside the shell`,
                );
                yield* probe.releaseContent;
                yield* browser.use("Content arrives while sidebar metadata is still held", (page) =>
                  page
                    .getByRole("status", { name: `Loading ${section}`, exact: true })
                    .waitFor({ state: "hidden" }),
                );
                yield* browser.use("The actual data is visible", (page) =>
                  page
                    .locator(section === "apps" ? ".app-card" : ".inventory-row")
                    .first()
                    .waitFor({ state: "visible" }),
                );
                expect(
                  yield* browser.use("Data has no full-page gate", (page) =>
                    page.locator(".auth-pending").count(),
                  ),
                ).toBe(0);
                yield* browser.checkpoint(
                  `${viewport.name} ${section}: data before sidebar metadata`,
                );
                yield* probe.releaseMetadata;
                yield* probe.releaseSession;
                // Phones show the sidebar's organization switcher only in the Menu sheet.
                if (viewport.width <= 740)
                  yield* browser.use("Open the phone menu", (page) =>
                    page.getByRole("button", { name: "Menu", exact: true }).click(),
                  );
                yield* browser.use(
                  "Sidebar metadata completes without replacing the page",
                  (page) =>
                    page
                      .getByRole("button", { name: /^Organization:/ })
                      .waitFor({ state: "visible" }),
                );
                if (viewport.width <= 740) {
                  yield* browser.use("Close the phone menu", (page) =>
                    page.keyboard.press("Escape"),
                  );
                  yield* browser.use("The phone menu closes", (page) =>
                    page.getByRole("dialog", { name: "Menu" }).waitFor({ state: "hidden" }),
                  );
                }
                yield* browser.use("Content stays loaded", (page) =>
                  page
                    .getByRole("status", { name: `Loading ${section}`, exact: true })
                    .waitFor({ state: "hidden" }),
                );
                const after = yield* browser.use("The page heading keeps its position", (page) =>
                  page.getByRole("heading", { level: 1 }).boundingBox(),
                );
                expect(before).not.toBeNull();
                expect(after).not.toBeNull();
                if (before === null || after === null)
                  throw new Error("Page heading has no visible bounds");
                expect(Math.abs(before.x - after.x)).toBeLessThanOrEqual(2);
                expect(Math.abs(before.y - after.y)).toBeLessThanOrEqual(2);
                yield* evidence.json(`${viewport.name.toLowerCase()}-${section}-layout.json`, {
                  before,
                  after,
                  requests,
                });
                yield* browser.checkpoint(`${viewport.name} ${section}: fully loaded`);
              }),
            );
          }
        }
      }),
    ),
  );
});
