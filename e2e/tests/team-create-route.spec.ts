import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { holdOrganizationEntry } from "../support/organization-entry.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Team setup routing", (it) => {
  it.effect(scenarios.teamCreateRoute.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
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
                yield* browser.use("Open entry without organization history", (page) =>
                  page.goto(path),
                );
                if (path === "/") {
                  yield* list.requested;
                  yield* browser.use("Entry shows neutral membership loading", (page) =>
                    page
                      .getByRole("status", { name: "Loading organizations", exact: true })
                      .waitFor({ state: "visible" }),
                  );
                  expect(
                    yield* browser.use("No dashboard appears before membership resolves", (page) =>
                      page.locator(".shell").count(),
                    ),
                  ).toBe(0);
                  yield* browser.checkpoint(`${viewport.width}px ${path}: membership pending`);
                  yield* list.release;
                } else {
                  yield* browser.use(
                    "The server redirects setup before loading its document",
                    (page) => page.waitForURL(`**/org/${actors.organization.slug}/apps`),
                  );
                  yield* list.release;
                }
                yield* browser.use("Confirmed membership opens its own Apps route", (page) =>
                  page.waitForURL(`**/org/${actors.organization.slug}/apps`),
                );
                expect(
                  yield* browser.use(
                    "Existing members are not asked to create another team",
                    (page) =>
                      page.getByRole("heading", { name: "Create your team", exact: true }).count(),
                  ),
                ).toBe(0);
                yield* browser.checkpoint(`${viewport.width}px ${path}: existing team selected`);
              }),
            );
          }
        }
      }),
    ),
  );
});
