import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { workflowDiagramFiles } from "../support/workflow-diagram.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Local workflow diagrams", (it) => {
  it.effect(scenarios.localWorkflowDiagram.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          browser = yield* Browser,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Diagram ${randomUUID().slice(0, 8)}`,
            files: workflowDiagramFiles,
          },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ ...App.fields, activeVersion: Schema.String }) }),
          deployed,
        );
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
        expect(pairing.status).toBe(200);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("Open the app's workflows", (page) =>
          page.goto(new URL(`/apps/${app.id}?view=workflows`, page.url()).toString()),
        );
        yield* browser.use("Choose the digest workflow", (page) =>
          page
            .getByRole("navigation", { name: "Workflows", exact: true })
            .getByRole("button")
            .filter({ hasText: "Collect a week of activity" })
            .click(),
        );
        const diagram = (page: Parameters<Parameters<typeof browser.use>[1]>[0]) =>
          page.getByRole("group", { name: "Workflow diagram" });
        for (const text of ["At the same time", "Try", "If it fails"])
          yield* browser.use(`${text} is drawn from the local source`, (page) =>
            diagram(page).getByText(text, { exact: true }).first().waitFor({ state: "visible" }),
          );
        yield* browser.use("Its starters are read from the same code", (page) =>
          page
            .getByRole("complementary", { name: "Workflow diagram details" })
            .getByText("monday", { exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Local workflow diagram");
      }),
    ),
  );
});
