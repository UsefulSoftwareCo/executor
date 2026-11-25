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

const before = [
  "baseline",
  "api_key_memberships",
  "upgrade_executor_apps",
  "data_steps",
  "upgrade_executor_apps",
  "upgrade_pinned_executor_apps",
  "require_connection_targets",
  "oauth_client_access",
].map((name, index) => ({ migration_id: index + 1, name }));
const proved = [
  { migration_id: 9, name: "app_account_links" },
  { migration_id: 12, name: "personal_accounts" },
];

const AuthSession = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });
const Tokens = Schema.Struct({ primary: Schema.String, extras: Schema.Array(Schema.String) });

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
        const created = {
          apps: [] as string[],
          accounts: [] as { readonly actor: Session; readonly id: string }[],
        };
        yield* Effect.addFinalizer(() =>
          serverControl("start").pipe(
            Effect.andThen(
              Effect.forEach(
                [
                  ...created.apps.map((app) => ({
                    actor: actors.owner,
                    path: `${prefix}/apps/${app}`,
                  })),
                  ...created.accounts.map((account) => ({
                    actor: account.actor,
                    path: `${prefix}/accounts/${account.id}`,
                  })),
                ],
                ({ actor, path }) => api.request(actor, "DELETE", path),
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
        const connect = (actor: Session, app: string, token: string) =>
          Effect.gen(function* () {
            const connection = yield* api.request(
              actor,
              "POST",
              connectionsPath(`${prefix}/apps/${app}`, "user", "primary"),
              {},
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
            created.accounts.push({ actor, id: account });
            return account;
          });
        const call = (actor: Session, app: string) =>
          api.request(actor, "POST", `${prefix}/apps/${app}/tools/call`, {
            tool: "tokens",
            kind: "query",
            input: {},
          });

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
            const first = yield* connect(actors.owner, app, "first-token"),
              second = yield* connect(actors.owner, app, "second-token"),
              disabled = yield* connect(actors.owner, app, "disabled-token"),
              removed = yield* connect(actors.owner, app, "removed-token"),
              shared = yield* connect(actors.member, app, "shared-token");
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

        const [recorded, rolledBack, , sharedBack] = yield* legacyStorage([
          { sql: "SELECT migration_id, name FROM private_hosted_migrations ORDER BY migration_id" },
          {
            sql: "DELETE FROM private_hosted_migrations WHERE migration_id >= 9 RETURNING migration_id",
          },
          { sql: "DROP TABLE hosted_app_account_links" },
          {
            sql: `UPDATE hosted_account_access
              SET kind = 'shared', personal_user_id = NULL, audience = 'everyone'
              WHERE account_id = $1 AND creator_id = $2 RETURNING account_id`,
            params: [fixture.shared, fixture.member],
          },
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
        expect(recorded?.slice(0, before.length), "steps 1 to 8 stay recorded").toEqual(before);
        expect(recorded, "this build records steps 9 and 12").toEqual(
          expect.arrayContaining(proved),
        );
        expect(
          rolledBack?.map((row) => Number(row.migration_id)).toSorted((a, b) => a - b),
          "step 9 and every later step are pending again",
        ).toEqual(recorded?.slice(before.length).map((row) => row.migration_id));
        expect(sharedBack, "the member's account is shared again").toEqual([
          { account_id: fixture.shared },
        ]);
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
            "the member's selection of the shared account the member created",
          ).toEqual([["primary", fixture.shared]]);
          const sharedDetail = yield* api.request(
            actors.member,
            "GET",
            `${prefix}/accounts/${fixture.shared}`,
          );
          expect(sharedDetail.status, JSON.stringify(sharedDetail.body)).toBe(200);
          expect(
            sharedDetail.body,
            "step 12 made the shared account its creator's own",
          ).toMatchObject({ account: { id: fixture.shared }, canManage: true });
          expect(
            (yield* api.request(actors.admin, "GET", `${prefix}/accounts/${fixture.shared}`))
              .status,
            "another member no longer reaches the former shared account",
          ).toBe(403);
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
        const [after, stored, ownership] = yield* legacyStorage([
          { sql: "SELECT migration_id, name FROM private_hosted_migrations ORDER BY migration_id" },
          {
            sql: "SELECT app, requirement, subject, account, linked_by FROM hosted_app_account_links",
          },
          {
            sql: "SELECT kind, personal_user_id, audience FROM hosted_account_access WHERE account_id = $1",
            params: [fixture.shared],
          },
        ]);
        expect(after, "steps 9 and later are recorded again, each once").toEqual(recorded);
        expect(ownership, "the former shared account is stored as its creator's").toEqual([
          { kind: "personal", personal_user_id: fixture.member, audience: null },
        ]);
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
