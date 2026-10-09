/**
 * The one-off seed of the role hosts' connection resources (`notes/cloud-domains.md`) against the
 * managed Cloud's own disposable database. Connections come from the product API; the removed
 * organization's connection is a row this scenario owns. The Cloud database is shared, so the seed
 * runs with role hosts unique to this run: every resource it inserts carries them, and the scenario
 * deletes them all afterwards. Other scenarios' rows are only ever read.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { ConnectionView } from "../support/mcp-connections.ts";
import { Target } from "../support/platform.ts";
import { roleHost } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

type Param = string | number | boolean | null;
interface Statement {
  readonly sql: string;
  readonly params?: ReadonlyArray<Param>;
}
const DatabaseConfiguration = Schema.fromJsonString(Schema.Struct({ database: Schema.String }));
const Summary = Schema.fromJsonString(
  Schema.Struct({
    mode: Schema.Literals(["report", "apply"]),
    mcpOrigins: Schema.Array(Schema.String),
    connections: Schema.Record(Schema.String, Schema.Number),
    resources: Schema.Number,
  }),
);
/** A connection's resource in each approval mode, as `mcpOAuthResources` names them. */
const connectionResources = (at: string, connection: string) =>
  [
    `${at}/mcp?connection=${connection}`,
    `${at}/mcp?connection=${connection}&elicitation_mode=native`,
    `${at}/mcp?connection=${connection}&elicitation_mode=browser`,
  ].toSorted();
const Resource = Schema.Record(Schema.String, Schema.Unknown);

layer(HostedLive, { excludeTestServices: true })("Role host resource seed", (it) => {
  it.effect(scenarios.cloudRoleHostResourceSeed.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target,
          fs = yield* FileSystem.FileSystem,
          processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const origin = target.metadata.origin;
        // The seed's role hosts take the deployment origin's scheme and port.
        const domain = `seed-${randomBytes(6).toString("hex")}.example.test`;
        const seedDeployment = new URL(origin);
        seedDeployment.hostname = domain;
        const roleOrigin = roleHost(seedDeployment.origin, "mcp");
        const configuration = `${target.directory}/sso-database.json`;
        const { database } = yield* Schema.decodeUnknownEffect(DatabaseConfiguration)(
          yield* fs.readFileString(configuration),
        );

        /** Apply statements in one transaction against the managed Cloud's own database. */
        const rows = (statements: ReadonlyArray<Statement>) =>
          Effect.gen(function* () {
            const file = `${target.directory}/seed-rows-${randomBytes(6).toString("hex")}.json`;
            yield* fs.writeFileString(file, JSON.stringify(statements), { mode: 0o600 });
            const output = yield* processes
              .string(
                ChildProcess.make(
                  "node",
                  [
                    "apps/hosted/testing/cloud-rows-fixture.ts",
                    "--configuration",
                    configuration,
                    "--statements",
                    file,
                  ],
                  { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, extendEnv: false },
                ),
              )
              .pipe(Effect.ensuring(fs.remove(file).pipe(Effect.ignore)));
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Array(Schema.Array(Resource))),
            )(output);
          });
        /** Every stored resource row of one connection, at both MCP origins, in a stable order. */
        const resourcesOf = (connection: string) =>
          rows([
            {
              sql: `select * from "oauthResource" where identifier = any($1::text[])
                order by identifier`,
              params: [
                `{${[origin, roleOrigin]
                  .flatMap((at) => connectionResources(at, connection))
                  .map((identifier) => JSON.stringify(identifier))
                  .join(",")}}`,
              ],
            },
          ]).pipe(Effect.map((result) => result[0] ?? []));
        const identifiers = (resources: ReadonlyArray<Record<string, unknown>>) =>
          resources.map((resource) => String(resource.identifier));
        const atRoleHost = (resources: ReadonlyArray<Record<string, unknown>>) =>
          identifiers(resources).filter((identifier) => identifier.startsWith(`${roleOrigin}/`));

        /** The operator's script, with the deployment's settings and synthetic sign-in clients. */
        const seed = (args: ReadonlyArray<string>, roleHostsDomain: string | undefined) =>
          ChildProcess.make(
            "node",
            ["apps/hosted/cloud/scripts/seed-role-host-resources.ts", ...args],
            {
              env: {
                PATH: process.env.PATH ?? "",
                DATABASE_URL: database,
                BETTER_AUTH_URL: origin,
                BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
                GOOGLE_CLIENT_ID: "synthetic-google-client",
                GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
                GITHUB_CLIENT_ID: "synthetic-github-client",
                GITHUB_CLIENT_SECRET: "synthetic-github-secret",
                ...(roleHostsDomain === undefined
                  ? {}
                  : { EXECUTOR_ROLE_HOSTS_DOMAIN: roleHostsDomain }),
              },
              extendEnv: false,
            },
          );
        const summary = (args: ReadonlyArray<string>) =>
          processes
            .string(seed(args, domain))
            .pipe(
              Effect.flatMap((output) =>
                Schema.decodeUnknownEffect(Summary)(output.trim().split("\n").at(-1) ?? ""),
              ),
            );

        const removedConnection = randomUUID();
        yield* Effect.addFinalizer(() =>
          rows([
            {
              sql: `delete from "oauthResource" where identifier like $1`,
              params: [`${roleOrigin}/%`],
            },
            { sql: `delete from "mcpConnection" where id = $1`, params: [removedConnection] },
          ]).pipe(Effect.orDie),
        );

        // A live connection and a revoked one, created and revoked through the product.
        const prefix = `/api/organizations/${actors.organization.id}/mcp-connections`;
        const create = Effect.gen(function* () {
          const created = yield* api.request(actors.owner, "POST", prefix, {
            id: randomUUID(),
            name: `Seed ${randomUUID().slice(0, 6)}`,
            apps: [],
          });
          expect(created.status, JSON.stringify(created.body)).toBe(200);
          const connection = yield* body(ConnectionView, created);
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "POST", `${prefix}/${connection.id}/revoke`)
              .pipe(Effect.orDie),
          );
          return connection;
        });
        const live = yield* create;
        const revoked = yield* create;
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/${revoked.id}/revoke`)).status,
        ).toBe(200);
        // A connection whose organization no longer exists.
        const session = yield* body(
          Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
          yield* api.request(actors.owner, "GET", "/api/auth/get-session"),
        );
        yield* rows([
          {
            sql: `insert into "mcpConnection" (id, "userId", resource, name, policy, revoked, "createdAt", "updatedAt")
              values ($1, $2, $3, 'Seed removed organization', '{"apps":[]}', false, now(), now())`,
            params: [
              removedConnection,
              session.user.id,
              `org-removed-${randomBytes(6).toString("hex")}`,
            ],
          },
        ]);

        // The product created the live connection's resources at the origins it serves, which do
        // not include this run's role hosts.
        const before = yield* resourcesOf(live.id);
        expect(identifiers(before).toSorted()).toEqual(connectionResources(origin, live.id));

        // Without role hosts the seed refuses and writes nothing.
        expect(yield* processes.exitCode(seed([], undefined))).not.toBe(0);
        expect(yield* processes.exitCode(seed(["--apply"], "not a hostname"))).not.toBe(0);
        expect(yield* resourcesOf(live.id)).toEqual(before);

        // A report counts what is missing and writes nothing.
        const report = yield* summary([]);
        expect(report.mode).toBe("report");
        // `mcp.` is canonical; the deployment origin keeps its resources beside it.
        expect(report.mcpOrigins).toEqual([roleOrigin, origin]);
        expect(report.connections.missing ?? 0).toBeGreaterThanOrEqual(1);
        expect(report.resources).toBeGreaterThanOrEqual(3);
        expect(yield* resourcesOf(live.id)).toEqual(before);

        // Applying adds the live connection's role host resources and keeps its existing rows.
        const applied = yield* summary(["--apply"]);
        expect(applied.mode).toBe("apply");
        expect(applied.connections.seeded ?? 0).toBeGreaterThanOrEqual(1);
        expect(applied.connections.revoked ?? 0).toBeGreaterThanOrEqual(1);
        expect(applied.connections["organization removed"] ?? 0).toBeGreaterThanOrEqual(1);
        const after = yield* resourcesOf(live.id);
        expect(atRoleHost(after).toSorted()).toEqual(connectionResources(roleOrigin, live.id));
        expect(after.filter((resource) => atRoleHost([resource]).length === 0)).toEqual(before);
        // The new rows carry the same policy a new connection's resources get.
        for (const resource of after)
          expect(
            { allowedScopes: resource.allowedScopes, disabled: resource.disabled },
            String(resource.identifier),
          ).toEqual({ allowedScopes: before[0]?.allowedScopes, disabled: false });
        // Skipped connections get nothing.
        expect(atRoleHost(yield* resourcesOf(revoked.id))).toEqual([]);
        expect(atRoleHost(yield* resourcesOf(removedConnection))).toEqual([]);

        // A second run inserts nothing for these connections and changes no row.
        yield* summary(["--apply"]);
        expect(yield* resourcesOf(live.id)).toEqual(after);
        expect(atRoleHost(yield* resourcesOf(revoked.id))).toEqual([]);
        expect(atRoleHost(yield* resourcesOf(removedConnection))).toEqual([]);
      }),
    ),
  );
});
