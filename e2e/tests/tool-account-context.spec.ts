import {
  connectionsPath,
  linkAccount,
  linkedAccountIds,
  unlinkAccount,
} from "../support/app-accounts.ts";
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
import { appsManifest } from "../support/apps-release.ts";

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
          files: [{ path: "index.ts", content: accountToolSource }, appsManifest],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const appPath = `${prefix}/apps/${app.id}`;
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
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(appPath, "user", "workspaces"),
                {},
              ),
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
        // Connecting from the app for the many() requirement links each new account to it.
        expect(yield* linkedAccountIds(actors.owner, appPath)).toEqual([work, personal]);
        yield* browser.login(actors.owner);
        yield* checkToolAccountContext({
          url: `/org/${actors.organization.slug}/apps/${app.id}`,
          work,
          personal,
          catalogs: [actors.organization.id, actors.organization.slug].map(
            (reference) => `/api/organizations/${reference}/apps/${app.id}/tools/index`,
          ),
          // The many() requirement uses every linked account, so choosing is linking exactly these.
          select: (ids) =>
            Effect.gen(function* () {
              const linked = yield* linkedAccountIds(actors.owner, appPath);
              for (const id of linked)
                if (!ids.includes(id))
                  yield* unlinkAccount(actors.owner, appPath, "workspaces", id);
              for (const id of ids)
                if (!linked.includes(id))
                  yield* linkAccount(actors.owner, appPath, "workspaces", id);
              expect([...(yield* linkedAccountIds(actors.owner, appPath))].sort()).toEqual(
                [...ids].sort(),
              );
            }),
        });
      }),
    ),
  );
});
