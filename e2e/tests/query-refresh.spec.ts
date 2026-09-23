import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { holdQuery, refreshVisiblePage } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Dashboard refresh", (it) => {
  it.effect(scenarios.membersRefresh.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
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
        yield* refreshVisiblePage;
        yield* failed.requested;
        yield* checkContent("Waiting member refresh");
        yield* failed.release;
        yield* browser.use("The member read error is visible", (page) =>
          page.locator(".membership-empty [role=alert]").waitFor({ state: "visible" }),
        );
        yield* checkContent("Failed member refresh");
        yield* browser.checkpoint("Invitation and members survive the read failure");
        const recovery = yield* holdQuery(paths, "continue");
        yield* refreshVisiblePage;
        yield* recovery.requested;
        yield* checkContent("Retrying member refresh");
        yield* recovery.release;
        yield* browser.use("The member read error clears", (page) =>
          page.locator(".membership-empty [role=alert]").waitFor({ state: "hidden" }),
        );
        yield* checkContent("Recovered member refresh");
        yield* browser.checkpoint("Invitation and members survive recovery");
      }),
    ),
  );

  it.effect(scenarios.queryRefresh.title, (context) =>
    withCase(
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
import { defineApp, mutation, object, string } from "apps";
export default defineApp({ accounts: {} }, async () => ({
  mutations: { echo: mutation({ description: "Echo text", input: object({ text: string() }) },
    async (_, input) => input.text) }
}));
`,
            },
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
        const first = yield* holdQuery(paths, "fail");
        yield* browser.use("Open the app with its first read held", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=settings`),
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
        const failedRefresh = yield* holdQuery(paths, "fail");
        yield* refreshVisiblePage;
        const refreshPath = yield* failedRefresh.requested;
        expect(refreshPath).toBe(`${prefix}/apps/${app.id}`);
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
});
