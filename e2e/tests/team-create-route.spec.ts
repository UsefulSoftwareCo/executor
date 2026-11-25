import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { holdOrganizationEntry, trackEntryNavigations } from "../support/organization-entry.ts";
import { scenarios } from "../test-plan.ts";

const navigation = { accept: "text/html" };

layer(HostedLive, { excludeTestServices: true })("Team setup routing", (it) => {
  it.effect(scenarios.teamCreateRoute.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        const destination = `/org/${actors.organization.slug}/apps`;
        for (const viewport of [
          { width: 864, height: 720 },
          { width: 390, height: 844 },
        ]) {
          for (const path of ["/", "/create"]) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* browser.use("Leave the previous document", (page) =>
                  page.goto("about:blank"),
                );
                if (path === "/") yield* browser.login(actors.owner);
                yield* browser.use("Set the entry viewport", (page) =>
                  page.setViewportSize(viewport),
                );
                const list = yield* holdOrganizationEntry;
                const paths = yield* trackEntryNavigations;
                const document = yield* browser.use(
                  "Request entry without organization history",
                  (page) =>
                    page
                      .context()
                      .request.get(path, { maxRedirects: 0, headers: navigation })
                      .then((response) =>
                        response.text().then((html) => ({
                          status: response.status(),
                          location: response.headers()["location"],
                          html,
                        })),
                      ),
                );
                if (path === "/") {
                  expect(document.status).toBe(200);
                  expect(document.html).not.toMatch(/class="shell[\s"]/);
                  expect(document.html).not.toContain("Create your team");
                } else {
                  expect(document.status).toBe(302);
                  expect(document.location).toBe(destination);
                }
                yield* browser.use("Open entry without organization history", (page) =>
                  page.goto(path),
                );
                yield* browser.use("Confirmed membership opens its own Apps route", (page) =>
                  page.waitForURL(`**${destination}`),
                );
                yield* browser.use("The existing organization's Apps page is usable", (page) =>
                  page
                    .getByRole("heading", { name: /^Apps(?:\s*\d+)?$/ })
                    .waitFor({ state: "visible" }),
                );
                expect(
                  yield* browser.use(
                    "Existing members are not asked to create another team",
                    (page) =>
                      page.getByRole("heading", { name: "Create your team", exact: true }).count(),
                  ),
                ).toBe(0);
                expect(yield* list.wasRequested).toBe(false);
                if (path === "/create") expect(paths).not.toContain("/create");
                yield* browser.checkpoint(`${viewport.width}px ${path}: existing team selected`);
                yield* list.release;
              }),
            );
          }
        }
      }),
    ),
  );
});
