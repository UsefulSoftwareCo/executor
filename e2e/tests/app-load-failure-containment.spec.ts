/**
 * An app whose code throws while it loads fails only that app's reads. Its workflow listing
 * reports the app's own evaluation error, as its tool and skill listings do, instead of an opaque
 * workflow failure. A dashboard batch that carries its reads still answers every other read,
 * including another app's, and the other app's page still loads.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { openThroughBrowser } from "../support/in-app-navigation.ts";
import { batchPath } from "../support/read-batches.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({ id: Schema.String });
const Workflows = Schema.Array(Schema.Struct({ name: Schema.String }));
const EvaluationFailure = Schema.Struct({
  _tag: Schema.Literal("AppEvaluationFailed"),
  app: Schema.String,
  failure: Schema.Struct({
    source: Schema.String,
    errorName: Schema.String,
    message: Schema.String,
  }),
});
const Answers = Schema.Array(
  Schema.Struct({ id: Schema.Number, status: Schema.Number, text: Schema.optional(Schema.String) }),
);

const broken = `import { defineApp } from "apps";
export default defineApp({}, async () => {
  throw new Error("SYNTHETIC_LOAD_FAILURE");
});`;
const healthy = `import { defineApp, query, object, router, string, workflow } from "apps";
const record = workflow(
  { description: "Record a label", input: object({ label: string() }) },
  async (_ctx, input) => input.label,
);
export default defineApp({}, {
  tools: router({
    status: query({ description: "Service status", input: object({}) }, async () => "ready"),
  }),
  workflows: { record },
});`;

layer(HostedLive, { excludeTestServices: true })("App load failure containment", (it) => {
  it.effect(scenarios.appLoadFailureContainment.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const deploy = (name: string, content: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files: [{ path: "index.ts", content }, appsManifest],
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const failing = yield* deploy("Failing loader", broken);
        const working = yield* deploy("Working reports", healthy);

        // Listing the failing app's workflows reports its own error, as listing its tools does.
        const failed = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${failing.id}/workflows`,
        );
        expect(failed.status, JSON.stringify(failed.body)).toBe(502);
        expect(yield* body(EvaluationFailure, failed)).toEqual({
          _tag: "AppEvaluationFailed",
          app: failing.id,
          failure: { source: "app", errorName: "Error", message: "SYNTHETIC_LOAD_FAILURE" },
        });
        const listed = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${working.id}/workflows`,
        );
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        expect((yield* body(Workflows, listed)).map(({ name }) => name)).toEqual(["record"]);

        yield* browser.login(actors.owner);
        yield* browser.use("Open the dashboard", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        // One batch, as the dashboard sends it, with the failing app's reads among the others.
        const reads = [
          { group: "organization", endpoint: "inventory", app: undefined },
          { group: "workflows", endpoint: "definitions", app: failing.id },
          { group: "skills", endpoint: "list", app: failing.id },
          { group: "tools", endpoint: "index", app: failing.id },
          { group: "workflows", endpoint: "definitions", app: working.id },
          { group: "tools", endpoint: "index", app: working.id },
        ].map(({ app, ...read }, id) => ({
          id,
          ...read,
          params: app === undefined ? { organization } : { organization, app },
          query: {},
        }));
        const text = yield* browser.use("Send one batch from the signed-in page", (page) =>
          page.evaluate(
            ([path, payload]) =>
              fetch(path, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ reads: payload }),
              }).then((response) =>
                response.status === 200
                  ? response.text()
                  : Promise.reject(new Error(`The batch answered ${response.status}`)),
              ),
            [batchPath, reads] as const,
          ),
        );
        const answers = Schema.decodeUnknownSync(Answers)(
          text
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line)),
        );
        const label = (id: number) => {
          const read = reads[id];
          if (read === undefined) return `unknown read ${id}`;
          const app = "app" in read.params ? read.params.app : "organization";
          return `${read.group}.${read.endpoint} ${app}`;
        };
        const statuses = Object.fromEntries(answers.map(({ id, status }) => [label(id), status]));
        expect(statuses).toEqual({
          "organization.inventory organization": 200,
          [`workflows.definitions ${failing.id}`]: 502,
          [`skills.list ${failing.id}`]: 502,
          [`tools.index ${failing.id}`]: 502,
          [`workflows.definitions ${working.id}`]: 200,
          [`tools.index ${working.id}`]: 200,
        });
        for (const answer of answers.filter(({ status }) => status === 502))
          expect(answer.text, label(answer.id)).toContain("SYNTHETIC_LOAD_FAILURE");

        yield* openThroughBrowser(
          "Open the failing app's overview",
          `/org/${actors.organization.slug}/apps/${failing.id}`,
        );
        const workflows = yield* browser.use(
          "The workflows preview names the app's error",
          (page) =>
            page
              .getByRole("region", { name: "App workflows preview", exact: true })
              .getByRole("alert", { name: "Tools could not be loaded", exact: true })
              .innerText(),
        );
        expect(workflows).toContain("The app threw Error: SYNTHETIC_LOAD_FAILURE");
        expect(workflows).not.toContain("Workflow request failed");
        yield* browser.use("The skills preview names the same error", (page) =>
          page
            .getByRole("region", { name: "App skills preview", exact: true })
            .getByRole("alert", { name: "Tools could not be loaded", exact: true })
            .waitFor(),
        );
        yield* browser.use("The rest of the app's page still renders", (page) =>
          page.getByText("Failing loader", { exact: true }).first().waitFor(),
        );
        yield* browser.checkpoint("Failing app overview");

        yield* openThroughBrowser(
          "Open the working app's overview in the same session",
          `/org/${actors.organization.slug}/apps/${working.id}`,
        );
        yield* browser.use("The working app's workflows still load", (page) =>
          page
            .getByRole("region", { name: "App workflows preview", exact: true })
            .getByText("record", { exact: true })
            .waitFor(),
        );
        expect(
          yield* browser.use("The working app's overview shows no failure", (page) =>
            page.getByRole("alert").count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Working app overview");
      }),
    ),
  );
});
