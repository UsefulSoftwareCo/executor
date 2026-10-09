/** The modal renders precise server-owned readiness without offering another app's controls. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { App } from "../support/contracts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { publishingPreview } from "../support/publishing-preview.ts";
import { openThroughBrowser } from "../support/in-app-navigation.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";
import { withApps } from "../support/apps-release.ts";

const WorkingSource = Schema.Struct({
  revision: Schema.Struct({ commit: Schema.String }),
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});

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
            {
              path: "package.json",
              content: JSON.stringify({ name: "axiom", dependencies: withApps() }),
            },
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
        yield* browser.use("Allow clipboard access in the isolated browser", (page) =>
          page.context().grantPermissions(["clipboard-read", "clipboard-write"]),
        );
        const suggestedName = `@${actors.organization.slug}/axiom`;
        for (const fixture of [
          { reason: "unscoped-name", name: "axiom", title: "Add your publishing handle" },
          { reason: "missing-name", name: null, title: "Add a package name" },
          { reason: "invalid-json", name: null, title: "Fix package.json" },
          { reason: "invalid-name", name: "@bad/Invalid Name", title: "Use a valid public name" },
          {
            reason: "forbidden-scope",
            name: "@original/axiom",
            title: "This name uses another publishing handle",
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
                  (organization) =>
                    `/api/organizations/${organization}/apps/${app.id}/workspace/display`,
                ),
                "continue",
                { allRequests: true },
              );
              yield* openThroughBrowser(
                "Open the app with this publishing result",
                `/org/${actors.organization.slug}/apps/${app.id}`,
              );
              yield* browser.use("Publish is available without loading source files", (page) =>
                page.getByRole("button", { name: "Share publicly", exact: true }).waitFor(),
              );
              yield* browser.use("Source navigation is available", (page) =>
                page
                  .getByRole("navigation", { name: "App navigation" })
                  .getByRole("link", { name: "Source", exact: true })
                  .waitFor(),
              );
              yield* browser.use("Open Publish", (page) =>
                page.getByRole("button", { name: "Share publicly", exact: true }).click(),
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
                  page.getByRole("button", { name: "List publicly", exact: true }).count(),
                ),
              ).toBe(0);
              expect(
                yield* browser.use("No other app's unpublish action", (page) =>
                  page.getByRole("button", { name: "Stop sharing", exact: true }).count(),
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
              if (fixture.reason === "invalid-json")
                expect(
                  yield* browser.use("A name change cannot repair invalid JSON", (page) =>
                    page.getByRole("button", { name: "Rename and continue", exact: true }).count(),
                  ),
                ).toBe(0);
              else
                yield* browser.use("Offer the suggested rename", (page) =>
                  page
                    .getByRole("button", { name: "Rename and continue", exact: true })
                    .and(page.locator(":enabled"))
                    .waitFor(),
                );
              if (fixture.reason === "forbidden-scope" || fixture.reason === "invalid-json") {
                yield* browser.use("Copy the prompt for an agent", (page) =>
                  page.getByRole("button", { name: "Copy prompt for your agent" }).click(),
                );
                const prompt = yield* browser.use("Read the copied prompt", (page) =>
                  page.evaluate(() => navigator.clipboard.readText()),
                );
                expect(prompt).toContain(`The Executor app "${app.name}" (${app.id})`);
                expect(prompt).toContain(
                  fixture.reason === "invalid-json"
                    ? "Repair package.json so it is a valid JSON object"
                    : `Set "name" in package.json to "${suggestedName}"`,
                );
                expect(prompt).toContain("Don't deploy or publish the app.");
              }
              if (fixture.reason === "forbidden-scope") {
                yield* browser.use("Name both handles", (page) =>
                  page
                    .getByRole("alert")
                    .getByText(
                      `Apps from this organization are published under @${actors.organization.slug}. The name in package.json starts with @original, which this organization cannot publish under.`,
                      { exact: true },
                    )
                    .waitFor(),
                );
                yield* browser.checkpoint("Another handle names both handles and offers a rename");
              }
              yield* browser.use("Close the repair message", (page) =>
                page
                  .getByRole("button", {
                    name: fixture.reason === "invalid-json" ? "OK" : "Cancel",
                    exact: true,
                  })
                  .click(),
              );
            }),
          );
        }
        yield* Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* api.request(
              actors.owner,
              "GET",
              `${prefix}/apps/${app.id}/workspace`,
            );
            expect(opened.status).toBe(200);
            const initial = yield* body(WorkingSource, opened);
            yield* publishingPreview(app.id, (display) =>
              display.revision.commit === initial.revision.commit
                ? {
                    status: "blocked",
                    issue: { _tag: "PublicationIssue", reason: "unscoped-name", name: "axiom" },
                    suggestedName,
                  }
                : { status: "ready", manifest: { name: suggestedName } },
            );
            yield* openThroughBrowser(
              "Open the app whose package needs a handle",
              `/org/${actors.organization.slug}/apps/${app.id}`,
            );
            yield* browser.use("Open Publish for the saved package", (page) =>
              page.getByRole("button", { name: "Share publicly", exact: true }).click(),
            );
            const rename = browser.use("Rename from the dialog", (page) =>
              page
                .getByRole("button", { name: "Rename and continue", exact: true })
                .and(page.locator(":enabled"))
                .click(),
            );
            yield* browser.use("The dialog has loaded the source", (page) =>
              page
                .getByRole("button", { name: "Rename and continue", exact: true })
                .and(page.locator(":enabled"))
                .waitFor(),
            );
            // The rename reads the source before it commits. When that read fails, the dialog reports
            // it and keeps the loaded source, so renaming again recovers.
            const failedRead = yield* holdQuery(
              [actors.organization.id, actors.organization.slug].map(
                (organization) => `/api/organizations/${organization}/apps/${app.id}/workspace`,
              ),
              "undeclared",
            );
            yield* rename;
            yield* failedRead.requested;
            yield* failedRead.release;
            yield* browser.use("The failed read is reported in the dialog", (page) =>
              page
                .getByRole("dialog")
                .getByText("Unable to complete this request", { exact: true })
                .waitFor(),
            );
            yield* browser.checkpoint("Failed rename read can be retried");
            yield* rename;
            yield* browser.use("The dialog reviews the renamed package", (page) =>
              page.getByRole("button", { name: "List publicly", exact: true }).waitFor(),
            );
            yield* browser.use("The listing shows the new name", (page) =>
              page.getByRole("dialog").getByText(suggestedName, { exact: true }).waitFor(),
            );
            yield* browser.checkpoint("Renamed package is ready to publish");
            const saved = yield* body(
              WorkingSource,
              yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/workspace`),
            );
            expect(saved.revision.commit).not.toBe(initial.revision.commit);
            expect(
              Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
                saved.files.find((file) => file.path === "package.json")?.content,
              ),
            ).toEqual({ name: suggestedName, dependencies: withApps() });
            yield* browser.use("Leave the renamed package unpublished", (page) =>
              page.getByRole("button", { name: "Cancel", exact: true }).click(),
            );
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* publishingPreview(app.id, {
              status: "ready",
              manifest: { name: suggestedName, description: "A ready app" },
            });
            yield* openThroughBrowser(
              "Open the ready app",
              `/org/${actors.organization.slug}/apps/${app.id}?view=source`,
            );
            yield* browser.use("Preview publication", (page) =>
              page.getByRole("button", { name: "Share publicly", exact: true }).click(),
            );
            yield* browser.use("The ready package can be published", (page) =>
              page.getByRole("button", { name: "List publicly", exact: true }).waitFor(),
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
