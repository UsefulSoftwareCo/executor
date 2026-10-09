import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Billing empty state", (it) => {
  it.effect(scenarios.emptyStateBilling.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser;
        yield* browser.login(actors.owner);
        yield* browser.use("Use dark theme", (page) => page.emulateMedia({ colorScheme: "dark" }));
        // A full page load renders billing on the server from the stage's real catalog, and the
        // settings page reads it too. Load a page that does not read billing and navigate in the
        // browser, so the browser makes the first read and this route answers it.
        yield* browser.use("Open apps", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        let reads = 0;
        yield* browser.use("Provide an empty billing catalog at the HTTP boundary", (page) =>
          page.route("**/api/organizations/*/billing", (route) => {
            reads++;
            return route.fulfill({
              json: { enterprise: false, usage: null, plans: [], subscriptions: [] },
            });
          }),
        );
        yield* browser.use("Open organization settings", (page) =>
          page.getByRole("link", { name: "Settings", exact: true }).click(),
        );
        yield* browser.use("Open billing", (page) =>
          page.getByRole("link", { name: "Open billing", exact: true }).click(),
        );
        for (const viewport of [
          { width: 1440, height: 960 },
          { width: 390, height: 844 },
        ]) {
          yield* browser.use("Set billing viewport", (page) => page.setViewportSize(viewport));
          yield* browser.use("No plans has an explicit state", (page) =>
            page.getByRole("heading", { name: "Plans unavailable", exact: true }).waitFor(),
          );
          yield* browser.checkpoint(`${viewport.width} empty billing catalog`);
        }
        const before = reads;
        yield* browser.use("Refresh plans", (page) =>
          Promise.all([
            page.waitForResponse((response) =>
              new URL(response.url()).pathname.endsWith("/billing"),
            ),
            page.getByRole("button", { name: "Refresh plans", exact: true }).click(),
          ]),
        );
        yield* Effect.sync(() => expect(reads).toBeGreaterThan(before));
      }),
    ),
  );
});
