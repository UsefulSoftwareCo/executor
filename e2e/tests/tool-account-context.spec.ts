import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { accountToolSource, checkToolAccountContext } from "../support/tool-account-context.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Tool account context", (it) => {
  it.effect(scenarios.toolAccountContext.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Account tools ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: accountToolSource }],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const add = (label: string, token: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
                requirement: "workspaces",
                profile: profile.id,
              }),
            );
            const response = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              { method: "key", label, fields: { token } },
            );
            expect(response.status).toBe(200);
            const account = yield* body(Resource, response);
            accounts.push(account.id);
            return account.id;
          });
        const work = yield* add("Work GitHub", "work"),
          personal = yield* add("Personal GitHub", "personal");
        yield* browser.login(actors.owner);
        yield* checkToolAccountContext({
          url: `/org/${actors.organization.slug}/apps/${app.id}?profile=${profile.id}`,
          work,
          personal,
          catalogs: [actors.organization.id, actors.organization.slug].map(
            (reference) => `/api/organizations/${reference}/apps/${app.id}/tools/index`,
          ),
          select: (ids) =>
            selectProfileAccounts(actors.owner, `${prefix}/apps/${app.id}`, profile.id, {
              workspaces: ids,
            }).pipe(Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200)))),
        });
      }),
    ),
  );
});
