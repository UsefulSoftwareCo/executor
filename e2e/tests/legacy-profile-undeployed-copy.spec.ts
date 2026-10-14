/**
 * A local app saved but never deployed may still have had profiles. SDK 4.0.13 plans a copy for
 * each other account set, and data step `10_profile_app_copies` saves that copy undeployed, as its
 * app is: it declares no requirements until it is deployed. Its profiles' accounts are linked all
 * the same, so deploying the copy runs it with them.
 *
 * The fixture rebuilds the database as an upgrade from 4.0.12 finds it, as the local MCP profile
 * targets scenario does: it undoes 4.0.14 and 4.0.13, labels the database 4.0.12, makes local step
 * `2_app_account_links` and data step 10 pending again, and writes the profiles.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { body } from "../support/api.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { callLocalQuery, localAccountLinks, localAgent } from "../support/local-links.ts";
import {
  beforeAppAccounts,
  beforeProfileRemoval,
  profileAppCopiesPending,
} from "../support/profile-removal-rollback.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

/** The same provider in every app, so the accounts one app saved fill the other's requirement. */
const source = `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const service = defineProvider({ name: "Undeployed copy fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service } } }, async () => ({
  tools: router({ whoami: query({ input: object({}) }, async (ctx) => ctx.user.accounts.service.fields.token) }),
}));`;
const files = [{ path: "index.ts", content: source }, appsManifest];
const Published = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const StoredApp = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  activeDeployment: Schema.NullOr(Schema.String),
});

layer(TestLive, { excludeTestServices: true })("Legacy profile undeployed copy", (it) => {
  it.effect(scenarios.legacyProfileUndeployedCopy.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { agent } = yield* localAgent;
        const suffix = randomUUID().slice(0, 8);
        const apps: string[] = [];
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* serverControl("start");
            for (const app of apps) yield* agent.send("DELETE", `/v1/apps/${app}`);
            for (const account of accounts) yield* agent.send("DELETE", `/v1/accounts/${account}`);
          }).pipe(Effect.orDie),
        );

        // A deployed app to save the accounts from.
        const deployed = yield* agent.send("POST", "/v1/apps/deploy", {
          owner: "local",
          name: `Undeployed copy accounts ${suffix}`,
          files,
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const accountsApp = (yield* body(Published, deployed)).app.id;
        apps.push(accountsApp);
        const connect = (token: string) =>
          Effect.gen(function* () {
            const account = (yield* connectLocalAccount(agent, {
              app: accountsApp,
              requirement: "service",
              method: "key",
              label: token,
              fields: { token },
            })).id;
            accounts.push(account);
            return account;
          });
        const first = yield* connect("synthetic-undeployed-first");
        const second = yield* connect("synthetic-undeployed-second");

        // The app the profiles were for, saved and never deployed.
        const name = `Undeployed profiles ${suffix}`;
        const created = yield* agent.send("POST", "/v1/apps", { owner: "local", name, files });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const app = yield* body(StoredApp, created);
        apps.push(app.id);
        expect(app.activeDeployment).toBeNull();

        // Two enabled profiles of it with different accounts: the oldest keeps the app, the other
        // becomes "(Profile 2)".
        const profile = (id: string, account: string, createdAt: string) => ({
          sql: `INSERT INTO executor_installations
            (id, app, owner, subject, name, idempotency_key, accounts, webhook_config, revision,
             enabled, status, failure, reconciled_deployment, reconciled_revision, request, lease,
             lease_until, created_at)
            VALUES ($1, $2, 'local', 'local', NULL, $1, $3, '{}', 1, true, 'ready', NULL, NULL,
             NULL, '{}', NULL, TIMESTAMP '2000-01-01', $4)`,
          params: [id, app.id, JSON.stringify({ service: account }), createdAt],
        });
        yield* legacyStorage([
          { sql: "DELETE FROM private_local_migrations WHERE migration_id = 2" },
          ...beforeAppAccounts(),
          { sql: "DROP TABLE local_app_account_links" },
          ...beforeProfileRemoval(),
          ...profileAppCopiesPending("private_local"),
          { sql: `UPDATE private_executor_settings SET value = '4.0.12' WHERE key = 'version'` },
          profile(`legacy-undeployed-first-${suffix}`, first, "2000-01-01"),
          profile(`legacy-undeployed-second-${suffix}`, second, "2000-01-02"),
        ]);
        yield* serverControl("start");

        const listed = yield* body(
          Schema.Array(StoredApp),
          yield* agent.send("GET", "/v1/apps?owner=local"),
        );
        const copy = listed.find((item) => item.name === `${name} (Profile 2)`);
        expect(copy, "the second profile's copy").toBeDefined();
        apps.unshift(copy!.id);
        // Copied as its app is: saved, not deployed.
        expect(copy!.activeDeployment).toBeNull();
        // Each keeps its profile's account linked, though neither declares a requirement yet.
        expect(yield* localAccountLinks(agent, app.id)).toEqual([["service", first]]);
        expect(yield* localAccountLinks(agent, copy!.id)).toEqual([["service", second]]);

        // Deploying the copy runs it with the account its profile selected.
        const deployedCopy = yield* agent.send("POST", "/v1/apps/deploy", {
          owner: "local",
          app: copy!.id,
          files,
        });
        expect(deployedCopy.status, JSON.stringify(deployedCopy.body)).toBe(200);
        expect(yield* callLocalQuery(agent, copy!.id, "whoami")).toBe(
          "synthetic-undeployed-second",
        );
      }),
    ),
  );
});
