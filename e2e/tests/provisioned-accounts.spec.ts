/** Retained host credentials survive adopting a provisioned declaration; browser and HTTP cannot replace them. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Evidence } from "../support/evidence.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { provisionedSource as source } from "../support/provisioned-source.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});

layer(HostedLive, { excludeTestServices: true })("Provisioned accounts", (it) => {
  it.effect(scenarios.provisionedAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Host access fixture",
          files: [{ path: "index.ts", content: source(false) }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        let account: string | undefined;
        yield* Effect.addFinalizer(() =>
          serverControl("start").pipe(
            Effect.andThen(
              Effect.gen(function* () {
                yield* api.request(actors.owner, "DELETE", path);
                if (account !== undefined)
                  yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
              }),
            ),
            Effect.orDie,
          ),
        );
        const connections = `${path}/accounts/user/service/connections`;
        const pending = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", connections, {}),
        );
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${pending.id}/submit`,
          {
            method: "key",
            label: "Host account",
            fields: { token: "fixture-host-key" },
          },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        account = (yield* body(Resource, saved)).id;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the previous connection controls", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("The previous declaration invites another connection", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).waitFor(),
        );
        yield* evidence.attach(
          "provisioned-before.png",
          "image/png",
          yield* browser.use("Capture the previous controls", (page) =>
            page.screenshot({ fullPage: true }),
          ),
        );
        const updated = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          files: [{ path: "index.ts", content: source(true) }, appsManifest],
        });
        expect(updated.status, JSON.stringify(updated.body)).toBe(200);
        const current = yield* body(Schema.Struct({ app: App }), updated);
        // Host provisioning has no HTTP credential-write endpoint. Retain the pre-declaration
        // account, as a host upgrading its existing provisioned account does, using the supported
        // isolated database fixture. Normal account setup above still went through the product.
        yield* legacyStorage([
          {
            sql: "UPDATE executor_accounts SET provider = $1 WHERE id = $2",
            params: [current.app.requirements.accounts.service.provider, account],
          },
        ]);
        yield* serverControl("start");
        for (const input of [{}, { account }]) {
          const refused = yield* api.request(actors.owner, "POST", connections, input);
          expect(refused.status, JSON.stringify(refused.body)).toBe(422);
          expect(refused.body).toMatchObject({
            _tag: "AccountProvisioned",
            message: expect.stringContaining("automatically"),
          });
        }
        const used = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "present",
          kind: "query",
          input: {},
        });
        expect(used.status, JSON.stringify(used.body)).toBe(200);
        expect(used.body).toMatchObject({ valid: true });
        yield* browser.use("Reload the provisioned account row", (page) => page.reload());
        yield* browser.use("Wait for automatic setup", (page) =>
          page.getByText("Set up automatically", { exact: true }).waitFor(),
        );
        const actions = yield* browser.use("Read provisioned row actions", (page) =>
          Promise.all([
            page.getByRole("button", { name: "Connect new account", exact: true }).count(),
            page.getByRole("button", { name: "Reconnect", exact: true }).count(),
          ]),
        );
        expect(actions).toEqual([0, 0]);
        yield* browser.use("Open the provisioned account menu", (page) =>
          page.getByRole("button", { name: "Manage Host account", exact: true }).click(),
        );
        const menu = yield* browser.use("Read the provisioned account menu", (page) =>
          Promise.all([
            page.getByRole("menuitem", { name: "Update credentials", exact: true }).count(),
            page.getByRole("menuitem", { name: "Reconnect", exact: true }).count(),
          ]),
        );
        expect(menu).toEqual([0, 0]);
        yield* browser.use("Close the account menu", (page) => page.keyboard.press("Escape"));
        yield* evidence.attach(
          "provisioned-after.png",
          "image/png",
          yield* browser.use("Capture automatic setup", (page) =>
            page.screenshot({ fullPage: true }),
          ),
        );
      }),
    ),
  );
});
