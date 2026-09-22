import assert from "node:assert/strict";
import { migrateProvisioning } from "../../server/src/implementation/provisioning-schema.ts";
import { migrateLifecycleProvisioning } from "../../server/src/implementation/provisioning-lifecycle-schema.ts";
import { test } from "node:test";
import { betterAuth } from "better-auth";
import { Effect, Option, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { pgliteLayer } from "fumadb-effect/pglite";
import { authOptions, OrganizationId, OrganizationDefaults } from "@executor-js/hosted-server";
import { migrateHostedSchemas } from "@executor-js/hosted-server/migrations";
import {
  provision,
  drainProvisioning,
  ProvisioningFailed,
  selfHostProvisioningServices,
  teamAppPending,
} from "@executor-js/hosted-server/provisioning";
import { managedAccountKey } from "../../server/src/implementation/api-keys.ts";
import { makeAuthDatabase } from "../src/implementation/auth-database.ts";

const fixture = Effect.gen(function* () {
  const options = {
    ...authOptions({ url: "https://fixture.example.test", oauthRedirectUri: Option.none() }, []),
    database: { db: yield* makeAuthDatabase, type: "postgres" as const, transaction: true },
    secret: "synthetic-provisioning-auth-secret-32",
  };
  yield* migrateHostedSchemas(options);
  const sql = yield* SqlClient.SqlClient;
  const user = (id: string, verified = true) =>
    sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${id}, 'Fixture', ${`${id}@example.test`}, ${verified}, now(), now())`;
  const team = (id: string) =>
    sql`insert into organization (id, name, slug, "createdAt") values (${id}, 'Fixture', ${id}, now())`;
  const member = (id: string, role = "owner") =>
    sql`insert into member (id, "organizationId", "userId", role, "createdAt") values (${id}, 'team', ${id}, ${role}, now())`;
  return { options, sql, user, team, member };
});

test("lifecycle jobs commit with auth changes, survive retry, and respect current membership", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { options, sql, user, team, member } = yield* fixture;
        yield* user("owner");
        yield* user("unverified", false);
        yield* sql
          .withTransaction(team("rolled-back").pipe(Effect.andThen(Effect.fail("rollback"))))
          .pipe(Effect.flip);
        assert.equal(
          (yield* sql`select id from hosted_provisioning where organization_id = 'rolled-back'`)
            .length,
          0,
        );
        yield* team("team");
        const pending = teamAppPending(OrganizationId.make("team"));
        assert.equal(yield* pending, true);
        for (const status of ["running", "failed", "succeeded", "queued"]) {
          yield* sql`update hosted_provisioning set status = ${status} where kind = 'team'`;
          assert.equal(yield* pending, status === "running" || status === "queued");
        }
        assert.equal(yield* teamAppPending(OrganizationId.make("missing")), false);
        yield* member("owner");
        yield* member("unverified", "admin");
        assert.equal(
          (yield* sql`select id from hosted_provisioning where kind = 'team'`).length,
          1,
        );
        assert.equal(
          (yield* sql`select id from hosted_provisioning where kind = 'user'`).length,
          1,
        );
        const before = (yield* sql`select id from hosted_provisioning`).length;
        yield* migrateHostedSchemas(options);
        const repaired = (yield* sql`select id from hosted_provisioning`).length;
        yield* migrateHostedSchemas(options);
        assert.equal((yield* sql`select id from hosted_provisioning`).length, repaired);
        assert.ok(repaired >= before);
        yield* sql`update "user" set "emailVerified" = true where id = 'unverified'`;
        assert.equal(
          (yield* sql`select id from hosted_provisioning where kind = 'user'`).length,
          2,
        );
        // A removed or downgraded member's queued job cannot mint an account.
        yield* sql`update member set role = 'member' where id = 'owner'`;
        yield* provision("member-owner", selfHostProvisioningServices).pipe(
          Effect.provideService(OrganizationDefaults, () =>
            Effect.die("Revoked member must not be provisioned"),
          ),
        );
        assert.equal(
          (yield* sql`select status from hosted_provisioning where id = 'member-owner'`)[0]?.status,
          "succeeded",
        );
        yield* sql`delete from "user" where id = 'owner'`;
        yield* sql`delete from member where "organizationId" = 'team'`;
        yield* sql`delete from organization where id = 'team'`;
        assert.equal(
          (yield* sql`select id from hosted_provisioning where organization_id = 'team'`).length,
          0,
        );
      }),
    ).pipe(Effect.provide(pgliteLayer())),
  ));

test("managed native keys roll back atomically and authenticate through Better Auth", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { options, sql, user, team } = yield* fixture;
        yield* user("owner");
        yield* team("team");
        const issue = managedAccountKey(OrganizationId.make("team"), "owner");
        yield* sql
          .withTransaction(issue.pipe(Effect.andThen(Effect.fail("rollback"))))
          .pipe(Effect.flip);
        assert.equal((yield* sql`select id from apikey`).length, 0);
        const token = yield* sql.withTransaction(issue);
        const auth = betterAuth(options);
        const verified = yield* Effect.promise(() =>
          auth.api.verifyApiKey({ body: { key: Redacted.value(token) } }),
        );
        assert.equal(verified.valid, true);
        assert.equal(verified.key?.referenceId, "owner");
        assert.deepEqual(verified.key?.metadata, { organization: "team" });
        assert.equal((yield* sql`select id from apikey`).length, 1);
      }),
    ).pipe(Effect.provide(pgliteLayer())),
  ));

test("self-host recovers interrupted jobs and backs off failed attempts independently", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, team } = yield* fixture;
        yield* team("team");
        yield* sql`create table completed_setup (organization_id text primary key)`;
        yield* sql`update hosted_provisioning set status = 'running', attempts = 2, updated_at = now() - interval '20 minutes' where kind = 'team'`;
        let billingAvailable = false;
        const services = {
          ...selfHostProvisioningServices,
          billing: () => (billingAvailable ? Effect.void : Effect.fail(new ProvisioningFailed())),
        };
        const drain = drainProvisioning(services).pipe(
          Effect.provideService(OrganizationDefaults, (organization) =>
            sql`insert into completed_setup values (${organization}) on conflict do nothing`.pipe(
              Effect.asVoid,
              Effect.orDie,
            ),
          ),
        );
        yield* drain;
        assert.equal((yield* sql`select * from completed_setup`).length, 1);
        assert.equal(
          (yield* sql`select attempts from hosted_provisioning where kind = 'team'`)[0]?.attempts,
          3,
        );
        assert.equal(
          (yield* sql`select status from hosted_provisioning where kind = 'domain'`)[0]?.status,
          "succeeded",
        );
        assert.equal(
          (yield* sql`select status from hosted_provisioning where kind = 'billing'`)[0]?.status,
          "queued",
        );
        assert.equal(
          (yield* sql`select available_at > now() as delayed from hosted_provisioning where kind = 'billing'`)[0]
            ?.delayed,
          true,
        );
        billingAvailable = true;
        yield* sql`update hosted_provisioning set available_at = now() where kind = 'billing'`;
        yield* drain;
        yield* drain;
        assert.equal(
          (yield* sql`select status from hosted_provisioning where kind = 'billing'`)[0]?.status,
          "succeeded",
        );
        assert.equal(
          (yield* sql`select attempts from hosted_provisioning where kind = 'billing'`)[0]
            ?.attempts,
          2,
        );
        assert.equal((yield* sql`select * from completed_setup`).length, 1);
      }),
    ).pipe(Effect.provide(pgliteLayer())),
  ));

test("lifecycle migration upgrades the default-app queue without losing jobs or emailing existing users", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { options, sql, user, team, member } = yield* fixture;
        // This database is disposable. Start with the actual lower-layer migration.
        yield* sql`drop table hosted_provisioning`;
        yield* migrateProvisioning;
        yield* user("existing");
        yield* team("team");
        yield* member("existing");
        yield* sql`update hosted_provisioning set status = 'succeeded' where kind = 'team'`;
        const before = yield* sql`select id, kind, status from hosted_provisioning order by id`;
        assert.equal(before.length, 2);
        yield* migrateLifecycleProvisioning;
        assert.deepEqual(
          yield* sql`select id, kind, status from hosted_provisioning order by id`,
          before,
        );
        yield* user("new");
        yield* team("later");
        yield* member("new");
        assert.equal(
          (yield* sql`select id from hosted_provisioning where kind = 'user'`).length,
          1,
        );
        assert.equal(
          (yield* sql`select id from hosted_provisioning where kind = 'billing'`).length,
          2,
        );
        assert.equal(
          (yield* sql`select id from hosted_provisioning where kind = 'domain'`).length,
          1,
        );
        yield* sql`update organization set slug = 'renamed' where id = 'team'`;
        yield* sql`delete from member where id = 'new'`;
        assert.equal(
          (yield* sql`select id from hosted_provisioning where kind = 'billing'`).length,
          3,
        );
        assert.equal(
          (yield* sql`select id from hosted_provisioning where kind = 'domain'`).length,
          2,
        );
        yield* migrateHostedSchemas(options);
        const repaired = (yield* sql`select id from hosted_provisioning`).length;
        yield* migrateHostedSchemas(options);
        assert.equal((yield* sql`select id from hosted_provisioning`).length, repaired);
        assert.equal(
          (yield* sql`select id from hosted_provisioning where kind = 'user'`).length,
          1,
        );
        assert.equal(
          (yield* sql`select status from hosted_provisioning where id = 'team-team'`)[0]?.status,
          "succeeded",
        );
      }),
    ).pipe(Effect.provide(pgliteLayer())),
  ));
