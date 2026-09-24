import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({ id: Schema.String });
const EvaluationFailure = Schema.Struct({
  _tag: Schema.Literal("AppEvaluationFailed"),
  reason: Schema.String,
});

layer(HostedLive, { excludeTestServices: true })("Tools errors", (it) => {
  it.effect(scenarios.toolsErrorState.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Sample tools",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp } from "apps";
export default defineApp({ accounts: {} }, async () => {
  throw new Error("PRIVATE_TOOL_DIAGNOSTIC");
});`,
            },
          ],
        });
        expect(response.status).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const failed = yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/tools`);
        expect(failed.status).toBe(502);
        expect((yield* body(EvaluationFailure, failed)).reason).not.toContain(
          "PRIVATE_TOOL_DIAGNOSTIC",
        );
        const paths = [actors.organization.id, actors.organization.slug].map(
          (organization) => `/api/organizations/${organization}/apps/${app.id}/tools`,
        );
        const pageUrl = `/org/${actors.organization.slug}/apps/${app.id}?view=tools`;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the failed Tools page in dark mode", (page) =>
          page.emulateMedia({ colorScheme: "dark" }).then(() => page.goto(pageUrl)),
        );
        const title = "Tools could not be loaded";
        yield* browser.use("The page explains the actual error category", (page) =>
          page.getByRole("alert", { name: title, exact: true }).waitFor(),
        );
        const copy = yield* browser.use("Read the complete error state", (page) =>
          page.getByRole("alert", { name: title, exact: true }).innerText(),
        );
        expect(copy).toContain("Executor could not load this app’s tool definitions.");
        expect(copy).toContain("AppEvaluationFailed");
        expect(copy).not.toContain("Check its accounts");
        expect(copy).not.toContain("PRIVATE_TOOL_DIAGNOSTIC");
        yield* browser.checkpoint("Tools-error-desktop");
        const prompt = yield* browser.use("Copy a safe, contextual repair prompt", (page) =>
          page
            .context()
            .grantPermissions(["clipboard-read", "clipboard-write"])
            .then(() => page.getByRole("button", { name: "Copy fix prompt", exact: true }).click())
            .then(() => page.evaluate(() => navigator.clipboard.readText())),
        );
        expect(prompt).toContain(app.id);
        expect(prompt).toContain("AppEvaluationFailed");
        expect(prompt).toContain("does not identify which cause occurred");
        expect(prompt).not.toContain("PRIVATE_TOOL_DIAGNOSTIC");

        const retry = yield* holdQuery(paths, "continue");
        yield* browser.use("Retry the failed discovery", (page) =>
          page.getByRole("button", { name: "Try again", exact: true }).click(),
        );
        yield* retry.requested;
        expect(
          yield* browser.use("Retry stays disabled while checking", (page) =>
            page.getByRole("button", { name: "Checking…", exact: true }).isDisabled(),
          ),
        ).toBe(true);
        expect(
          yield* browser.use("The error card stays mounted during retry", (page) =>
            page.getByRole("alert", { name: title, exact: true }).isVisible(),
          ),
        ).toBe(true);
        expect(
          yield* browser.use("Retry does not replace the error with a tool skeleton", (page) =>
            page.getByRole("status", { name: "Loading tools", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Tools-error-checking");
        yield* retry.release;
        yield* browser.use("The next attempt is available after another failure", (page) =>
          page.getByRole("button", { name: "Try again", exact: true }).waitFor(),
        );
        yield* browser.use("Inspect the error at mobile width", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.use("The error and its actions fit the mobile viewport", (page) =>
          page
            .getByRole("alert", { name: title, exact: true })
            .scrollIntoViewIfNeeded()
            .then(() => page.getByRole("alert", { name: title, exact: true }).boundingBox())
            .then((bounds) => {
              if (bounds === null) throw new Error("The Tools error card must be visible");
              expect(bounds.x).toBeGreaterThanOrEqual(0);
              expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
              expect(bounds.y).toBeGreaterThanOrEqual(0);
              expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
            }),
        );
        yield* browser.checkpoint("Tools-error-mobile");

        const repaired = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/deploy`,
          {
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, query, object } from "apps";
export default defineApp({ accounts: {} }, async () => ({
  queries: { status: query({ description: "Service status", input: object({}) }, async () => "ready") }
}));`,
              },
            ],
          },
        );
        expect(repaired.status).toBe(200);
        yield* browser.use("Return to desktop", (page) =>
          page.setViewportSize({ width: 1440, height: 960 }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const unavailable = yield* holdQuery(paths, "fail", { allRequests: true });
            yield* browser.use("Reopen Tools with a failed network read", (page) =>
              page.goto(pageUrl),
            );
            yield* unavailable.requested;
            yield* unavailable.release;
            yield* browser.use("Unclassified failures still have a safe recovery", (page) =>
              page.getByRole("alert", { name: "Action unavailable", exact: true }).waitFor(),
            );
          }),
        );
        const recovery = yield* holdQuery(paths, "continue");
        yield* browser.use("Retry the temporary failure", (page) =>
          page.getByRole("button", { name: "Try again", exact: true }).click(),
        );
        yield* recovery.requested;
        expect(
          yield* browser.use("Fallback card also survives retry", (page) =>
            page.getByRole("alert", { name: "Action unavailable", exact: true }).isVisible(),
          ),
        ).toBe(true);
        yield* recovery.release;
        yield* browser.use("The real tool catalog returns after retry", (page) =>
          page
            .getByRole("navigation", { name: "App tools", exact: true })
            .getByRole("button", { name: "queries.status", exact: true })
            .waitFor(),
        );
        yield* browser.use("The error clears after recovery", (page) =>
          page.getByRole("alert").waitFor({ state: "hidden" }),
        );
        yield* browser.checkpoint("Tools-error-recovered");
      }),
    ),
  );
});
