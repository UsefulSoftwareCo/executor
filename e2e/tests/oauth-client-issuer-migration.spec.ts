import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { oauthMcpAppFiles } from "../support/authored-templates.ts";
import { withApps } from "../support/apps-release.ts";
import { TestLive, withHostedCase } from "../support/case.ts";
import { nextDataStepSummary, dataStepSummaries } from "../support/data-steps.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { beforeAppAccounts, beforeProfileRemoval } from "../support/profile-removal-rollback.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const step = "8_oauth_clients_by_issuer";

const DeployedApp = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Members = Schema.Struct({
  members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
});
const Group = Schema.Struct({ id: Schema.String, revision: Schema.String });
const Audience = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["private", "everyone"]) }),
  Schema.Struct({ kind: Schema.Literal("groups"), groups: Schema.Array(Schema.String) }),
]);
const Directory = Schema.Struct({
  clients: Schema.Array(
    Schema.Struct({
      client: Schema.Struct({
        id: Schema.String,
        clientId: Schema.String,
        issuer: Schema.NullOr(Schema.String),
      }),
      access: Schema.Struct({ audience: Audience }),
    }),
  ),
});
const Options = Schema.Struct({
  issuer: Schema.String,
  clients: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const pasted = { clientId: "synthetic-pasted-client", clientSecret: "synthetic-pasted-secret" };
const discovered = {
  clientId: "synthetic-discovered-client",
  clientSecret: "synthetic-discovered-secret",
};

const declaredAppFiles = (name: string, origin: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, oauth2, router } from "apps";

const service = defineProvider({
  name: ${JSON.stringify(name)},
  hosts: ${JSON.stringify([new URL(origin).host])},
  auth: {
    oauth: oauth2(${JSON.stringify({
      authorizationUrl: `${origin}/authorize`,
      tokenUrl: `${origin}/token`,
      scopes: [],
      issuer: origin,
    })}),
  },
});

export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({}) }));
`,
  },
  {
    path: "package.json",
    content: JSON.stringify({
      name: "issuer-migration-fixture",
      private: true,
      type: "module",
      dependencies: withApps({}),
    }),
  },
];

layer(TestLive, { excludeTestServices: true })("OAuth client issuer migration", (it) => {
  it.effect(scenarios.oauthClientIssuerMigration.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const owner = `organization:${actors.organization.id}`;
        const log = `${target.directory}/server.log`;
        const suffix = randomUUID().slice(0, 8);

        const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files,
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(DeployedApp, deployed);
            const access = yield* body(
              Schema.Struct({ revision: Schema.String }),
              yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
            );
            const shared = yield* api.request(
              actors.owner,
              "PATCH",
              `${prefix}/apps/${app.id}/access`,
              { audience: { kind: "everyone" }, revision: access.revision },
            );
            expect(shared.status, JSON.stringify(shared.body)).toBe(200);
            return app.requirements.accounts.service.provider;
          });
        const first = yield* deploy(
          `Pasted A ${suffix}`,
          declaredAppFiles(`Pasted A ${suffix}`, issuer.origin),
        );
        const second = yield* deploy(
          `Pasted B ${suffix}`,
          declaredAppFiles(`Pasted B ${suffix}`, issuer.origin),
        );
        const third = yield* deploy(
          `Discovered ${suffix}`,
          oauthMcpAppFiles(`Discovered ${suffix}`, `${issuer.origin}/mcp`),
        );

        const members = (yield* body(
          Members,
          yield* api.request(actors.owner, "GET", `${prefix}/groups`),
        )).members;
        const createGroup = (name: string, member: string) =>
          api
            .request(actors.owner, "POST", `${prefix}/groups`, {
              name,
              description: "",
              memberIds: [member],
            })
            .pipe(Effect.flatMap((response) => body(Group, response)));
        const userOf = (session: typeof actors.owner) =>
          api
            .request(session, "GET", "/api/viewer")
            .pipe(
              Effect.flatMap((response) =>
                body(Schema.Struct({ userId: Schema.String }), response),
              ),
            );
        const ownerUser = (yield* userOf(actors.owner)).userId;
        const memberUser = (yield* userOf(actors.member)).userId;
        const ownerMember = members.find((entry) => entry.userId === ownerUser);
        const memberMember = members.find((entry) => entry.userId === memberUser);
        if (ownerMember === undefined || memberMember === undefined)
          return yield* Effect.die("Synthetic members missing");
        const groupA = yield* createGroup(`Pasted A users ${suffix}`, ownerMember.id);
        const groupB = yield* createGroup(`Pasted B users ${suffix}`, memberMember.id);

        const ids = {
          a: `oac_legacy_a_${suffix}`,
          b: `oac_legacy_b_${suffix}`,
          c: `oac_legacy_c_${suffix}`,
        };
        const legacyDigest = (provider: string, details: typeof pasted) => ({
          fingerprint: {
            purpose: "oauth client credentials",
            value: JSON.stringify([owner, provider, details.clientId, details.clientSecret]),
          },
        });
        const secretOf = (id: string, details: typeof pasted) => ({
          sealed: {
            id,
            value: { client_id: details.clientId, client_secret: details.clientSecret },
          },
        });
        const seen = (yield* dataStepSummaries(log, step)).length;
        const [current] = yield* legacyStorage([
          { sql: `SELECT value FROM private_executor_settings WHERE key = 'version'` },
          { sql: `DROP INDEX executor_stored_oauth_clients_owner_issuer` },
          ...beforeAppAccounts(),
          ...beforeProfileRemoval(),
          {
            sql: `ALTER TABLE executor_stored_oauth_clients DROP COLUMN issuer,
              ALTER COLUMN provider DROP DEFAULT, ALTER COLUMN provider SET NOT NULL`,
          },
          {
            sql: `ALTER TABLE executor_stored_oauth_client_credentials
              ALTER COLUMN provider DROP DEFAULT, ALTER COLUMN provider SET NOT NULL`,
          },
          { sql: `UPDATE private_executor_settings SET value = '4.0.11' WHERE key = 'version'` },
          {
            sql: `INSERT INTO executor_stored_oauth_clients
              (id, owner, provider, client_id, source, has_secret, automatic_key, confirmed, encrypted, created_at)
              VALUES ($1, $4, $5, $8, 'manual', true, NULL, false, $10, now() - interval '3 hours'),
                ($2, $4, $6, $8, 'manual', true, NULL, true, $11, now() - interval '2 hours'),
                ($3, $4, $7, $9, 'manual', true, NULL, false, $12, now() - interval '1 hour')`,
            params: [
              ids.a,
              ids.b,
              ids.c,
              owner,
              first,
              second,
              third,
              pasted.clientId,
              discovered.clientId,
              secretOf(ids.a, pasted),
              secretOf(ids.b, pasted),
              secretOf(ids.c, discovered),
            ],
          },
          {
            sql: `INSERT INTO executor_stored_oauth_client_credentials (id, owner, provider, client, created_at)
              VALUES ($1, $4, $5, $8, now()), ($2, $4, $6, $9, now()), ($3, $4, $7, $10, now())`,
            params: [
              legacyDigest(first, pasted),
              legacyDigest(second, pasted),
              legacyDigest(third, discovered),
              owner,
              first,
              second,
              third,
              ids.a,
              ids.b,
              ids.c,
            ],
          },
          {
            sql: `INSERT INTO hosted_oauth_client_access (client_id, organization_id, creator_id, audience)
              VALUES ($1, $4, NULL, 'groups'), ($2, $4, NULL, 'groups'), ($3, $4, NULL, 'everyone')`,
            params: [ids.a, ids.b, ids.c, actors.organization.id],
          },
          {
            sql: `INSERT INTO hosted_oauth_client_groups (organization_id, client_id, group_id)
              VALUES ($1, $2, $3), ($1, $4, $5)`,
            params: [actors.organization.id, ids.a, groupA.id, ids.b, groupB.id],
          },
        ]);
        yield* serverControl("data-steps", 200, { mode: "apply" });
        yield* serverControl("start");

        const summary = yield* nextDataStepSummary(log, step, seen);
        expect(summary).toMatchObject({
          mode: "apply",
          status: "complete",
          outcomes: { migrated: 1, merged: 1, issuer_unknown: 1 },
        });

        const directory = yield* body(
          Directory,
          yield* api.request(actors.admin, "GET", `${prefix}/oauth-clients`),
        );
        const listed = new Map(directory.clients.map((entry) => [entry.client.id, entry]));
        expect(listed.get(ids.a)?.client).toEqual({
          id: ids.a,
          clientId: pasted.clientId,
          issuer: issuer.origin,
        });
        const audience = listed.get(ids.a)?.access.audience;
        expect(audience?.kind).toBe("groups");
        expect(audience?.kind === "groups" ? [...audience.groups].sort() : []).toEqual(
          [groupA.id, groupB.id].sort(),
        );
        expect(listed.has(ids.b)).toBe(false);
        expect(listed.get(ids.c)?.client).toEqual({
          id: ids.c,
          clientId: discovered.clientId,
          issuer: null,
        });

        for (const session of [actors.owner, actors.member])
          for (const provider of [first, second, third])
            expect(
              yield* body(
                Options,
                yield* api.request(
                  session,
                  "GET",
                  `${prefix}/providers/${provider}/oauth/oauth/setup`,
                ),
              ),
            ).toEqual({ issuer: issuer.origin, clients: [{ id: ids.a }] });

        const browser = yield* Browser;
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.admin);
        yield* browser.use("Open accounts as an administrator", (page) =>
          page.goto(`/org/${actors.organization.slug}/accounts`),
        );
        yield* browser.use("Open the OAuth client manager", (page) =>
          page.getByRole("button", { name: "OAuth clients", exact: true }).click(),
        );
        yield* browser.use("The client without a server says it is not offered", (page) =>
          page
            .getByRole("list", { name: "OAuth clients" })
            .getByRole("listitem")
            .filter({ hasText: discovered.clientId })
            .getByText("Sign-in service not recorded", { exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("OAuth clients after recording their servers");

        const [version = [], credentials = [], survivor = []] = yield* legacyStorage([
          { sql: `SELECT value FROM private_executor_settings WHERE key = 'version'` },
          {
            sql: `SELECT client FROM executor_stored_oauth_client_credentials
              WHERE id = ANY(ARRAY[$1, $2, $3, $4]) ORDER BY client`,
            params: [
              legacyDigest(first, pasted),
              legacyDigest(second, pasted),
              legacyDigest(third, discovered),
              {
                fingerprint: {
                  purpose: "oauth client credentials by issuer",
                  value: JSON.stringify([
                    owner,
                    issuer.origin,
                    pasted.clientId,
                    pasted.clientSecret,
                  ]),
                },
              },
            ],
          },
          {
            sql: `SELECT confirmed, provider FROM executor_stored_oauth_clients WHERE id = $1`,
            params: [ids.a],
          },
        ]);
        yield* serverControl("start");
        expect(version, "every step from 4.0.11 ran to the current version").toEqual(current);
        expect(credentials).toEqual([
          { client: ids.a },
          { client: ids.a },
          { client: ids.a },
          { client: ids.c },
        ]);
        expect(survivor).toEqual([{ confirmed: true, provider: first }]);
      }),
    ),
  );
});
