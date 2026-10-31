/**
 * Before every connection had to name an app, provider-only requests, account-level reconnects
 * and 1.3.0-era requests were stored without a target: SQL null when a server wrote it, JSON null
 * when the column's default filled it. Upgrading deletes those requests and the pending sign-ins
 * they point at, makes the target required, and keeps every connection that has a target. A
 * second start finds nothing left to do.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { TestLive, withCase, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { beforeAppAccounts, beforeProfileRemoval } from "../support/profile-removal-rollback.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { localLinks } from "../support/local-links.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, defineProvider, object, router, secrets, string } from "apps";
const service = defineProvider({ name: "Targeted fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({}) }));`;
const Link = Schema.Struct({ connection: Schema.String, url: Schema.String });

interface Statement {
  readonly sql: string;
  readonly params?: ReadonlyArray<string | number | boolean | null>;
}
/** The rows an older server left, copied from the targeted connection's owner and provider. */
const legacyRows = (template: string, ids: Ids): [Statement, ...Statement[]] => [
  // The layout before 4.0.8: a nullable target whose default is JSON null, and none of the
  // tables, columns and triggers later steps add.
  {
    sql: `ALTER TABLE executor_account_connections
      ALTER COLUMN target DROP NOT NULL, ALTER COLUMN target SET DEFAULT 'null'::json`,
  },
  // Nor the scopes app accounts added since, which connections record with their target.
  ...beforeAppAccounts(),
  {
    sql: `UPDATE executor_account_connections SET target = (target::jsonb - 'scope')::json
      WHERE id = $1`,
    params: [template],
  },
  {
    sql: `DROP TABLE executor_tool_search, executor_tool_search_definitions, executor_tool_search_listings`,
  },
  {
    sql: `DROP TABLE executor_stored_oauth_client_credentials, executor_stored_oauth_clients`,
  },
  ...beforeProfileRemoval({ toolSearch: false }),
  { sql: `UPDATE private_executor_settings SET value = '4.0.7' WHERE key = 'version'` },
  {
    sql: `INSERT INTO executor_oauth_attempts (id, encrypted, expires_at, status)
      VALUES ($1, decode('00', 'hex'), now() + interval '30 minutes', 'pending'),
        ($2, decode('00', 'hex'), now() + interval '30 minutes', 'pending')`,
    params: [ids.attempt, ids.unrelatedAttempt],
  },
  // A provider-only request in the middle of its sign-in.
  {
    sql: `INSERT INTO executor_account_connections
      (id, owner, provider, reconnect_account, state, revision, oauth_attempt, created_at, expires_at, target)
      SELECT $2, owner, provider, NULL, '{"status":"pending"}', 'legacy', $3, created_at, expires_at, NULL
      FROM executor_account_connections WHERE id = $1`,
    params: [template, ids.pending, ids.attempt],
  },
  // An account-level reconnect.
  {
    sql: `INSERT INTO executor_account_connections
      (id, owner, provider, reconnect_account, state, revision, oauth_attempt, created_at, expires_at, target)
      SELECT $2, owner, provider, 'acc_legacy_reconnected', '{"status":"pending"}', 'legacy', NULL, created_at, expires_at, NULL
      FROM executor_account_connections WHERE id = $1`,
    params: [template, ids.reconnect],
  },
  // A 1.3.0-era request, whose target the column default filled with JSON null.
  {
    sql: `INSERT INTO executor_account_connections
      (id, owner, provider, reconnect_account, state, revision, oauth_attempt, created_at, expires_at)
      SELECT $2, owner, provider, NULL, '{"status":"cancelled"}', 'legacy', NULL, created_at, expires_at
      FROM executor_account_connections WHERE id = $1`,
    params: [template, ids.defaulted],
  },
];

interface Ids {
  readonly pending: string;
  readonly reconnect: string;
  readonly defaulted: string;
  readonly attempt: string;
  readonly unrelatedAttempt: string;
}
const legacyIds = (): Ids => {
  const suffix = randomUUID();
  return {
    pending: `con_legacy_pending_${suffix}`,
    reconnect: `con_legacy_reconnect_${suffix}`,
    defaulted: `con_legacy_defaulted_${suffix}`,
    attempt: `oauth_legacy_targetless_${suffix}`,
    unrelatedAttempt: `oauth_legacy_unrelated_${suffix}`,
  };
};

/** What the upgrade left: the stored layout, version and the connections and sign-ins named. */
const stored = (
  template: string,
  ids: Ids,
  extra: ReadonlyArray<Statement> = [],
): [Statement, ...Statement[]] => [
  {
    sql: `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'executor_account_connections' AND column_name = 'target'`,
  },
  { sql: `SELECT value FROM private_executor_settings WHERE key = 'version'` },
  {
    sql: `SELECT id, json_typeof(target) AS target FROM executor_account_connections
        WHERE id = ANY($1::text[]) ORDER BY id`,
    params: [`{${[template, ids.pending, ids.reconnect, ids.defaulted].join(",")}}`],
  },
  {
    sql: `SELECT id FROM executor_oauth_attempts WHERE id = ANY($1::text[]) ORDER BY id`,
    params: [`{${ids.attempt},${ids.unrelatedAttempt}}`],
  },
  ...extra,
];

const expectUpgraded = (
  [column, version, connections, attempts]: ReadonlyArray<ReadonlyArray<unknown>>,
  template: string,
  ids: Ids,
) => {
  expect(column).toEqual([{ is_nullable: "NO", column_default: null }]);
  expect(version).toEqual([{ value: "4.0.24" }]);
  // Only the connection with a target is left, and only the sign-in no connection pointed at.
  expect(connections).toEqual([{ id: template, target: "object" }]);
  expect(attempts).toEqual([{ id: ids.unrelatedAttempt }]);
};

layer(TestLive, { excludeTestServices: true })("Legacy targetless connections", (it) => {
  it.effect(scenarios.legacyTargetlessConnections.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner: "local",
          name: `Targeted ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Schema.Struct({ app: Resource }), deployed);
        yield* Effect.addFinalizer(() =>
          serverControl("start").pipe(
            Effect.andThen(api.request(agent, "DELETE", `/v1/apps/${app.id}`)),
            Effect.orDie,
          ),
        );
        const { connection, url } = yield* body(
          Link,
          yield* api.request(agent, "POST", "/account-connect/api/requests", {
            owner: "local",
            target: { app: app.id, requirement: "service" },
          }),
        );
        const ids = legacyIds();
        yield* legacyStorage(legacyRows(connection, ids));
        yield* serverControl("start");

        // The connection with a target still works; the others are gone.
        expect((yield* agent.send("GET", `/v1/account-connections/${connection}`)).status).toBe(
          200,
        );
        for (const id of [ids.pending, ids.reconnect, ids.defaulted])
          expect((yield* agent.send("GET", `/v1/account-connections/${id}`)).status, id).toBe(404);
        expectUpgraded(yield* legacyStorage(stored(connection, ids)), connection, ids);

        // Starting again changes nothing.
        yield* serverControl("start");
        expectUpgraded(
          yield* legacyStorage(
            stored(connection, ids, [
              {
                sql: `DELETE FROM executor_oauth_attempts WHERE id = $1`,
                params: [ids.unrelatedAttempt],
              },
            ]),
          ),
          connection,
          ids,
        );

        // The kept connection was started before targets recorded a scope, for a profile: it
        // completes as the user's own link.
        yield* serverControl("start");
        const submitted = yield* api.request(agent, "POST", "/account-connect/api/submit", {
          connection,
          token: new URLSearchParams(new URL(url).hash.slice(1)).get("token"),
          method: "key",
          fields: { token: "synthetic-legacy-key" },
        });
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
        const account = (yield* body(Resource, submitted)).id;
        yield* Effect.addFinalizer(() =>
          api.request(agent, "DELETE", `/dashboard/api/accounts/${account}`).pipe(Effect.orDie),
        );
        expect(yield* localLinks(agent, app.id, "user")).toEqual([account]);
        expect(yield* localLinks(agent, app.id, "app")).toEqual([]);
      }),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("Legacy targetless hosted connections", (it) => {
  it.effect(scenarios.legacyTargetlessHostedConnections.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Targeted ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(Resource, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          serverControl("start").pipe(
            Effect.andThen(api.request(actors.owner, "DELETE", path)),
            Effect.orDie,
          ),
        );
        const pending = yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(path, "user", "service"),
          {},
        );
        expect(pending.status, JSON.stringify(pending.body)).toBe(200);
        const connection = (yield* body(Resource, pending)).id;
        const ids = legacyIds();
        const legacy = [ids.pending, ids.reconnect, ids.defaulted];
        yield* legacyStorage([
          // Step 9 runs again with steps 7 and 8; it creates the link table and converts profiles
          // idempotently, and none are left to convert.
          { sql: `DELETE FROM private_hosted_migrations WHERE migration_id = 9` },
          // Before step 8 no client had an audience, whose rows name stored clients.
          { sql: `DROP TABLE hosted_oauth_client_groups, hosted_oauth_client_access` },
          { sql: `DELETE FROM private_hosted_migrations WHERE migration_id = 8` },
          ...legacyRows(connection, ids),
          // Before step 7 the product's access rows could have no target either.
          { sql: `ALTER TABLE hosted_connection_access ALTER COLUMN target DROP NOT NULL` },
          {
            sql: `DELETE FROM private_hosted_migrations WHERE migration_id = 7`,
          },
          ...legacy.map((id) => ({
            sql: `INSERT INTO hosted_connection_access (connection_id, organization_id, creator_id, destination, target)
              SELECT $2, organization_id, creator_id, destination, NULL
              FROM hosted_connection_access WHERE connection_id = $1`,
            params: [connection, id],
          })),
        ]);
        yield* serverControl("start");

        const read = (id: string) =>
          api
            .request(actors.owner, "GET", `${prefix}/connections/${id}`)
            .pipe(Effect.map((response) => response.status));
        expect(yield* read(connection)).toBe(200);
        for (const id of legacy) expect(yield* read(id), id).not.toBe(200);
        const hosted = [
          {
            sql: `SELECT connection_id FROM hosted_connection_access WHERE connection_id = ANY($1::text[])`,
            params: [`{${[connection, ...legacy].join(",")}}`],
          },
          {
            sql: `SELECT is_nullable FROM information_schema.columns
              WHERE table_name = 'hosted_connection_access' AND column_name = 'target'`,
          },
          {
            sql: `SELECT count(*)::int AS runs FROM private_hosted_migrations
              WHERE migration_id = 7 AND name = 'require_connection_targets'`,
          },
        ];
        const expectHostedUpgraded = (results: ReadonlyArray<ReadonlyArray<unknown>>) => {
          expectUpgraded(results, connection, ids);
          // Access rows went with their connections, and the product then required a target.
          expect(results.slice(4, 7)).toEqual([
            [{ connection_id: connection }],
            [{ is_nullable: "NO" }],
            [{ runs: 1 }],
          ]);
        };
        expectHostedUpgraded(yield* legacyStorage(stored(connection, ids, hosted)));

        // Starting again changes nothing and records no step twice.
        yield* serverControl("start");
        expectHostedUpgraded(
          yield* legacyStorage(
            stored(connection, ids, [
              ...hosted,
              {
                sql: `DELETE FROM executor_oauth_attempts WHERE id = $1`,
                params: [ids.unrelatedAttempt],
              },
            ]),
          ),
        );
      }),
    ),
  );
});
