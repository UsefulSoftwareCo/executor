import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { appBrowserFiles, checkAppBrowser } from "../support/app-browser.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Local app browsing", (it) => {
  it.effect(scenarios.localAppBrowser.title, (context) =>
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
          { owner: "local", name: `Browse ${randomUUID().slice(0, 8)}`, files: appBrowserFiles },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ ...App.fields, activeDeployment: Schema.String }) }),
          deployed,
        );
        const path = `/v1/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", path, undefined, headers).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        expect(
          (yield* session.send(
            "POST",
            `${path}/workflow-runs`,
            { workflow: "report", input: {} },
            headers,
          )).status,
        ).toBe(200);
        expect(
          (yield* session.send("GET", `/dashboard/api/apps/${app.id}/skill-bundle`)).status,
        ).toBe(401);
        const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
        expect(pairing.status).toBe(200);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("The paired inventory is visible", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        yield* checkAppBrowser({
          url: `/apps/${app.id}`,
          listUrl: "/apps",
          name: app.name,
          deployment: app.activeDeployment,
          readPaths: [`/dashboard/api/apps/${app.id}`],
        });
      }),
    ),
  );
});
