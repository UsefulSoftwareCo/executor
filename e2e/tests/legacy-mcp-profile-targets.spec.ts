/**
 * Local MCP connections and grants saved before profiles were removed may run as a profile. The
 * upgrade converts them once: a profile becomes the accounts that enabled profile selected, and a
 * disabled or removed profile, or one whose account is gone, permits nothing. A profile whose
 * account set became a copy of the app (SDK 4.0.13, data step `10_profile_app_copies`) runs on that
 * copy: its targets move to a clone of the entry for the copy, not to the app's own entry.
 *
 * The fixture rebuilds the database as an upgrade from 4.0.12 finds it: it undoes 4.0.14 and 4.0.13, labels
 * the database 4.0.12, makes local step `2_app_account_links` and data step 10 pending again, and
 * writes the profiles. The next start plans and creates the copies and converts the targets.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { TestLive, withCase } from "../support/case.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import {
  beforeAppAccounts,
  beforeProfileRemoval,
  profileAppCopiesPending,
} from "../support/profile-removal-rollback.ts";
import { McpClient } from "../support/mcp-client.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import { ConnectionView, consentTo, revokeClientGrants } from "../support/mcp-connections.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

const Published = Schema.Struct({ app: Schema.Struct({ id: Schema.String, slug: Schema.String }) });
const Apps = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    slug: Schema.String,
    name: Schema.String,
    owner: Schema.String,
  }),
);
const Grants = Schema.Array(
  Schema.Struct({ clientId: Schema.String, grant: Schema.Struct({ id: Schema.String }) }),
);
/** An `execute` result, keeping the failure so a refusal can be told apart from other errors. */
const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
});
const source = (
  name: string,
) => `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service } } }, async () => ({
  tools: router({ whoami: query({ input: object({}) }, async (ctx) => ctx.user.accounts.service.fields.token) }),
}));`;

layer(TestLive, { excludeTestServices: true })("Legacy MCP profile targets", (it) => {
  it.effect(scenarios.legacyMcpProfileTargets.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        // Connection links are issued to agents: a request with a browser origin is refused.
        const agent: Session = {
          ...operator,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return operator.send(method, path, data, { ...rest, ...headers });
          },
        };
        const name = `Legacy targets ${randomUUID().slice(0, 8)}`;
        const deployed = yield* operator.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name,
            files: [{ path: "index.ts", content: source(name) }, appsManifest],
          },
          headers,
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Published, deployed);
        const accounts: string[] = [];
        const copies: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* serverControl("start");
            for (const copy of copies)
              yield* operator.send("DELETE", `/v1/apps/${copy}`, undefined, headers);
            yield* operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers);
            for (const account of accounts)
              yield* operator.send("DELETE", `/v1/accounts/${account}`, undefined, headers);
          }).pipe(Effect.orDie),
        );
        // Connecting from the app links each account to the plain requirement in turn, replacing
        // the one before; the profiles below decide the links again.
        const connect = (token: string) =>
          Effect.gen(function* () {
            const account = (yield* connectLocalAccount(agent, {
              app: app.id,
              requirement: "service",
              method: "key",
              label: token,
              fields: { token },
            })).id;
            accounts.push(account);
            return account;
          });
        const first = yield* connect("synthetic-first");
        const second = yield* connect("synthetic-second");
        const third = yield* connect("synthetic-third");

        // Connections and a grant created through the product, whose stored targets are rewritten
        // below to the profile targets an older version saved. Each runs as the account linked now.
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const connection = (label: string) =>
          Effect.gen(function* () {
            const created = yield* api.request(operator, "POST", "/dashboard/api/mcp/connections", {
              id: randomUUID(),
              name: label,
              apps: [
                { app: app.id, runsAs: [{ kind: "account", id: third }], tools: { kind: "all" } },
              ],
            });
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            const view = yield* body(ConnectionView, created);
            const consent = yield* consentTo(operator, view.url);
            clients.push(consent.clientId);
            expect(consent.status).toBe(200);
            return { id: view.id, token: yield* consent.tokens };
          });
        const converted = yield* connection("Converted");
        const emptied = yield* connection("Emptied");
        const plain = yield* consentTo(operator, `${target.metadata.origin}/mcp`);
        clients.push(plain.clientId);
        expect(plain.status).toBe(200);
        const plainToken = yield* plain.tokens;
        const grant = (yield* body(
          Grants,
          yield* api.request(operator, "GET", "/api/auth/mcp/grants"),
        )).find((item) => item.clientId === plain.clientId)?.grant.id;
        if (grant === undefined) return yield* Effect.die("The plain consent issued no grant");

        // Profiles as an older version stored them: two enabled profiles selecting one account
        // each, a disabled and a removed profile selecting the third, and an enabled profile whose
        // account no longer exists.
        const profiles = {
          first: `legacy-profile-first-${randomUUID()}`,
          second: `legacy-profile-second-${randomUUID()}`,
          disabled: `legacy-profile-disabled-${randomUUID()}`,
          removed: `legacy-profile-removed-${randomUUID()}`,
          missing: `legacy-profile-missing-${randomUUID()}`,
        };
        const profile = (id: string) => ({ kind: "profile", id });
        const all = { kind: "all" };
        yield* legacyStorage(
          [
            {
              sql: `UPDATE "mcpConnection" SET policy = $2 WHERE id = $1`,
              params: [
                converted.id,
                JSON.stringify({
                  apps: [
                    {
                      app: app.id,
                      runsAs: [
                        profile(profiles.first),
                        profile(profiles.second),
                        profile(profiles.disabled),
                      ],
                      tools: all,
                    },
                  ],
                }),
              ],
            },
            {
              sql: `UPDATE "mcpConnection" SET policy = $2 WHERE id = $1`,
              params: [
                emptied.id,
                JSON.stringify({
                  apps: [
                    {
                      app: app.id,
                      runsAs: [profile(profiles.removed), profile(profiles.missing)],
                      tools: all,
                    },
                  ],
                }),
              ],
            },
            {
              sql: `UPDATE "mcpGrant" SET policy = $2 WHERE id = $1`,
              params: [
                grant,
                JSON.stringify({
                  kind: "tools",
                  apps: [
                    {
                      app: app.id,
                      tools: all,
                      targets: [profile(profiles.first), profile(profiles.disabled)],
                    },
                  ],
                  approval: "client",
                }),
              ],
            },
            // Versions with profiles never recorded the conversion step.
            { sql: `DROP TABLE executor_local_steps` },
          ],
          "mcp-auth",
        );
        const selected = (
          id: string,
          enabled: boolean,
          status: string,
          account: string,
          createdAt: string,
        ) => ({
          sql: `INSERT INTO executor_installations
            (id, app, owner, subject, name, idempotency_key, accounts, webhook_config, revision,
             enabled, status, failure, reconciled_deployment, reconciled_revision, request, lease,
             lease_until, created_at)
            VALUES ($1, $2, 'local', 'local', NULL, $1, $3, '{}', 1, $4, $5, NULL, NULL, NULL, '{}',
             NULL, TIMESTAMP '2000-01-01', $6)`,
          params: [id, app.id, JSON.stringify({ service: account }), enabled, status, createdAt],
        });
        yield* legacyStorage([
          { sql: "DELETE FROM private_local_migrations WHERE migration_id = 2" },
          ...beforeAppAccounts(),
          { sql: "DROP TABLE local_app_account_links" },
          ...beforeProfileRemoval(),
          ...profileAppCopiesPending("private_local"),
          { sql: `UPDATE private_executor_settings SET value = '4.0.12' WHERE key = 'version'` },
          // The oldest enabled profile's account set keeps the app. The second enabled profile's
          // becomes "(Profile 2)", the disabled one's "(Profile 3)" and the one whose account no
          // longer exists "(Profile 4)"; the removed profile counts for none.
          selected(profiles.first, true, "ready", first, "2000-01-01"),
          selected(profiles.second, true, "ready", second, "2000-01-02"),
          selected(profiles.disabled, false, "ready", third, "2000-01-03"),
          selected(profiles.removed, true, "removed", third, "2000-01-04"),
          selected(profiles.missing, true, "ready", "acc_legacy_missing", "2000-01-05"),
        ]);
        yield* serverControl("start");

        const listedApps = yield* body(
          Apps,
          yield* operator.send("GET", "/v1/apps", undefined, headers),
        );
        const copyOf = (label: string) => {
          const found = listedApps.find((item) => item.name === `${name} (${label})`);
          expect(found, `the copy named after ${label}`).toBeDefined();
          copies.push(found!.id);
          return found!;
        };
        const secondCopy = copyOf("Profile 2"),
          disabledCopy = copyOf("Profile 3");
        copyOf("Profile 4");

        // The connections now run as the accounts of the enabled profiles: on the app for the
        // profile whose account set kept it, and on a clone of the entry for the copy the second
        // profile's set became. One left without any account no longer includes the app.
        const listed = yield* body(
          Schema.Array(ConnectionView),
          yield* api.request(operator, "GET", "/dashboard/api/mcp/connections"),
        );
        const stored = (id: string) => listed.find((item) => item.id === id)?.policy.apps;
        const convertedApps = stored(converted.id);
        expect(
          convertedApps?.map((entry) => ({
            app: entry.app,
            tools: entry.tools,
            runsAs: entry.runsAs.map((item) => ("id" in item ? item.id : item.kind)),
          })),
        ).toEqual([
          { app: app.id, tools: all, runsAs: [first] },
          { app: secondCopy.id, tools: all, runsAs: [second] },
        ]);
        expect(stored(emptied.id)).toEqual([]);

        const execute = (
          token: Redacted.Redacted<string>,
          label: string,
          connection: string | undefined,
        ) =>
          Effect.gen(function* () {
            const client = yield* mcp.connect(
              token,
              label,
              connection === undefined ? {} : { connection },
            );
            return (operation: string, code: string) =>
              client
                .use(operation, (client, signal) =>
                  client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
                )
                .pipe(
                  Effect.flatMap((result) =>
                    Schema.decodeUnknownEffect(Execution)(result.structuredContent),
                  ),
                  Effect.map((result) => result.execution),
                );
          });
        const whoami = (slug: string) => `return await tools[${JSON.stringify(slug)}].whoami({})`;

        const run = yield* execute(converted.token, "legacy-converted", converted.id);
        expect(yield* run("Run as the first profile's account", whoami(app.slug))).toEqual({
          ok: true,
          value: "synthetic-first",
        });
        expect(
          yield* run("Run on the copy as the second profile's account", whoami(secondCopy.slug)),
        ).toEqual({ ok: true, value: "synthetic-second" });
        // The disabled profile permits nothing: its copy is not part of the connection.
        const disabled = yield* run(
          "The disabled profile's copy is refused",
          whoami(disabledCopy.slug),
        );
        expect(disabled.ok, JSON.stringify(disabled)).toBe(false);

        const none = yield* execute(emptied.token, "legacy-emptied", emptied.id);
        const refused = yield* none(
          "A connection left without targets excludes the app",
          whoami(app.slug),
        );
        expect(refused.ok, JSON.stringify(refused)).toBe(false);

        // The grant runs as the one account its enabled profile selected, on the app only.
        const granted = yield* execute(plainToken, "legacy-grant", undefined);
        expect(yield* granted("The grant runs as its profile's account", whoami(app.slug))).toEqual(
          { ok: true, value: "synthetic-first" },
        );
        const outside = yield* granted(
          "The grant does not reach a copy its profiles never became",
          whoami(secondCopy.slug),
        );
        expect(outside.ok, JSON.stringify(outside)).toBe(false);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
