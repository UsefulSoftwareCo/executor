/**
 * Upgrading a hosted instance whose members used profiles. Hosted product step
 * `9_app_account_links` converts each profile's account selections into the member's user links,
 * each to the requirement the selection named, after the SDK schema steps.
 *
 * The fixture rebuilds the database as step 9 finds it inside the upgrade transaction. The
 * product's migration ledger is per step: SDK schema versions in FumaDB's settings and hosted
 * steps in `private_hosted_migrations`, which runs every step above its latest recorded one. The
 * fixture removes step 9's ledger row and the table step 9 creates, and writes the profiles an
 * older version left in `executor_installations`. SDK 4.0.13 and 4.0.14 stay applied because, in
 * a real upgrade, they have already run when step 9 starts, and 4.0.13 keeps
 * `executor_installations` unchanged for step 9. Step 9 reads only that table, apps, deployments,
 * accounts and users, so it sees the same input as in a real upgrade. What 4.0.13 converts for
 * these seeded profiles (schedules, workflow runs, webhook sources) is outside step 9 and outside
 * this scenario; the fixture app declares none of them.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import {
  accountLinks,
  connectionsPath,
  linkedAccountIds,
  unlinkAccount,
} from "../support/app-accounts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Inventory, Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Evidence } from "../support/evidence.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { managementApp } from "../support/management-app.ts";
import { serverControl } from "../support/server-control.ts";

const source = `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const service = defineProvider({ name: "Profile upgrade service", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { primary: service, extras: service.many() } } }, async (ctx) => ({
  tools: router({
    tokens: query({ input: object({}) }, async () => ({
      primary: ctx.user.accounts.primary.fields.token,
      extras: ctx.user.accounts.extras.map((account) => account.fields.token),
    })),
  }),
}));`;

/** The hosted steps a current database has recorded, in order. */
const ledger = [
  "baseline",
  "api_key_memberships",
  "upgrade_executor_apps",
  "data_steps",
  "upgrade_executor_apps",
  "upgrade_pinned_executor_apps",
  "require_connection_targets",
  "oauth_client_access",
  "app_account_links",
].map((name, index) => ({ migration_id: index + 1, name }));

const AuthSession = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });
const Tokens = Schema.Struct({ primary: Schema.String, extras: Schema.Array(Schema.String) });

/** A profile row as the last profile version wrote it. */
const profile = (row: {
  readonly id: string;
  readonly app: string;
  readonly owner: string;
  readonly subject: string;
  readonly key: string;
  readonly accounts: Readonly<Record<string, string | readonly string[]>>;
  readonly enabled: boolean;
  readonly status: "ready" | "disabled" | "removing";
  readonly createdAt: string;
}) => ({
  sql: `INSERT INTO executor_installations (id, app, owner, subject, name, idempotency_key,
      accounts, webhook_config, revision, enabled, status, failure, reconciled_deployment,
      reconciled_revision, request, lease, lease_until, created_at)
    VALUES ($1, $2, $3, $4, NULL, $5, $6, '{}', $7, $8, $9, NULL, NULL, NULL, $10, NULL,
      '1970-01-01 00:00:00', $11)`,
  params: [
    row.id,
    row.app,
    row.owner,
    row.subject,
    row.key,
    JSON.stringify(row.accounts),
    row.enabled ? 1 : 2,
    row.enabled,
    row.status,
    JSON.stringify({ accounts: row.accounts, webhookConfig: {} }),
    row.createdAt,
  ],
});

layer(HostedLive, { excludeTestServices: true })("Legacy profile links", (it) => {
  it.effect(scenarios.legacyProfileLinks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`,
          owner = `organization:${actors.organization.id}`,
          suffix = randomUUID().slice(0, 8);
        const created = { apps: [] as string[], accounts: [] as string[] };
        yield* Effect.addFinalizer(() =>
          serverControl("start").pipe(
            Effect.andThen(
              Effect.forEach(
                [
                  ...created.apps.map((app) => `${prefix}/apps/${app}`),
                  ...created.accounts.map((account) => `${prefix}/accounts/${account}`),
                ],
                (path) => api.request(actors.owner, "DELETE", path),
                { discard: true },
              ),
            ),
            Effect.orDie,
          ),
        );
        const userId = (actor: Session) =>
          api
            .request(actor, "GET", "/api/auth/get-session")
            .pipe(Effect.flatMap((response) => body(AuthSession, response)))
            .pipe(Effect.map((session) => session.user.id));
        const deploy = (name: string) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${suffix}`,
              files: [{ path: "index.ts", content: source }, appsManifest],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(App, deployed);
            created.apps.push(app.id);
            return app.id;
          });
        const connect = (
          actor: Session,
          app: string,
          token: string,
          destination:
            | { readonly kind: "personal" }
            | { readonly kind: "shared"; audience: { kind: "everyone" } },
        ) =>
          Effect.gen(function* () {
            const connection = yield* api.request(
              actor,
              "POST",
              connectionsPath(`${prefix}/apps/${app}`, "user", "primary"),
              { destination },
            );
            expect(connection.status, JSON.stringify(connection.body)).toBe(200);
            const { id } = yield* body(Resource, connection);
            const saved = yield* api.request(actor, "POST", `${prefix}/connections/${id}/submit`, {
              method: "key",
              label: `${token} ${suffix}`,
              fields: { token },
            });
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            const account = (yield* body(Resource, saved)).id;
            created.accounts.push(account);
            return account;
          });
        const call = (actor: Session, app: string) =>
          api.request(actor, "POST", `${prefix}/apps/${app}/tools/call`, {
            tool: "tokens",
            kind: "query",
            input: {},
          });

        // Everything that is not profile-era state is created through the current product.
        const fixture = yield* evidence.step(
          "Create apps, accounts and members through the product",
          Effect.gen(function* () {
            const app = yield* deploy("Profile upgrade"),
              removedApp = yield* deploy("Removed profile app");
            const access = yield* body(
              Schema.Struct({ revision: Schema.String }),
              yield* api.request(actors.owner, "GET", `${prefix}/apps/${app}/access`),
            );
            expect(
              (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app}/access`, {
                revision: access.revision,
                audience: { kind: "everyone" },
              })).status,
            ).toBe(200);
            const personal = { kind: "personal" } as const;
            const first = yield* connect(actors.owner, app, "first-token", personal),
              second = yield* connect(actors.owner, app, "second-token", personal),
              disabled = yield* connect(actors.owner, app, "disabled-token", personal),
              removed = yield* connect(actors.owner, app, "removed-token", personal),
              shared = yield* connect(actors.admin, app, "shared-token", {
                kind: "shared",
                audience: { kind: "everyone" },
              });
            expect(
              (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${removed}`)).status,
            ).toBe(200);
            expect(
              (yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${removedApp}`)).status,
            ).toBe(200);
            const ownerKey = yield* managementApp(actors.owner),
              adminKey = yield* managementApp(actors.admin);
            expect(ownerKey.app.id).toBe(adminKey.app.id);
            return {
              app,
              removedApp,
              first,
              second,
              disabled,
              removed,
              shared,
              executor: ownerKey.app.id,
              ownerKey: ownerKey.account,
              adminKey: adminKey.account,
              owner: yield* userId(actors.owner),
              admin: yield* userId(actors.admin),
              member: yield* userId(actors.member),
            };
          }),
        );
        yield* evidence.json("fixture.json", fixture);

        // The database as step 9 finds it: profiles, no links, ledger through step 8.
        const [recorded, rolledBack] = yield* legacyStorage([
          { sql: "SELECT migration_id, name FROM private_hosted_migrations ORDER BY migration_id" },
          {
            sql: "DELETE FROM private_hosted_migrations WHERE migration_id = 9 RETURNING migration_id",
          },
          { sql: "DROP TABLE hosted_app_account_links" },
          profile({
            id: `ins_first_${suffix}`,
            app: fixture.app,
            owner,
            subject: fixture.owner,
            key: "first",
            accounts: { primary: fixture.first },
            enabled: true,
            status: "ready",
            createdAt: "2026-01-01 00:00:00",
          }),
          // A second profile of the same member and app with the same plain account; `.many()`
          // selections convert too, and a selection of an account deleted since adds nothing.
          profile({
            id: `ins_second_${suffix}`,
            app: fixture.app,
            owner,
            subject: fixture.owner,
            key: "second",
            accounts: { primary: fixture.first, extras: [fixture.second, fixture.removed] },
            enabled: true,
            status: "ready",
            createdAt: "2026-01-02 00:00:00",
          }),
          profile({
            id: `ins_disabled_${suffix}`,
            app: fixture.app,
            owner,
            subject: fixture.owner,
            key: "disabled",
            accounts: { primary: fixture.disabled },
            enabled: false,
            status: "disabled",
            createdAt: "2026-01-03 00:00:00",
          }),
          profile({
            id: `ins_removing_${suffix}`,
            app: fixture.app,
            owner,
            subject: fixture.owner,
            key: "removing",
            accounts: { primary: fixture.disabled },
            enabled: true,
            status: "removing",
            createdAt: "2026-01-04 00:00:00",
          }),
          profile({
            id: `ins_removed_app_${suffix}`,
            app: fixture.removedApp,
            owner,
            subject: fixture.owner,
            key: "removed-app",
            accounts: { primary: fixture.first },
            enabled: true,
            status: "ready",
            createdAt: "2026-01-05 00:00:00",
          }),
          // The member selected the admin's shared account.
          profile({
            id: `ins_shared_${suffix}`,
            app: fixture.app,
            owner,
            subject: fixture.member,
            key: "shared",
            accounts: { primary: fixture.shared },
            enabled: true,
            status: "ready",
            createdAt: "2026-01-06 00:00:00",
          }),
          // Member setup's default Executor profiles: the owner's active, the admin's disabled.
          profile({
            id: `ins_owner_executor_${suffix}`,
            app: fixture.executor,
            owner,
            subject: fixture.owner,
            key: "executor-default",
            accounts: { service: fixture.ownerKey },
            enabled: true,
            status: "ready",
            createdAt: "2026-01-07 00:00:00",
          }),
          profile({
            id: `ins_admin_executor_${suffix}`,
            app: fixture.executor,
            owner,
            subject: fixture.admin,
            key: "executor-default",
            accounts: { service: fixture.adminKey },
            enabled: false,
            status: "disabled",
            createdAt: "2026-01-08 00:00:00",
          }),
        ]);
        // The fixture is an upgrade while step 9 is the latest hosted step.
        expect(recorded, "current hosted ledger").toEqual(ledger);
        expect(rolledBack, "step 9 is pending again").toEqual([{ migration_id: 9 }]);
        yield* serverControl("start");

        const converted = Effect.gen(function* () {
          expect(
            yield* accountLinks(actors.owner, `${prefix}/apps/${fixture.app}`),
            "the union of the owner's active profiles, each account to the requirement it was selected for",
          ).toEqual([
            ["extras", fixture.second],
            ["primary", fixture.first],
          ]);
          expect(
            yield* accountLinks(actors.member, `${prefix}/apps/${fixture.app}`),
            "the member's shared account selection",
          ).toEqual([["primary", fixture.shared]]);
          expect(
            yield* linkedAccountIds(actors.admin, `${prefix}/apps/${fixture.app}`),
            "the admin had no profile for the app",
          ).toEqual([]);
          expect(
            (yield* managementApp(actors.owner)).account,
            "the owner's Executor key is linked",
          ).toBe(fixture.ownerKey);
          const adminInventory = yield* body(
            Inventory,
            yield* api.request(actors.admin, "GET", `${prefix}/inventory`),
          );
          expect(
            adminInventory.links.filter((link) => link.app === fixture.executor),
            "a disabled Executor profile links nothing, and setup does not relink an existing key",
          ).toEqual([]);
          expect(
            adminInventory.accounts.some((account) => account.id === fixture.adminKey),
            "the admin's key itself remains",
          ).toBe(true);
          const ownerInventory = yield* body(
            Inventory,
            yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
          );
          expect(
            ownerInventory.links.filter(
              (link) => link.app === fixture.app || link.app === fixture.removedApp,
            ),
          ).toEqual([
            { app: fixture.app, account: fixture.first },
            { app: fixture.app, account: fixture.second },
          ]);
        });

        yield* evidence.step("Profiles became links", converted);
        yield* evidence.step(
          "Converted links run calls",
          Effect.gen(function* () {
            // Each requirement uses the accounts linked to it: the plain one the account the
            // profiles used for it, the many() one, which shares the provider, only the accounts
            // selected for it. The disabled and removing profiles' account is the owner's, but not
            // linked, so no call uses it.
            const owner = yield* call(actors.owner, fixture.app);
            expect(owner.status, JSON.stringify(owner.body)).toBe(200);
            expect(yield* body(Tokens, owner)).toEqual({
              primary: "first-token",
              extras: ["second-token"],
            });
            const member = yield* call(actors.member, fixture.app);
            expect(member.status, JSON.stringify(member.body)).toBe(200);
            expect(yield* body(Tokens, member)).toEqual({
              primary: "shared-token",
              extras: [],
            });
          }),
        );

        // Step 9 is recorded once. Restarts must not replay it over the profiles that remain.
        yield* unlinkAccount(
          actors.owner,
          `${prefix}/apps/${fixture.app}`,
          "extras",
          fixture.second,
        );
        for (const restart of [1, 2]) {
          yield* serverControl("restart");
          yield* evidence.step(
            `Restart ${restart} keeps the links as they are`,
            Effect.gen(function* () {
              expect(
                yield* accountLinks(actors.owner, `${prefix}/apps/${fixture.app}`),
                "an unlinked converted account stays unlinked",
              ).toEqual([["primary", fixture.first]]);
              expect(
                yield* linkedAccountIds(actors.member, `${prefix}/apps/${fixture.app}`),
              ).toEqual([fixture.shared]);
              const owner = yield* call(actors.owner, fixture.app);
              expect(owner.status, JSON.stringify(owner.body)).toBe(200);
              expect(
                yield* body(Tokens, owner),
                "the plain link serves only its requirement",
              ).toEqual({
                primary: "first-token",
                extras: [],
              });
              expect((yield* managementApp(actors.owner)).account).toBe(fixture.ownerKey);
              const adminInventory = yield* body(
                Inventory,
                yield* api.request(actors.admin, "GET", `${prefix}/inventory`),
              );
              expect(adminInventory.links.filter((link) => link.app === fixture.executor)).toEqual(
                [],
              );
            }),
          );
        }
        const [after, stored] = yield* legacyStorage([
          { sql: "SELECT migration_id, name FROM private_hosted_migrations ORDER BY migration_id" },
          // Every stored link, including any a read would filter out.
          {
            sql: "SELECT app, requirement, subject, account, linked_by FROM hosted_app_account_links",
          },
        ]);
        expect(after, "step 9 is recorded once").toEqual(ledger);
        const order = (rows: ReadonlyArray<Record<string, unknown>>) =>
          rows.map((row) => JSON.stringify(row)).toSorted();
        expect(order(stored ?? []), "no other link was stored").toEqual(
          order([
            {
              app: fixture.app,
              requirement: "primary",
              subject: fixture.owner,
              account: fixture.first,
              linked_by: fixture.owner,
            },
            {
              app: fixture.app,
              requirement: "primary",
              subject: fixture.member,
              account: fixture.shared,
              linked_by: fixture.member,
            },
            {
              app: fixture.executor,
              requirement: "service",
              subject: fixture.owner,
              account: fixture.ownerKey,
              linked_by: fixture.owner,
            },
          ]),
        );
      }),
    ),
  );
});
