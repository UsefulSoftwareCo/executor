import { openInApp, openThroughBrowser } from "../support/in-app-navigation.ts";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { holdQuery, refreshVisiblePage } from "../support/query-transition.ts";
import { freeSeat } from "../support/seats.ts";
import type { Route } from "playwright";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

layer(HostedLive, { excludeTestServices: true })("Dashboard refresh", (it) => {
  it.effect(scenarios.membersRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        yield* freeSeat;
        yield* browser.login(actors.owner);
        yield* browser.use("Open organization settings", (page) =>
          page.goto(`/org/${actors.organization.slug}/organization`),
        );
        yield* browser.use("The membership list has loaded", (page) =>
          page.getByRole("table", { name: "Members", exact: true }).waitFor({ state: "visible" }),
        );
        const rowCount = yield* browser.use("Record the existing members", (page) =>
          page.locator(".membership-table tbody tr").count(),
        );
        expect(rowCount).toBeGreaterThan(0);
        yield* browser.use("Open an invitation draft", (page) =>
          page.getByRole("button", { name: "Add member", exact: true }).click(),
        );
        const draft = "unsaved@example.test";
        yield* browser.use("Edit the invitation without sending it", (page) =>
          page.getByRole("textbox", { name: "Email", exact: true }).fill(draft),
        );
        const checkContent = (phase: string) =>
          Effect.gen(function* () {
            expect(
              yield* browser.use(`${phase}: member rows remain`, (page) =>
                page.locator(".membership-table tbody tr").count(),
              ),
            ).toBe(rowCount);
            expect(
              yield* browser.use(`${phase}: the invitation draft remains`, (page) =>
                page.getByRole("textbox", { name: "Email", exact: true }).inputValue(),
              ),
            ).toBe(draft);
          });
        const paths = ["/api/auth/organization/list-members"];
        const failed = yield* holdQuery(paths, "fail");
        // The same focus refresh re-reads organization access. Its unchanged answer must not
        // restart the held member read and hide that read's failure.
        const accessPath = `/api/organizations/${actors.organization.id}/access`;
        // The dashboard batches reads that start together. A read a test route matches leaves the
        // batch as the page's own request, so routing the access read lets its response be seen.
        const isAccess = (url: URL) => url.pathname === accessPath;
        const passAccess = (route: Route) => route.fallback();
        const access = yield* Effect.acquireRelease(
          browser.use("Watch the organization access refresh", (page) =>
            page.route(isAccess, passAccess).then(() => ({
              read: page.waitForResponse(
                (response) => isAccess(new URL(response.url())) && response.ok(),
              ),
            })),
          ),
          () =>
            browser
              .use("Stop watching the organization access refresh", (page) =>
                page.unroute(isAccess, passAccess),
              )
              .pipe(Effect.orDie),
        );
        yield* refreshVisiblePage;
        yield* failed.requested;
        yield* browser.use("Organization access is re-read", () => access.read);
        yield* checkContent("Waiting member refresh");
        yield* failed.release;
        yield* browser.use("The member read error is visible", (page) =>
          page
            .locator("[role=alert]")
            .filter({ hasText: "Members unavailable" })
            .waitFor({ state: "visible" }),
        );
        yield* checkContent("Failed member refresh");
        yield* browser.checkpoint("Invitation and members survive the read failure");
        const recovery = yield* holdQuery(paths, "continue");
        yield* refreshVisiblePage;
        yield* recovery.requested;
        yield* checkContent("Retrying member refresh");
        yield* recovery.release;
        yield* browser.use("The member read error clears", (page) =>
          page
            .locator("[role=alert]")
            .filter({ hasText: "Members unavailable" })
            .waitFor({ state: "hidden" }),
        );
        yield* checkContent("Recovered member refresh");
        yield* browser.checkpoint("Invitation and members survive recovery");
      }),
    ),
  );

  it.effect(scenarios.queryRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Refresh ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `
import { defineApp, mutation, object, string, router } from "apps";
export default defineApp({ accounts: {} }, async () => ({
  tools: router({
    echo: mutation({ description: "Echo text", input: object({ text: string() }) },
    async (_, input) => input.text),
  })
}));
`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        const paths = [actors.organization.slug, actors.organization.id].map(
          (reference) => `/api/organizations/${reference}/apps/${app.id}`,
        );
        yield* browser.login(actors.owner);
        const first = yield* holdQuery(paths, "undeclared");
        yield* openThroughBrowser(
          "Open the app with its first read held",
          `/org/${actors.organization.slug}/apps/${app.id}?view=settings`,
        );
        yield* first.requested;
        yield* browser.use("Initial data has a content skeleton", (page) =>
          page
            .getByRole("status", { name: "Loading settings", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* first.release;
        yield* browser.use("Initial failure shows a retry", (page) =>
          page.getByRole("button", { name: "Retry", exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.use("An initial error has no skeleton", (page) =>
          page
            .getByRole("status", { name: "Loading settings", exact: true })
            .waitFor({ state: "hidden" }),
        );
        yield* browser.use("Retry the initial read", (page) =>
          page.getByRole("button", { name: "Retry", exact: true }).click(),
        );
        yield* browser.use("Open Rename after app data and permissions arrive", (page) =>
          page.getByRole("button", { name: "Rename", exact: true }).click(),
        );
        const draft = "An unsaved app name";
        yield* browser.use("Enter an unsaved name", (page) =>
          page.getByRole("textbox", { name: "App name", exact: true }).fill(draft),
        );
        const checkDraft = (phase: string) =>
          Effect.gen(function* () {
            expect(
              yield* browser.use(`${phase}: the draft remains`, (page) =>
                page.getByRole("textbox", { name: "App name", exact: true }).inputValue(),
              ),
            ).toBe(draft);
            yield* browser.use(`${phase}: no loading replacement`, (page) =>
              page
                .getByRole("status", { name: "Loading settings", exact: true })
                .waitFor({ state: "hidden" }),
            );
          });
        const failedRefresh = yield* holdQuery(paths, "undeclared");
        yield* refreshVisiblePage;
        const refreshPath = yield* failedRefresh.requested;
        expect(paths).toContain(refreshPath);
        yield* checkDraft("Waiting refresh");
        yield* browser.checkpoint("Rename draft during a held refresh");
        yield* failedRefresh.release;
        yield* browser.use("The failed refresh is visible beside existing content", (page) =>
          page
            .getByText("Unable to complete this request", { exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* checkDraft("Failed refresh");
        yield* browser.checkpoint("Rename draft survives a refresh error");
        const recovery = yield* holdQuery(paths, "continue");
        yield* refreshVisiblePage;
        yield* recovery.requested;
        yield* checkDraft("Recovery waiting");
        yield* recovery.release;
        yield* browser.use("A successful read clears the error", (page) =>
          page
            .getByText("Unable to complete this request", { exact: true })
            .waitFor({ state: "hidden" }),
        );
        yield* checkDraft("Recovered refresh");
        yield* browser.checkpoint("Rename draft survives recovery");
        yield* evidence.json("query-refresh.json", { paths, refreshPath, draftPreserved: true });
      }),
    ),
  );
  it.effect(scenarios.retainedReturn.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const name = `Retained ${randomUUID().slice(0, 8)}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files: [
            {
              path: "index.ts",
              content: `
import { defineApp, query, router } from "apps";
export default defineApp({ accounts: {} }, async () => ({
  tools: router({ ping: query({ description: "Ping" }, async () => "pong") })
}));
`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        // Reads may use the URL slug or the verified organization ID.
        const directory = /^\/api\/organizations\/[^/]+\/resources$/;
        let directoryReads = 0;
        yield* browser.login(actors.owner);
        yield* browser.use("Control the browser clock and count directory reads", (page) =>
          page.clock.install().then(() =>
            page.on("request", (request) => {
              if (request.method() === "GET" && directory.test(new URL(request.url()).pathname))
                directoryReads += 1;
            }),
          ),
        );
        const list = `/org/${actors.organization.slug}/apps`;
        const detail = `/org/${actors.organization.slug}/apps/${app.id}?view=settings`;
        const appCard = (label: string) =>
          browser.use(label, (page) =>
            page.getByText(name, { exact: true }).first().waitFor({ state: "visible" }),
          );
        // An app still installing has its own card skeleton; the list's loading state is this one.
        const listLoading = (label: string) =>
          browser.use(label, (page) =>
            page.getByRole("status", { name: "Loading apps", exact: true }).count(),
          );
        const openDetail = Effect.gen(function* () {
          yield* openInApp("Open the app", detail);
          yield* browser.use("The app page has loaded", (page) =>
            page.getByRole("button", { name: "Rename", exact: true }).waitFor({ state: "visible" }),
          );
        });

        yield* openThroughBrowser("Open the apps list", list);
        yield* appCard("The list shows the app");

        yield* openDetail;
        // Long enough for the list's views to close, within the retained value's freshness.
        yield* browser.use("Leave the list for a few seconds", (page) => page.clock.runFor(5_000));
        const before = directoryReads;

        yield* openInApp("Return to the apps list", list);
        yield* appCard("The retained list is shown at once");
        expect(directoryReads, "A fresh retained list is not read again").toBe(before);
        expect(yield* listLoading("A fresh retained list")).toBe(0);
        yield* browser.checkpoint("Apps list on a quick return");

        yield* openDetail;
        yield* browser.use("Leave the list until its value is stale", (page) =>
          page.clock.runFor(31_000),
        );
        const refresh = yield* holdQuery(directory, "continue");
        yield* openInApp("Return to the apps list with its refresh held", list);
        yield* refresh.requested;
        yield* appCard("The stale list stays visible while it refreshes");
        expect(yield* listLoading("A list refreshing in the background")).toBe(0);
        yield* browser.checkpoint("Apps list while a background refresh is held");
        yield* refresh.release;
        yield* appCard("The refreshed list shows the app");
        yield* evidence.json("retained-return.json", { directoryReads });
      }),
    ),
  );
});
