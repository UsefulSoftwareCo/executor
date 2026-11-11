/**
 * Accounts could once be shared with groups. Upgrading grants nobody the use of such an account:
 * it stays saved for its creator and the organization's admins to delete, the group's members stop
 * using it, and a sign-in that was pending for a group-shared account is refused instead of
 * completing as an account for the whole organization. A second start changes nothing.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { accountLinks, linkAccount } from "../support/app-accounts.ts";
import { appLinksFixture, keyProvider } from "../support/app-links.ts";
import { body } from "../support/api.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, defineProvider, object, router, secrets, string } from "apps";
const service = ${keyProvider("Group account fixture")};
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({}) }));`;
const Access = Schema.Struct({
  ownership: Schema.Struct({ kind: Schema.String }),
  canManage: Schema.Boolean,
  canUse: Schema.Boolean,
});

layer(TestLive, { excludeTestServices: true })("Legacy group accounts", (it) => {
  it.effect(scenarios.legacyGroupAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, path, ids, start, submit, connect, group } =
          yield* appLinksFixture([{ path: "index.ts", content: source }]);
        // The fixture's cleanup needs the product, which a legacy write leaves stopped.
        yield* Effect.addFinalizer(() => serverControl("start").pipe(Effect.orDie));
        const team = yield* group([ids.member]);
        const account = yield* connect(actors.owner, "user", "service", "synthetic-team", {
          kind: "shared",
        });
        yield* linkAccount(actors.member, path, "service", account);
        expect(yield* accountLinks(actors.member, path)).toEqual([["service", account]]);
        const started = yield* start(actors.member, "user", "service", { kind: "shared" });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const pending = (yield* body(Resource, started)).id;

        // The rows an older server wrote: the account shared with the member's group only, and
        // the member's sign-in waiting to create another one, before step 10 ran. The migrator runs
        // only steps after the latest one recorded, so every later step is pending again too.
        yield* legacyStorage([
          {
            sql: `UPDATE hosted_account_access SET audience = 'groups' WHERE account_id = $1`,
            params: [account],
          },
          {
            sql: `INSERT INTO hosted_account_groups (organization_id, account_id, group_id)
              VALUES ($1, $2, $3)`,
            params: [actors.organization.id, account, team.id],
          },
          {
            sql: `UPDATE hosted_connection_access SET destination = $2::jsonb
              WHERE connection_id = $1`,
            params: [
              pending,
              JSON.stringify({
                kind: "shared",
                audience: { kind: "groups", groups: [team.id] },
              }),
            ],
          },
          { sql: `DELETE FROM private_hosted_migrations WHERE migration_id >= 10` },
        ]);
        yield* serverControl("start");

        const upgraded = Effect.gen(function* () {
          // The group's member no longer uses the account: it leaves their links and their reads.
          expect(yield* accountLinks(actors.member, path)).toEqual([]);
          expect(
            (yield* api.request(actors.member, "GET", `${prefix}/accounts/${account}`)).status,
          ).toBe(403);
          // Nobody gained it either. Its creator still manages it.
          expect(yield* accountLinks(actors.owner, path)).toEqual([]);
          expect(
            yield* body(
              Access,
              yield* api.request(actors.owner, "GET", `${prefix}/accounts/${account}/access`),
            ),
          ).toEqual({ ownership: { kind: "shared" }, canManage: true, canUse: false });
          // The pending sign-in is refused, so it saves no account for the organization.
          const refused = yield* submit(actors.member, pending, "synthetic-group");
          expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        });
        yield* upgraded;

        // Step 10 is recorded once and removed the sign-in's access record. Starting again
        // changes nothing.
        expect(
          yield* legacyStorage([
            {
              sql: `SELECT name FROM private_hosted_migrations WHERE migration_id = 10`,
            },
            {
              sql: `SELECT connection_id FROM hosted_connection_access WHERE connection_id = $1`,
              params: [pending],
            },
          ]),
        ).toEqual([[{ name: "group_account_connections" }], []]);
        yield* serverControl("start");
        yield* upgraded;

        // The creator deletes the account nobody can use.
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`)).status,
        ).toBe(200);
      }),
    ),
  );
});
