/**
 * Upgrading a hosted instance that has shared accounts. Hosted product step
 * `12_personal_accounts` makes each shared account one member's personal account: its creator's
 * while they are a member, otherwise the organization's oldest owner's. Its app links keep serving
 * every caller; other members' user links to it are removed, since they cannot use another
 * member's account; its group grants go; and a pending sign-in saved to create a shared account,
 * for everyone or for groups, is refused.
 *
 * The fixture builds the accounts, links, a group and unfinished connections through the product,
 * then rewrites them as an older version stored them: one account shared with everyone, linked by
 * another member and for the app; one shared with the group whose creator is gone; the
 * connections asking for shared accounts; and step 12's ledger row removed so the next start runs
 * it. The old columns (`audience`, `destination`, `hosted_account_groups`) still exist.
 *
 * A member's user link to a shared account becomes an app link instead when the app takes accounts
 * of that provider for everyone in one many() app requirement, as an app imported with
 * `appLinkedAccounts` does with `workspace`. Every row the step changes is recorded in
 * `hosted_personal_accounts_backup`.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { accountLinks, connectionsPath } from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";

const source = `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const service = defineProvider({ name: "Personal accounts upgrade", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ app: { accounts: { team: service } }, user: { accounts: { service: service.many() } } }, async (ctx) => ({
  tools: router({
    team: query({ input: object({}), output: string() }, async () => ctx.app.accounts.team.fields.token),
    mine: query({ input: object({}) }, async () => ctx.user.accounts.service.map((account) => account.fields.token)),
  }),
}));`;

/**
 * The account requirements and reads of an app imported with `appLinkedAccounts`
 * (`accountScopes` in packages/app-templates): the accounts linked for everyone in `workspace`,
 * then the caller's own `service` accounts not among them. Step 12 reads only the declaration.
 */
const importedSource = `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const provider = defineProvider({ name: "Personal accounts imported", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ app: { accounts: { workspace: provider.many() } }, user: { accounts: { service: provider.many() } } }, async ({ app, user }) => ({
  tools: router({
    tokens: query({ input: object({}) }, async () => [...app.accounts.workspace, ...(user?.accounts.service ?? []).filter((account) => !app.accounts.workspace.some((shared) => shared.id === account.id))].map((account) => account.fields.token)),
  }),
}));`;

/** An app with only a user requirement of the same provider. */
const userOnlySource = `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const provider = defineProvider({ name: "Personal accounts imported", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service: provider.many() } } }, async ({ user }) => ({
  tools: router({
    tokens: query({ input: object({}) }, async () => (user?.accounts.service ?? []).map((account) => account.fields.token)),
  }),
}));`;

const Viewer = Schema.Struct({ userId: Schema.String });
const Members = Schema.Struct({
  members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
});
const Group = Schema.Struct({ id: Schema.String, revision: Schema.String });

layer(HostedLive, { excludeTestServices: true })("Personal accounts migration", (it) => {
  it.effect(scenarios.personalAccountsMigration.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`,
          suffix = randomUUID().slice(0, 8);
        const userId = (actor: Session) =>
          api
            .request(actor, "GET", "/api/viewer")
            .pipe(Effect.flatMap((response) => body(Viewer, response)))
            .pipe(Effect.map((viewer) => viewer.userId));
        const owner = yield* userId(actors.owner),
          admin = yield* userId(actors.admin),
          member = yield* userId(actors.member);

        // Everything but the shared state is created through the current product.
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Personal accounts upgrade ${suffix}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = (yield* body(App, deployed)).id,
          path = `${prefix}/apps/${app}`;
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
        const members = (yield* body(
          Members,
          yield* api.request(actors.owner, "GET", `${prefix}/groups`),
        )).members;
        const memberEntry = members.find((entry) => entry.userId === member);
        if (memberEntry === undefined) return yield* Effect.die("Synthetic member missing");
        const group = yield* body(
          Group,
          yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
            name: `Shared account group ${suffix}`,
            description: "",
            memberIds: [memberEntry.id],
          }),
        );
        const start = (actor: Session) =>
          api
            .request(actor, "POST", connectionsPath(path, "user", "service"), {})
            .pipe(Effect.flatMap((started) => body(Resource, started)))
            .pipe(Effect.map((started) => started.id));
        const submit = (actor: Session, connection: string, token: string) =>
          api.request(actor, "POST", `${prefix}/connections/${connection}/submit`, {
            method: "key",
            label: `${token} ${suffix}`,
            fields: { token },
          });
        const connect = (actor: Session, token: string) =>
          Effect.gen(function* () {
            const saved = yield* submit(actor, yield* start(actor), token);
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            return (yield* body(Resource, saved)).id;
          });
        // The admin's account, which becomes shared with everyone, and the member's, which
        // becomes shared with the group by a creator who is gone. Each is linked for its creator.
        const everyone = yield* connect(actors.admin, "synthetic-admin");
        const grouped = yield* connect(actors.member, "synthetic-member");
        // Sign-ins the member started and never finished.
        const pendingEveryone = yield* start(actors.member);
        const pendingGroup = yield* start(actors.member);

        yield* Effect.addFinalizer(() =>
          serverControl("start").pipe(
            Effect.andThen(api.request(actors.owner, "DELETE", path)),
            Effect.andThen(api.request(actors.admin, "DELETE", `${prefix}/accounts/${everyone}`)),
            Effect.andThen(api.request(actors.owner, "DELETE", `${prefix}/accounts/${grouped}`)),
            Effect.andThen(
              api.request(actors.owner, "DELETE", `${prefix}/groups/${group.id}`, {
                revision: group.revision,
              }),
            ),
            Effect.orDie,
          ),
        );

        const stored = [
          {
            sql: `SELECT account_id, kind, creator_id, personal_user_id, audience, revision
              FROM hosted_account_access WHERE account_id = ANY($1::text[]) ORDER BY account_id`,
            params: [`{${[everyone, grouped].join(",")}}`],
          },
          {
            sql: "SELECT account_id, group_id FROM hosted_account_groups WHERE account_id = $1",
            params: [grouped],
          },
          {
            sql: `SELECT requirement, subject, account FROM hosted_app_account_links WHERE app = $1
              ORDER BY requirement, subject NULLS FIRST, account`,
            params: [app],
          },
          {
            sql: `SELECT connection_id FROM hosted_connection_access
              WHERE connection_id = ANY($1::text[]) ORDER BY connection_id`,
            params: [`{${[pendingEveryone, pendingGroup].join(",")}}`],
          },
          { sql: "SELECT name FROM private_hosted_migrations WHERE migration_id = 12" },
          {
            sql: `SELECT run, entry, account_id, outcome, reason, target, new_owner,
                row ->> 'subject' AS subject, row ->> 'group_id' AS group_id,
                row ->> 'connection_id' AS connection_id
              FROM hosted_personal_accounts_backup
              WHERE account_id = ANY($1::text[]) OR row ->> 'connection_id' = ANY($2::text[])`,
            params: [
              `{${[everyone, grouped].join(",")}}`,
              `{${[pendingEveryone, pendingGroup].join(",")}}`,
            ],
          },
        ] as const;

        // The database as an older version left it, with step 12 pending.
        const [removedStep, ...written] = yield* legacyStorage([
          { sql: "DELETE FROM private_hosted_migrations WHERE migration_id = 12 RETURNING name" },
          // The admin's account is shared with everyone. The owner linked it for themselves and
          // for the app.
          {
            sql: `UPDATE hosted_account_access SET kind = 'shared', personal_user_id = NULL,
              audience = 'everyone' WHERE account_id = $1`,
            params: [everyone],
          },
          {
            sql: `INSERT INTO hosted_app_account_links (app, requirement, subject, account, linked_by)
              VALUES ($1, 'service', $2, $3, $2), ($1, 'team', NULL, $3, $2)`,
            params: [app, owner, everyone],
          },
          // The member's account is shared with the group, and its creator's user is gone.
          {
            sql: `UPDATE hosted_account_access SET kind = 'shared', personal_user_id = NULL,
              audience = 'groups', creator_id = NULL WHERE account_id = $1`,
            params: [grouped],
          },
          {
            sql: `INSERT INTO hosted_account_groups (organization_id, account_id, group_id)
              VALUES ($1, $2, $3)`,
            params: [actors.organization.id, grouped, group.id],
          },
          // The pending sign-ins ask for a shared account, for everyone and for the group.
          {
            sql: `UPDATE hosted_connection_access SET destination = $2::jsonb
              WHERE connection_id = $1`,
            params: [pendingEveryone, JSON.stringify({ kind: "shared" })],
          },
          {
            sql: `UPDATE hosted_connection_access SET destination = $2::jsonb
              WHERE connection_id = $1`,
            params: [
              pendingGroup,
              JSON.stringify({ kind: "shared", audience: { kind: "groups", groups: [group.id] } }),
            ],
          },
          ...stored,
        ]);
        expect(removedStep, "step 12 is pending again").toEqual([{ name: "personal_accounts" }]);
        const [before, beforeGroups, beforeLinks, beforePending, , beforeBackup] = written.slice(6);
        yield* evidence.json("before.json", { before, beforeGroups, beforeLinks, beforePending });
        expect(beforeBackup, "nothing is recorded for these rows before the step").toEqual([]);
        expect(before).toEqual(
          [
            {
              account_id: everyone,
              kind: "shared",
              creator_id: admin,
              personal_user_id: null,
              audience: "everyone",
              revision: expect.any(String),
            },
            {
              account_id: grouped,
              kind: "shared",
              creator_id: null,
              personal_user_id: null,
              audience: "groups",
              revision: expect.any(String),
            },
          ].sort((a, b) => a.account_id.localeCompare(b.account_id)),
        );
        expect(beforeLinks).toHaveLength(4);
        expect(beforePending).toHaveLength(2);

        yield* serverControl("start");

        const upgraded = Effect.gen(function* () {
          const [converted, groups, links, pending, recorded, backup] =
            yield* legacyStorage(stored);
          yield* serverControl("start");
          yield* evidence.json("after.json", {
            converted,
            groups,
            links,
            pending,
            recorded,
            backup,
          });
          // The admin's account is the admin's own; the group's account, whose creator is gone,
          // is the organization's owner's. Each gets a new revision.
          expect(converted).toEqual(
            [
              {
                account_id: everyone,
                kind: "personal",
                creator_id: admin,
                personal_user_id: admin,
                audience: null,
                revision: expect.any(String),
              },
              {
                account_id: grouped,
                kind: "personal",
                creator_id: null,
                personal_user_id: owner,
                audience: null,
                revision: expect.any(String),
              },
            ].sort((a, b) => a.account_id.localeCompare(b.account_id)),
          );
          for (const row of converted ?? [])
            expect(row.revision, "a converted account has a new revision").not.toBe(
              before?.find((old) => old.account_id === row.account_id)?.revision,
            );
          expect(groups, "the account's group grants are gone").toEqual([]);
          // The app link and the admin's own link stay. The owner's link to the admin's account
          // and the member's link to the account that is now the owner's are removed.
          expect(links).toEqual([
            { requirement: "service", subject: admin, account: everyone },
            { requirement: "team", subject: null, account: everyone },
          ]);
          expect(pending, "the pending shared sign-ins lost their access records").toEqual([]);
          expect(recorded).toEqual([{ name: "personal_accounts" }]);

          // Every changed row is recorded under one run. The owner's link to the admin's account
          // stays deleted: the app takes that provider for everyone only in a plain requirement,
          // which already has its account. The member's link served nobody, since its account was
          // shared with a group.
          const entry = (fields: Record<string, unknown>) => ({
            run: expect.any(String),
            account_id: null,
            outcome: "deleted",
            reason: null,
            target: null,
            new_owner: null,
            subject: null,
            group_id: null,
            connection_id: null,
            ...fields,
          });
          const expected = [
            entry({
              entry: "account",
              account_id: everyone,
              outcome: "personal",
              new_owner: admin,
            }),
            entry({ entry: "account", account_id: grouped, outcome: "personal", new_owner: owner }),
            entry({
              entry: "user_link",
              account_id: everyone,
              reason: "plain_app_requirement",
              subject: owner,
            }),
            entry({ entry: "user_link", account_id: grouped, reason: "unusable", subject: member }),
            entry({ entry: "account_group", account_id: grouped, group_id: group.id }),
            entry({ entry: "connection_access", connection_id: pendingEveryone }),
            entry({ entry: "connection_access", connection_id: pendingGroup }),
          ];
          expect(backup).toHaveLength(expected.length);
          expect(backup).toEqual(expect.arrayContaining(expected));
          expect(new Set(backup?.map((row) => row.run)).size, "one run").toBe(1);

          // The app link keeps serving every caller with the admin's account.
          for (const actor of [actors.owner, actors.admin, actors.member]) {
            const called = yield* api.request(actor, "POST", `${path}/tools/call`, {
              tool: "team",
              kind: "query",
              input: {},
            });
            expect(called.status, JSON.stringify(called.body)).toBe(200);
            expect(called.body).toBe("synthetic-admin");
          }
          // Only the admin still runs with their own account for themselves; the member and the
          // owner lost the links to accounts that are no longer theirs to use.
          const mine = (actor: Session) =>
            api.request(actor, "POST", `${path}/tools/call`, {
              tool: "mine",
              kind: "query",
              input: {},
            });
          const tokens = (actor: Session) =>
            Effect.gen(function* () {
              const called = yield* mine(actor);
              expect(called.status, JSON.stringify(called.body)).toBe(200);
              return called.body;
            });
          expect(yield* tokens(actors.admin)).toEqual(["synthetic-admin"]);
          expect(yield* tokens(actors.owner)).toEqual([]);
          expect(yield* tokens(actors.member)).toEqual([]);
          expect(yield* accountLinks(actors.member, path)).toEqual([]);
          expect(yield* accountLinks(actors.owner, path)).toEqual([]);

          // Each account is readable only by its new owner, organization admins included.
          const read = (actor: Session, account: string) =>
            api
              .request(actor, "GET", `${prefix}/accounts/${account}`)
              .pipe(Effect.map((response) => response.status));
          expect(yield* read(actors.admin, everyone)).toBe(200);
          expect(yield* read(actors.owner, everyone)).toBe(403);
          expect(yield* read(actors.member, everyone)).toBe(403);
          expect(yield* read(actors.owner, grouped)).toBe(200);
          expect(yield* read(actors.admin, grouped)).toBe(403);
          expect(yield* read(actors.member, grouped)).toBe(403);

          // The pending sign-ins are refused, so neither saves an account.
          for (const connection of [pendingEveryone, pendingGroup]) {
            const refused = yield* submit(actors.member, connection, "synthetic-pending");
            expect(refused.status, JSON.stringify(refused.body)).toBe(403);
          }
        });
        yield* upgraded;
        const [kept] = yield* legacyStorage([
          { sql: "SELECT id FROM hosted_groups WHERE id = $1", params: [group.id] },
        ]);
        yield* serverControl("start");
        expect(kept, "the group itself stays").toEqual([{ id: group.id }]);

        // Step 12 is recorded once; starting again changes nothing.
        yield* serverControl("start");
        yield* upgraded;
      }),
    ),
  );

  it.effect(scenarios.personalAccountsAppLinkConversion.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`,
          suffix = randomUUID().slice(0, 8);
        const userId = (actor: Session) =>
          api
            .request(actor, "GET", "/api/viewer")
            .pipe(Effect.flatMap((response) => body(Viewer, response)))
            .pipe(Effect.map((viewer) => viewer.userId));
        const owner = yield* userId(actors.owner),
          admin = yield* userId(actors.admin),
          member = yield* userId(actors.member);

        const deploy = (name: string, content: string) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${suffix}`,
              files: [{ path: "index.ts", content }, appsManifest],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = (yield* body(App, deployed)).id;
            const path = `${prefix}/apps/${app}`;
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
            return { app, path };
          });
        const imported = yield* deploy("Imported app", importedSource);
        const userOnly = yield* deploy("User accounts app", userOnlySource);
        const connect = (
          actor: Session,
          scope: "app" | "user",
          requirement: string,
          token: string,
        ) =>
          Effect.gen(function* () {
            const started = yield* api.request(
              actor,
              "POST",
              connectionsPath(imported.path, scope, requirement),
              {},
            );
            const connection = (yield* body(Resource, started)).id;
            const saved = yield* api.request(
              actor,
              "POST",
              `${prefix}/connections/${connection}/submit`,
              { method: "key", label: `${token} ${suffix}`, fields: { token } },
            );
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            return (yield* body(Resource, saved)).id;
          });
        // The admin's account, linked for the admin; and the owner's, linked for everyone.
        const linked = yield* connect(actors.admin, "user", "service", "synthetic-one");
        const covered = yield* connect(actors.owner, "app", "workspace", "synthetic-two");

        yield* Effect.addFinalizer(() =>
          serverControl("start").pipe(
            Effect.andThen(api.request(actors.owner, "DELETE", imported.path)),
            Effect.andThen(api.request(actors.owner, "DELETE", userOnly.path)),
            Effect.andThen(api.request(actors.admin, "DELETE", `${prefix}/accounts/${linked}`)),
            Effect.andThen(api.request(actors.owner, "DELETE", `${prefix}/accounts/${covered}`)),
            Effect.orDie,
          ),
        );

        const accountIds = `{${[linked, covered].join(",")}}`;
        const stored = [
          {
            sql: `SELECT app, requirement, subject, account, linked_by FROM hosted_app_account_links
              WHERE account = ANY($1::text[])
              ORDER BY app = $2 DESC, requirement, subject NULLS FIRST, created_at, account`,
            params: [accountIds, imported.app],
          },
          {
            sql: `SELECT app, account, actor, revision FROM executor_webhook_sources
              WHERE account = ANY($1::text[]) ORDER BY account = $2 DESC, app`,
            params: [accountIds, linked],
          },
          {
            sql: `SELECT run, entry, account_id, outcome, reason, target, new_owner,
                row ->> 'app' AS app, row ->> 'requirement' AS requirement,
                row ->> 'subject' AS subject, row ->> 'linked_by' AS linked_by,
                row ->> 'actor' AS actor
              FROM hosted_personal_accounts_backup WHERE account_id = ANY($1::text[])`,
            params: [accountIds],
          },
        ] as const;

        // Both accounts are shared with everyone. The member linked the admin's account for
        // themselves to both apps, and the admin linked the owner's account for themselves.
        const [removedStep, , , ...written] = yield* legacyStorage([
          { sql: "DELETE FROM private_hosted_migrations WHERE migration_id = 12 RETURNING name" },
          {
            sql: `UPDATE hosted_account_access SET kind = 'shared', personal_user_id = NULL,
              audience = 'everyone' WHERE account_id = ANY($1::text[])`,
            params: [accountIds],
          },
          {
            sql: `INSERT INTO hosted_app_account_links (app, requirement, subject, account, linked_by)
              VALUES ($1, 'service', $3, $4, $3), ($2, 'service', $3, $4, $3),
                ($1, 'service', $5, $6, $5)`,
            params: [imported.app, userOnly.app, member, linked, admin, covered],
          },
          ...stored,
        ]);
        expect(removedStep, "step 12 is pending again").toEqual([{ name: "personal_accounts" }]);
        const [beforeLinks, beforeSources, beforeBackup] = written;
        yield* evidence.json("before.json", { beforeLinks, beforeSources, beforeBackup });
        const userLink = (app: string, subject: string, account: string) => ({
          app,
          requirement: "service",
          subject,
          account,
          linked_by: subject,
        });
        const beforeExpected = [
          userLink(imported.app, admin, linked),
          userLink(imported.app, member, linked),
          userLink(imported.app, admin, covered),
          userLink(userOnly.app, member, linked),
          {
            app: imported.app,
            requirement: "workspace",
            subject: null,
            account: covered,
            linked_by: owner,
          },
        ];
        expect(beforeLinks).toHaveLength(beforeExpected.length);
        expect(beforeLinks).toEqual(expect.arrayContaining(beforeExpected));
        // The admin's account serves the admin's link; the owner's, its app link.
        expect(beforeSources).toEqual([
          { app: imported.app, account: linked, actor: admin, revision: expect.any(Number) },
          { app: imported.app, account: covered, actor: null, revision: expect.any(Number) },
        ]);
        expect(beforeBackup).toEqual([]);

        yield* serverControl("start");

        const upgraded = Effect.gen(function* () {
          const [links, sources, backup] = yield* legacyStorage(stored);
          yield* serverControl("start");
          yield* evidence.json("after.json", { links, sources, backup });
          // The member's link to the imported app is now the app's link for everyone, after the
          // app's existing one. The admin's link to the owner's account is gone without a second
          // app link, and so is the member's link to the app with only user accounts. Each
          // creator keeps their own links.
          expect(links).toEqual([
            {
              app: imported.app,
              requirement: "service",
              subject: admin,
              account: linked,
              linked_by: admin,
            },
            {
              app: imported.app,
              requirement: "workspace",
              subject: null,
              account: covered,
              linked_by: owner,
            },
            {
              app: imported.app,
              requirement: "workspace",
              subject: null,
              account: linked,
              linked_by: member,
            },
          ]);
          // The admin's account now serves the app link from the app's own source, with new
          // intent; the owner's source is unchanged.
          expect(sources).toEqual([
            { app: imported.app, account: linked, actor: null, revision: expect.any(Number) },
            beforeSources?.[1],
          ]);
          expect(Number(sources?.[0]?.revision)).toBeGreaterThan(
            Number(beforeSources?.[0]?.revision),
          );

          const entry = (fields: Record<string, unknown>) => ({
            run: expect.any(String),
            account_id: null,
            outcome: "deleted",
            reason: null,
            target: null,
            new_owner: null,
            app: null,
            requirement: null,
            subject: null,
            linked_by: null,
            actor: null,
            ...fields,
          });
          const expected = [
            entry({ entry: "account", account_id: linked, outcome: "personal", new_owner: admin }),
            entry({ entry: "account", account_id: covered, outcome: "personal", new_owner: owner }),
            entry({
              entry: "user_link",
              account_id: linked,
              outcome: "converted",
              target: "workspace",
              app: imported.app,
              requirement: "service",
              subject: member,
              linked_by: member,
            }),
            entry({
              entry: "user_link",
              account_id: linked,
              reason: "no_app_requirement",
              app: userOnly.app,
              requirement: "service",
              subject: member,
              linked_by: member,
            }),
            entry({
              entry: "user_link",
              account_id: covered,
              outcome: "covered",
              target: "workspace",
              app: imported.app,
              requirement: "service",
              subject: admin,
              linked_by: admin,
            }),
            entry({
              entry: "app_link",
              account_id: linked,
              outcome: "inserted",
              target: "workspace",
              app: imported.app,
              requirement: "workspace",
              linked_by: member,
            }),
            entry({
              entry: "webhook_source",
              account_id: linked,
              outcome: "relinked",
              app: imported.app,
              actor: admin,
            }),
          ];
          expect(backup).toHaveLength(expected.length);
          expect(backup).toEqual(expect.arrayContaining(expected));
          expect(new Set(backup?.map((row) => row.run)).size, "one run").toBe(1);

          // Every caller of the imported app runs with both accounts linked for everyone, the
          // member included; the app with only user accounts gives the member none.
          const tokens = (actor: Session, path: string) =>
            Effect.gen(function* () {
              const called = yield* api.request(actor, "POST", `${path}/tools/call`, {
                tool: "tokens",
                kind: "query",
                input: {},
              });
              expect(called.status, JSON.stringify(called.body)).toBe(200);
              return called.body;
            });
          for (const actor of [actors.member, actors.admin, actors.owner])
            expect(yield* tokens(actor, imported.path)).toEqual(["synthetic-two", "synthetic-one"]);
          expect(yield* tokens(actors.member, userOnly.path)).toEqual([]);
          expect(yield* accountLinks(actors.owner, imported.path, "app")).toEqual([
            ["workspace", covered],
            ["workspace", linked],
          ]);
          expect(yield* accountLinks(actors.member, imported.path)).toEqual([]);
          expect(yield* accountLinks(actors.member, userOnly.path)).toEqual([]);
        });
        yield* upgraded;

        // Step 12 is recorded once; starting again changes nothing, its backup included.
        yield* serverControl("start");
        yield* upgraded;
      }),
    ),
  );
});
