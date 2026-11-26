import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Organization } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { Onboarding } from "../support/onboarding.ts";
import {
  holdOrganizationEntry,
  trackEntryNavigations,
  trackOrganizationResources,
  waitForLastOrganization,
} from "../support/organization-entry.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Root entry loading", (it) => {
  it.effect(scenarios.rootEntryLoading.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const evidence = yield* Evidence;
        const onboarding = yield* Onboarding;
        const organizations = yield* body(
          Schema.Array(Organization),
          yield* api.request(actors.owner, "GET", "/api/auth/organization/list"),
        );
        expect(organizations).toEqual([actors.organization]);
        yield* browser.login(actors.owner);
        yield* browser.use("Match the reported dark appearance", (page) =>
          page.emulateMedia({ colorScheme: "dark" }),
        );
        yield* browser.use("Use the reference image's logical viewport", (page) =>
          page.setViewportSize({ width: 864, height: 720 }),
        );
        yield* browser.use("Open the existing organization and populate the session hint", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("The signed-in user already has an Apps page", (page) =>
          page.getByRole("heading", { name: /^Apps(?:\s*\d+)?$/ }).waitFor({ state: "visible" }),
        );
        yield* waitForLastOrganization(actors.organization.id);

        const preparation = yield* onboarding.delayPreparation;
        const loaded = Effect.gen(function* () {
          yield* browser.use("The existing organization opens", (page) =>
            page.waitForURL(`**/org/${actors.organization.slug}/apps`),
          );
          yield* browser.use("The existing apps finish loading", (page) =>
            page.locator(".app-card").first().waitFor({ state: "visible" }),
          );
          expect(yield* preparation.wasRequested).toBe(false);
          expect(
            yield* browser.use("No first-team preparation gate", (page) =>
              page.getByRole("status", { name: "Preparing your team", exact: true }).count(),
            ),
          ).toBe(0);
        });
        yield* browser.use("Open the root URL without an organization in the path", (page) =>
          page.goto("/"),
        );
        yield* loaded;
        yield* browser.checkpoint("Existing organization opens without team preparation");

        const destination = `/org/${actors.organization.slug}/apps`;
        const restored = yield* Effect.forEach(
          [
            { name: "Desktop", width: 864, height: 720 },
            { name: "Mobile", width: 390, height: 844 },
          ],
          (viewport) =>
            Effect.scoped(
              Effect.gen(function* () {
                yield* browser.use(`${viewport.name}: set the viewport`, (page) =>
                  page.setViewportSize({ width: viewport.width, height: viewport.height }),
                );
                const list = yield* holdOrganizationEntry;
                const resources = yield* trackOrganizationResources;
                const paths = yield* trackEntryNavigations;
                const entry = yield* browser.use(
                  `${viewport.name}: request the bare root`,
                  (page) =>
                    page
                      .context()
                      .request.get("/", { maxRedirects: 0, headers: { accept: "text/html" } }),
                );
                expect(entry.status()).toBeGreaterThanOrEqual(300);
                expect(entry.status()).toBeLessThan(400);
                expect(
                  new URL(entry.headers()["location"] ?? "", "http://entry.invalid").pathname,
                ).toBe(destination);
                yield* browser.use(
                  `${viewport.name}: reopen root with organization reads held`,
                  (page) => page.goto("/"),
                );
                yield* browser.use(
                  "The remembered organization opens at its canonical address",
                  (page) => page.waitForURL(`**${destination}`, { timeout: 10_000 }),
                );
                yield* browser.use("Apps load while organization reads are held", (page) =>
                  page.locator(".app-card").first().waitFor({ state: "visible" }),
                );
                expect(
                  yield* browser.use("No entry card or chooser interrupts restoration", (page) =>
                    page
                      .getByRole("heading", { name: /^(Opening Executor|Choose an organization)$/ })
                      .count(),
                  ),
                ).toBe(0);
                yield* browser.use("Type a search in the restored page", (page) =>
                  page.getByPlaceholder("Search apps…", { exact: true }).fill("Executor"),
                );
                yield* browser.checkpoint(
                  `${viewport.name}: Apps usable while organization reads are held`,
                );
                yield* loaded;
                expect(
                  yield* browser.use("The restored page keeps the search draft", (page) =>
                    page.getByPlaceholder("Search apps…", { exact: true }).inputValue(),
                  ),
                ).toBe("Executor");
                expect(new Set(paths)).toEqual(new Set([destination]));
                expect(resources).toEqual([]);
                expect(yield* list.wasRequested).toBe(false);
                yield* browser.checkpoint(`${viewport.name}: canonical URL without a second load`);
                yield* list.release;
                return {
                  viewport: viewport.name,
                  paths: [...new Set(paths)],
                  resources: [...resources],
                };
              }),
            ),
        );

        const fresh = [];
        for (const viewport of [
          { name: "Desktop", width: 864, height: 720 },
          { name: "Mobile", width: 390, height: 844 },
        ]) {
          fresh.push(
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* browser.use("Leave the previous document", (page) =>
                  page.goto("about:blank"),
                );
                yield* browser.login(actors.owner);
                yield* browser.use(`${viewport.name}: set the viewport`, (page) =>
                  page.setViewportSize({ width: viewport.width, height: viewport.height }),
                );
                const list = yield* holdOrganizationEntry;
                yield* browser.use("A fresh session has no remembered organization", (page) =>
                  page.goto("/"),
                );
                yield* loaded;
                expect(yield* list.wasRequested).toBe(false);
                yield* browser.checkpoint(
                  `${viewport.name}: fresh session resolves its first destination`,
                );
                yield* list.release;
                return { viewport: viewport.name, organizationListRequested: false };
              }),
            ),
          );
        }

        yield* evidence.json("root-entry-result.json", {
          entryPath: "/",
          existingOrganizations: organizations.length,
          preparationRequested: false,
          rememberedDestinationRedirectsBeforeHtml: true,
          canonicalAddressWithoutReplacementKeepsDraft: true,
          restored,
          fresh,
          heldRequests: ["/api/auth/organization/list", "/api/onboarding/prepare"],
          browserOrganizationListRequests: 0,
          responseReplaced: false,
          colorScheme: "dark",
          timing: "Controlled request holds and capture pacing, not a latency benchmark",
        });
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );
});
