/** The modal renders precise server-owned readiness without offering another app's controls. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { App } from "../support/contracts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { publishingPreview } from "../support/publishing-preview.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Publishing dialog", (it) => {
  it.effect(scenarios.publishingDialog.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Publishing example ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content:
                'import {defineApp} from "apps"; export default defineApp({accounts:{}},{});',
            },
            { path: "package.json", content: '{"name":"axiom"}' },
          ],
        });
        expect(response.status).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)
            .pipe(Effect.asVoid, Effect.orDie),
        );
        yield* browser.login(actors.owner);
        const suggestedName = `@${actors.organization.slug}/axiom`;
        for (const fixture of [
          { reason: "unscoped-name", name: "axiom", title: "Add your publishing handle" },
          { reason: "missing-name", name: null, title: "Add a package name" },
          { reason: "invalid-json", name: null, title: "Fix package.json" },
          { reason: "invalid-name", name: "@bad/Invalid Name", title: "Use a valid public name" },
          {
            reason: "forbidden-scope",
            name: "@original/axiom",
            title: "Use your own publishing handle",
          },
          { reason: "name-taken", name: suggestedName, title: "Choose a different public name" },
        ] as const) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* publishingPreview(
                app.id,
                {
                  status: "blocked",
                  issue: { _tag: "PublicationIssue", reason: fixture.reason, name: fixture.name },
                  suggestedName:
                    fixture.reason === "name-taken" ? `${suggestedName}-copy` : suggestedName,
                },
                [
                  {
                    name: suggestedName,
                    commit: "a".repeat(40),
                    description: "Another app",
                    publishedAt: "2026-01-01T00:00:00.000Z",
                  },
                ],
              );
              const sourceHold = yield* holdQuery(
                [actors.organization.id, actors.organization.slug].map(
                  (organization) => `/api/organizations/${organization}/apps/${app.id}/workspace`,
                ),
                "continue",
                { allRequests: true },
              );
              yield* browser.use("Open the app with this publishing result", (page) =>
                page.goto(`/org/${actors.organization.slug}/apps/${app.id}`),
              );
              yield* browser.use("Publish is available without loading source files", (page) =>
                page.getByRole("button", { name: "Publish", exact: true }).waitFor(),
              );
              yield* browser.use("Source navigation is available", (page) =>
                page
                  .getByRole("navigation", { name: "App navigation" })
                  .getByRole("link", { name: "Source", exact: true })
                  .waitFor(),
              );
              yield* browser.use("Open Publish", (page) =>
                page.getByRole("button", { name: "Publish", exact: true }).click(),
              );
              yield* sourceHold.requested;
              yield* browser.use("The dialog owns the source wait", (page) =>
                page.getByRole("dialog").getByLabel("Loading publication details").waitFor(),
              );
              yield* sourceHold.release;
              yield* browser.use("Explain the exact problem", (page) =>
                page.getByRole("alert").getByText(fixture.title, { exact: true }).waitFor(),
              );
              expect(
                yield* browser.use("No publish action for blocked source", (page) =>
                  page.getByRole("button", { name: "Publish app", exact: true }).count(),
                ),
              ).toBe(0);
              expect(
                yield* browser.use("No other app's unpublish action", (page) =>
                  page.getByRole("button", { name: "Unpublish", exact: true }).count(),
                ),
              ).toBe(0);
              if (fixture.reason === "unscoped-name") {
                yield* browser.use("Show the complete name to use", (page) =>
                  page.getByRole("dialog").getByText(suggestedName, { exact: true }).waitFor(),
                );
                yield* browser.checkpoint("Unscoped package has a precise repair");
                yield* browser.use("Check the modal on a phone", (page) =>
                  page.setViewportSize({ width: 390, height: 844 }),
                );
                yield* browser.checkpoint("Publishing repair on mobile");
                expect(
                  yield* browser.use("Phone modal stays within the viewport", (page) =>
                    page.getByRole("dialog").evaluate((element) => {
                      const bounds = element.getBoundingClientRect();
                      return bounds.x >= 0 && bounds.right <= window.innerWidth;
                    }),
                  ),
                ).toBe(true);
                yield* browser.use("Restore desktop viewport", (page) =>
                  page.setViewportSize({ width: 1440, height: 960 }),
                );
              }
              yield* browser.use("Close the repair message", (page) =>
                page.getByRole("button", { name: "Done", exact: true }).click(),
              );
            }),
          );
        }
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* publishingPreview(app.id, {
              status: "ready",
              manifest: { name: suggestedName, description: "A ready app" },
            });
            yield* browser.use("Open the ready app", (page) =>
              page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=source`),
            );
            yield* browser.use("Preview publication", (page) =>
              page.getByRole("button", { name: "Publish", exact: true }).click(),
            );
            yield* browser.use("The ready package can be published", (page) =>
              page.getByRole("button", { name: "Publish app", exact: true }).waitFor(),
            );
            yield* browser.checkpoint("Ready package shows its exact public name");
            yield* browser.use("Close without publishing", (page) =>
              page.getByRole("button", { name: "Cancel", exact: true }).click(),
            );
          }),
        );
      }),
    ),
  );
});
