import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { expandableOpenapiDocument } from "../support/large-openapi.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const index = `import { defineApp } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
import configuration from "./openapi.json";
export default defineApp({}, async ({ cache, fetch, signal }) => ({
  tools: liveOpenapiRouter({ ...configuration, cache, fetch, ...(signal === undefined ? {} : { signal }) }),
}));`;

const resources = 60;
const operations = 1100;

layer(TestLive, { excludeTestServices: true })("Local OpenAPI tools", (it) => {
  it.effect(scenarios.localExpandableOpenapiTools.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          browser = yield* Browser,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const origin = target.metadata.origin;
        const configuration = JSON.stringify({
          source: { document: expandableOpenapiDocument(origin, resources, operations) },
          allowedOrigin: origin,
          securitySchemes: {},
          methods: {},
          oauth: [],
        });
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Expandable OpenAPI ${randomUUID().slice(0, 8)}`,
            files: [
              { path: "index.ts", content: index },
              { path: "openapi.json", content: configuration },
              appsManifest,
            ],
          },
          headers,
        );
        expect(deployed.status, JSON.stringify(deployed.body).slice(0, 2000)).toBe(200);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
          deployed,
        );
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const { url } = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* session.send("POST", "/auth/pair", undefined, headers),
        );
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("Local pairing completes before app navigation", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );

        const tool = "resources.getResource37View3";
        yield* browser.use("Open a tool of the expandable app", (page) =>
          page.goto(`/apps/${app.id}?view=tools&tool=${encodeURIComponent(tool)}`),
        );
        yield* browser.use("The selected tool's output schema shows", (page) =>
          page.getByRole("region", { name: "Returns", exact: true }).waitFor(),
        );
        const shown = yield* browser.use("Read the tool list and the schema state", (page) =>
          Promise.all([
            page.getByRole("button", { name: "Run tool", exact: true }).count(),
            page.getByRole("status", { name: "Loading schema", exact: true }).count(),
            page.getByRole("region", { name: "Inputs", exact: true }).count(),
            page.getByText("This tool is no longer in the app's catalog.").count(),
          ]),
        );
        expect(shown).toEqual([1, 0, 1, 0]);
      }),
    ),
  );
});
