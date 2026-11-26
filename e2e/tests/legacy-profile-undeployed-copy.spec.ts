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
  activeVersion: Schema.NullOr(Schema.String),
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

        const name = `Undeployed profiles ${suffix}`;
        const created = yield* agent.send("POST", "/v1/apps", { owner: "local", name, files });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const app = yield* body(StoredApp, created);
        apps.push(app.id);
        expect(app.activeVersion).toBeNull();

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
        expect(copy!.activeVersion).toBeNull();
        expect(yield* localAccountLinks(agent, app.id)).toEqual([["service", first]]);
        expect(yield* localAccountLinks(agent, copy!.id)).toEqual([["service", second]]);

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
