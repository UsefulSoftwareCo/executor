import { Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { provisionedSource } from "../support/provisioned-source.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
/** Radio linking and agent connection policies share the same provisioned replacement boundary. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { linkAccountResponse } from "../support/app-accounts.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const provisionedLinkFixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const files = (flag: boolean) => [
    {
      path: "index.ts",
      content: provisionedSource(flag, true).replace(
        "service: access",
        "service: access, saved: access.many()",
      ),
    },
    appsManifest,
  ];
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: "Protected link fixture",
    files: files(false),
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed),
    path = `${prefix}/apps/${app.id}`;
  const ids: string[] = [];
  const appIds = [app.id];
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* serverControl("start");
      for (const id of appIds) yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${id}`);
      for (const id of ids) yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
    }).pipe(Effect.orDie),
  );
  const add = (slot: string, method: string, label: string, token: string) =>
    Effect.gen(function* () {
      const pending = yield* body(
        Resource,
        yield* api.request(actors.owner, "POST", `${path}/accounts/user/${slot}/connections`, {}),
      );
      const response = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${pending.id}/submit`,
        { method, label, fields: { token } },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const account = (yield* body(Resource, response)).id;
      ids.push(account);
      return account;
    });
  const provisioned = yield* add("service", "key", "Host account", "fixture-host-key");
  const ordinary = yield* add("saved", "manual", "Ordinary account", "ordinary-fixture-key");
  expect(
    (yield* api.request(actors.owner, "DELETE", `${path}/accounts/user/saved/${ordinary}`)).status,
  ).toBe(200);
  const updated = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
    files: files(true),
  });
  expect(updated.status, JSON.stringify(updated.body)).toBe(200);
  const current = yield* body(Schema.Struct({ app: App }), updated);
  const assertCannotCreateProvisionedLink = Effect.gen(function* () {
    const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: "Second link fixture",
      files: files(true),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const second = yield* body(App, response);
    appIds.push(second.id);
    const refused = yield* linkAccountResponse(
      actors.owner,
      `${prefix}/apps/${second.id}`,
      "service",
      provisioned,
      "user",
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body).toMatchObject({ _tag: "AccountProvisioned" });
  });
  const assertRetained = Effect.gen(function* () {
    const used = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
      tool: "present",
      kind: "query",
      input: {},
    });
    expect(used.status, JSON.stringify(used.body)).toBe(200);
    expect(used.body).toMatchObject({ valid: true });
  });
  return {
    prefix,
    path,
    app: app.id,
    provisioned,
    ordinary,
    provider: current.app.requirements.accounts.service.provider,
    assertRetained,
    assertCannotCreateProvisionedLink,
  };
});

layer(HostedLive, { excludeTestServices: true })("Provisioned link boundary", (it) => {
  it.effect(scenarios.provisionedRadio.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* provisionedLinkFixture,
          actors = yield* Actors,
          browser = yield* Browser;
        yield* legacyStorage([
          {
            sql: "UPDATE executor_accounts SET provider = $1 WHERE id IN ($2, $3)",
            params: [fixture.provider, fixture.provisioned, fixture.ordinary],
          },
        ]);
        yield* serverControl("start");
        yield* fixture.assertCannotCreateProvisionedLink;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the provisioned account choices", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${fixture.app}?view=accounts`),
        );
        const status = yield* browser.use("Try the ordinary account radio", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "PUT" &&
                new URL(response.url()).pathname.endsWith(
                  `/accounts/user/service/${fixture.ordinary}`,
                ),
            ),
            page
              .getByRole("region", { name: "Host access (service)", exact: true })
              .getByRole("radio", { name: "Ordinary account", exact: true })
              .click(),
          ]).then(([response]) => response.status()),
        );
        expect(status).toBe(422);
        yield* fixture.assertRetained;
      }),
    ),
  );
  it.effect(scenarios.provisionedAgent.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* provisionedLinkFixture,
          actors = yield* Actors,
          api = yield* Api;
        yield* legacyStorage([
          {
            sql: "UPDATE executor_accounts SET provider = $1 WHERE id IN ($2, $3)",
            params: [fixture.provider, fixture.provisioned, fixture.ordinary],
          },
        ]);
        yield* serverControl("start");
        yield* fixture.assertCannotCreateProvisionedLink;
        const path = `${fixture.prefix}/mcp-connections`,
          id = randomUUID();
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "POST", `${path}/${id}/revoke`).pipe(Effect.orDie),
        );
        const apps = [
          {
            app: fixture.app,
            runsAs: [{ kind: "account", id: fixture.ordinary }],
            tools: { kind: "readOnly" },
          },
        ];
        const response = yield* api.request(actors.owner, "POST", path, {
          id,
          name: "Protected agent",
          apps,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(422);
        expect(response.body).toMatchObject({ _tag: "AccountProvisioned" });
        yield* fixture.assertRetained;
        const created = yield* api.request(actors.owner, "POST", path, {
          id,
          name: "Protected agent",
          apps: [],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const updated = yield* api.request(actors.owner, "PUT", `${path}/${id}`, {
          name: "Protected agent",
          apps,
        });
        expect(updated.status, JSON.stringify(updated.body)).toBe(422);
        expect(updated.body).toMatchObject({ _tag: "AccountProvisioned" });
        yield* fixture.assertRetained;
      }),
    ),
  );
});
