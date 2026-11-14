/** Upgrade failures must leave the supported old product layout usable. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { withApps } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { beforeAppAccounts, beforeProfileRemoval } from "../support/profile-removal-rollback.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Registry upgrades", (it) => {
  it.effect(scenarios.registryMigration.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const name = `@${actors.organization.slug}.executor.community/retained`;
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: "Retained publication",
            files: [
              {
                path: "index.ts",
                content: 'import {defineApp} from "apps"; export default defineApp({},{});',
              },
              { path: "README.md", content: "The original published source" },
              { path: "package.json", content: JSON.stringify({ name, dependencies: withApps() }) },
            ],
          }),
        );
        const workspace = yield* body(
          Schema.Struct({ revision: Schema.Struct({ commit: Schema.String }) }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/workspace`),
        );
        const commit = workspace.revision.commit;
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/publication`, {
            commit,
          })).status,
        ).toBe(200);
        const readFiles = Effect.gen(function* () {
          const source = yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/app-publications/source?name=${encodeURIComponent(name)}&commit=${commit}`,
          );
          expect(source.status).toBe(200);
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              publication: Schema.Struct({ name: Schema.String, commit: Schema.String }),
              files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
            }),
          )(source.body);
          expect(decoded.publication).toEqual({ name, commit });
          return [...decoded.files].sort((left, right) => left.path.localeCompare(right.path));
        });
        // Every published path and content byte, not just the README, must survive the upgrade.
        const publishedFiles = yield* readFiles;
        expect(publishedFiles).toEqual(
          expect.arrayContaining([
            { path: "README.md", content: "The original published source" },
            expect.objectContaining({ path: "index.ts" }),
            expect.objectContaining({ path: "package.json" }),
          ]),
        );
        // Read the version a fresh current server actually installed, without importing SDK internals.
        const [currentSdk] = yield* legacyStorage([
          { sql: `SELECT value FROM private_executor_settings WHERE key = 'version'` },
        ]);
        expect(currentSdk).toHaveLength(1);
        // Reconstruct the supported prior schemas on the stopped runner-owned database. Both
        // historical scopes can legitimately retain one owner's same label in layout 1.
        yield* legacyStorage([
          {
            sql: `CREATE TABLE executor_public_scopes (scope varchar(80) PRIMARY KEY, owner varchar(255) NOT NULL)`,
          },
          ...beforeAppAccounts(),
          ...beforeProfileRemoval(),
          {
            sql: `CREATE TABLE executor_public_apps (name varchar(255) PRIMARY KEY, owner varchar(255) NOT NULL, app varchar(255) NOT NULL, publication json NOT NULL, source json NOT NULL)`,
          },
          {
            sql: `INSERT INTO executor_public_scopes SELECT 'old', owner FROM executor_public_listings`,
          },
          {
            sql: `INSERT INTO executor_public_apps SELECT '@old/' || label, owner, app, (release::jsonb || jsonb_build_object('name', '@old/' || label))::json, source FROM executor_public_listings`,
          },
          {
            sql: `INSERT INTO executor_public_apps SELECT '@renamed/retained', owner, app, publication, source FROM executor_public_apps`,
          },
          { sql: `DROP TABLE executor_public_listings` },
          {
            sql: `UPDATE private_executor_public_apps_settings SET value = '1.0.0' WHERE key = 'version'`,
          },
          { sql: `DELETE FROM private_executor_public_apps_settings WHERE key = 'name-variants'` },
          {
            sql: `DROP INDEX executor_accounts_owner_id, executor_installations_owner_app, executor_deployments_code_created, executor_stored_oauth_clients_owner_issuer`,
          },
          {
            sql: `ALTER TABLE executor_stored_oauth_clients DROP COLUMN issuer, ALTER COLUMN provider SET NOT NULL`,
          },
          {
            sql: `ALTER TABLE executor_stored_oauth_client_credentials ALTER COLUMN provider SET NOT NULL`,
          },
          { sql: `UPDATE private_executor_settings SET value = '4.0.10' WHERE key = 'version'` },
          { sql: `DELETE FROM private_executor_settings WHERE key = 'name-variants'` },
        ]);
        for (const attempt of [1, 2]) {
          yield* serverControl("start", 500);
          const [sdk, registry, rows, replacement] = yield* legacyStorage([
            { sql: `SELECT value FROM private_executor_settings WHERE key = 'version'` },
            {
              sql: `SELECT value FROM private_executor_public_apps_settings WHERE key = 'version'`,
            },
            { sql: `SELECT name FROM executor_public_apps ORDER BY name` },
            { sql: `SELECT to_regclass('executor_public_listings')::text AS name` },
          ]);
          expect(sdk, `failed attempt ${attempt} does not strand the old SDK`).toEqual([
            { value: "4.0.10" },
          ]);
          expect(registry).toEqual([{ value: "1.0.0" }]);
          expect(rows).toEqual([{ name: "@old/retained" }, { name: "@renamed/retained" }]);
          expect(replacement).toEqual([{ name: null }]);
        }
        yield* legacyStorage([
          { sql: `DELETE FROM executor_public_apps WHERE name = '@renamed/retained'` },
        ]);
        for (const attempt of [1, 2]) {
          yield* serverControl("start");
          expect(yield* readFiles, `retained source after successful start ${attempt}`).toEqual(
            publishedFiles,
          );
          const [sdk, registry, count] = yield* legacyStorage([
            { sql: `SELECT value FROM private_executor_settings WHERE key = 'version'` },
            {
              sql: `SELECT value FROM private_executor_public_apps_settings WHERE key = 'version'`,
            },
            { sql: `SELECT count(*)::integer AS count FROM executor_public_listings` },
          ]);
          expect(sdk).toEqual(currentSdk);
          expect(registry).toEqual([{ value: "2.0.0" }]);
          expect(count).toEqual([{ count: 1 }]);
        }
        yield* serverControl("start");
      }),
    ),
  );
});
