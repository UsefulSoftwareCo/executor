import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appBrowserFiles, checkAppBrowser } from "../support/app-browser.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("App browsing", (it) => {
  it.effect(scenarios.appBrowser.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Browse ${randomUUID().slice(0, 8)}`,
          files: appBrowserFiles,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(
          Schema.Struct({ ...App.fields, activeDeployment: Schema.String }),
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

        const run = yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
          workflow: "report",
          input: {},
        });
        expect(run.status).toBe(200);
        const runId = (yield* body(Schema.Struct({ id: Schema.String }), run)).id;
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", `${path}/workflow-runs/${runId}/terminate`)
            .pipe(Effect.orDie),
        );
        expect((yield* api.request(actors.member, "GET", `${path}/source`)).status).toBe(403);
        const anonymous = yield* api.session();
        expect((yield* api.request(anonymous, "GET", `${path}/skill-bundle`)).status).toBe(401);
        yield* browser.login(actors.member);
        yield* checkAppBrowser({
          url: `/org/${actors.organization.slug}/apps/${app.id}`,
          listUrl: `/org/${actors.organization.slug}/apps`,
          name: app.name,
          deployment: app.activeDeployment,
          readPaths: [actors.organization.id, actors.organization.slug].map(
            (organization) => `/api/organizations/${organization}/apps/${app.id}`,
          ),
          skills: "reader",
        });
      }),
    ),
  );
});
