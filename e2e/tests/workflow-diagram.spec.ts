import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { openThroughBrowser } from "../support/in-app-navigation.ts";
import { holdQuery } from "../support/query-transition.ts";
import { workflowDiagramFiles } from "../support/workflow-diagram.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Workflow diagrams", (it) => {
  it.effect(scenarios.workflowDiagram.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Diagram ${randomUUID().slice(0, 8)}`,
          files: workflowDiagramFiles,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(
          Schema.Struct({ ...App.fields, activeVersion: Schema.String }),
          deployed,
        );
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const url = `/org/${actors.organization.slug}/apps/${app.id}?view=workflows`;
        const diagram = (page: Parameters<Parameters<typeof browser.use>[1]>[0]) =>
          page.getByRole("group", { name: "Workflow diagram" });
        // A step's accessible name is its kind and then its name, as the card reads.
        const step = (page: Parameters<Parameters<typeof browser.use>[1]>[0], name: string) =>
          diagram(page).getByRole("button", {
            name: new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"),
          });
        const details = (page: Parameters<Parameters<typeof browser.use>[1]>[0]) =>
          page.getByRole("complementary", { name: "Workflow diagram details" });

        yield* browser.login(actors.owner);
        const source = yield* holdQuery(
          [actors.organization.id, actors.organization.slug].map(
            (organization) => `/api/organizations/${organization}/apps/${app.id}/source`,
          ),
          "continue",
        );
        yield* openThroughBrowser("Open the app's workflows", url);
        yield* browser.use("Choose the triage workflow", (page) =>
          page
            .getByRole("navigation", { name: "Workflows", exact: true })
            .getByRole("button")
            .filter({ hasText: "Label new issues and flag urgent ones" })
            .click(),
        );
        yield* source.requested;
        yield* browser.use("The diagram holds its place while the source loads", (page) =>
          diagram(page).locator("[aria-busy=true]").waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Starting a run stays available meanwhile", (page) =>
            page.getByRole("button", { name: "Start workflow", exact: true }).isEnabled(),
          ),
        ).toBe(true);
        yield* browser.use("Run history stays visible meanwhile", (page) =>
          page
            .getByRole("region", { name: "Workflow run history" })
            .getByText("No runs yet", { exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* source.release;

        yield* browser.use("The start card names the input", (page) =>
          diagram(page)
            .getByRole("button", { name: /owner, name/ })
            .waitFor({ state: "visible" }),
        );
        for (const name of [
          "Load new issues",
          "Classify #…",
          "Post to Slack",
          "Queue the weekly digest",
        ])
          yield* browser.use(`Step ${name} is drawn`, (page) =>
            step(page, name).waitFor({ state: "visible" }),
          );
        yield* browser.use("Early return is a decision", (page) =>
          diagram(page)
            .getByRole("button", { name: "Decision: issues.length === 0", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("The loop is a box around its steps", (page) =>
          diagram(page)
            .getByRole("button", { name: /Each issue/ })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Skipping an item is drawn inside the loop", (page) =>
          diagram(page).getByText("Next", { exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.use("The tool that starts it is listed", (page) =>
          details(page).getByText("triageNow", { exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Workflow drawn from its code");

        yield* browser.use("Select a step", (page) => step(page, "Classify #…").click());
        expect(
          yield* browser.use("Selection moves to the step", (page) =>
            Promise.all([
              diagram(page)
                .getByRole("button", { name: /owner, name/ })
                .getAttribute("aria-current"),
              step(page, "Classify #…").getAttribute("aria-current"),
            ]),
          ),
        ).toEqual([null, "true"]);
        yield* browser.use("The step names the host its code calls", (page) =>
          details(page)
            .getByText("api.anthropic.com", { exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("The step's options are shown as written", (page) =>
          details(page)
            .getByText("2, after 30 seconds, exponential", { exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("The step's own code is shown", (page) =>
            details(page).locator("pre").textContent(),
          ),
        ).toContain("ctx.step.do(");
        yield* browser.checkpoint("Step details");

        yield* browser.use("Select a step written in a helper", (page) =>
          step(page, "Post to Slack").click(),
        );
        yield* browser.use("Its code is shown from the helper's own file", (page) =>
          details(page)
            .getByText(/^notify\.ts · lines/u)
            .waitFor({ state: "visible" }),
        );

        yield* browser.use("Follow the step that starts another workflow", (page) =>
          diagram(page).getByRole("button", { name: "Open digest", exact: true }).click(),
        );
        const trail = (page: Parameters<Parameters<typeof browser.use>[1]>[0]) =>
          page.getByRole("navigation", { name: "Workflow trail" });
        expect(
          yield* browser.use("The trail records how it was reached", (page) =>
            trail(page).textContent(),
          ),
        ).toBe("triage›Queue the weekly digest›digest");
        for (const text of ["At the same time", "Try", "If it fails"])
          yield* browser.use(`${text} is drawn`, (page) =>
            diagram(page).getByText(text, { exact: true }).first().waitFor({ state: "visible" }),
          );
        for (const text of ["monday", "digest.queue", "triage"])
          yield* browser.use(`Started by ${text}`, (page) =>
            details(page).getByText(text, { exact: true }).first().waitFor({ state: "visible" }),
          );
        yield* browser.checkpoint("Drilled into the started workflow");

        yield* browser.use("A starter already on the trail leads back to it", (page) =>
          details(page)
            .getByRole("button", { name: /^triage/ })
            .click(),
        );
        expect(
          yield* browser.use("Going back shortens the trail", (page) => trail(page).textContent()),
        ).toBe("triage");
        yield* browser.use("Drill into digest again", (page) =>
          diagram(page).getByRole("button", { name: "Open digest", exact: true }).click(),
        );
        yield* browser.use("Go back along the trail", (page) =>
          trail(page).getByRole("button", { name: "triage", exact: true }).click(),
        );
        yield* browser.use("The first workflow is shown again", (page) =>
          step(page, "Post to Slack").waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("The trail is back at its start", (page) => trail(page).textContent()),
        ).toBe("triage");

        // Members who cannot read the source keep today's run history, without the diagram.
        const sourceReads: string[] = [];
        yield* browser.use("Watch for source reads", (page) => {
          page.on("request", (request) => {
            if (new URL(request.url()).pathname.endsWith(`/apps/${app.id}/source`))
              sourceReads.push(request.url());
          });
          return Promise.resolve();
        });
        yield* browser.login(actors.member);
        yield* openThroughBrowser("Open the workflows as a member", url);
        yield* browser.use("Choose triage as a member", (page) =>
          page
            .getByRole("navigation", { name: "Workflows", exact: true })
            .getByRole("button")
            .filter({ hasText: "Label new issues and flag urgent ones" })
            .click(),
        );
        yield* browser.use("Members can start the workflow", (page) =>
          page
            .getByRole("button", { name: "Start workflow", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Members see the run history", (page) =>
          page
            .getByRole("region", { name: "Workflow run history" })
            .getByText("No runs yet", { exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Members do not see the diagram", (page) => diagram(page).count()),
        ).toBe(0);
        expect(sourceReads).toEqual([]);
        yield* browser.checkpoint("Members keep today's run history");
      }),
    ),
  );
});
