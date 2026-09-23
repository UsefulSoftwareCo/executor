import { checkAccounts } from "../../server/src/implementation/access.ts";
import { ProfileId } from "@executor-js/sdk/core";
import { CurrentAuthorization } from "../../server/src/contracts/authorization.ts";
import { fullAuthority } from "@executor-js/authorization";
import { memorySourceStorage } from "@executor-js/sdk/testing";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import { SqlClient } from "effect/unstable/sql";
/** Hosted operations exercise the real Node builder, saved accounts and portable app handler. */
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, Effect, FileSystem, Redacted, Schema } from "effect";
import { selfHostDatabase } from "../src/database.ts";
import { hostedResourceLifecycle } from "../../server/src/implementation/resource-lifecycle.ts";
import { CurrentUserId } from "../../server/src/contracts/auth.ts";
import {
  CurrentOrganization,
  HostedExecutor,
  OrganizationDefaults,
  OrganizationId,
  OrganizationForbidden,
  hostedMcpBackend,
  organizationOwner,
} from "@executor-js/hosted-server";
import { defaultMcpLimits, execute, SearchResult } from "@executor-js/mcp";
import * as Apps from "../../server/src/implementation/apps.ts";
import * as Accounts from "../../server/src/implementation/accounts.ts";
import * as Tools from "../../server/src/implementation/tools.ts";
import { inventory } from "../../server/src/implementation/organization.ts";
import {
  AccountRequired,
  AccountNotFound,
  AppNotFound,
  AccountConnectionNotFound,
  AppNameTaken,
  OwnerId,
  ToolName,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
} from "@executor-js/sdk/core";
import { nodeRuntime } from "@executor-js/sdk/node";

const source = `import { query, mutation, defineApp, defineProvider, secrets, object, string } from "apps";
const service = defineProvider({ name: "Fixture", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { service } }, async (appContext) => {
    const { accounts } = appContext;
    return ({
        name: "Fixture", mutations: { greeting: mutation({ description: "A test greeting",
                input: object({ name: string() }) }, async (operationContext, input) => {
                const _ = { ...appContext, ...operationContext };
                return ({ hello: input.name, connected: accounts.service.fields.token === "synthetic-token" });
            }) }
    });
});
`;

test(
  "deploy, connect, inspect and run apps without cross-organization access",
  { timeout: 40_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "hosted-apps-" });
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const id of ["fixture-admin", "fixture-member"])
              yield* sql`insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values (${id}, ${id}, ${id + "@example.test"}, true, now(), now())`;
            for (const id of ["alpha", "beta"]) {
              yield* sql`insert into organization (id,name,slug,"createdAt") values (${id},${id},${id},now())`;
              yield* sql`insert into member (id,"organizationId","userId",role,"createdAt") values (${id + "-admin"},${id},'fixture-admin','admin',now())`;
            }
            yield* sql`insert into member (id,"organizationId","userId",role,"createdAt") values ('alpha-member','alpha','fixture-member','member',now())`;
            const storage = yield* makeExecutorStorage({ provider: "postgresql" });
            const credentials = yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto);
            const executor = yield* createExecutor({
              lifecycle: yield* hostedResourceLifecycle,
              sources: memorySourceStorage(),
              blobs: memoryBlobStore(),
              storage,
              credentials,
              runtime: nodeRuntime({ workDirectory: directory }),
            });
            yield* Effect.gen(function* () {
              const a = OwnerId.make("organization:alpha");
              const b = OwnerId.make("organization:beta");
              const app = yield* Apps.deployApp(a, {
                name: "Fixture",
                files: [{ path: "index.ts", content: source }],
              });
              assert.ok(
                Schema.is(AccountRequired)(
                  yield* Tools.listTools({ app: app.id }).pipe(Effect.flip),
                ),
              );
              assert.ok(
                Schema.is(AppNotFound)(yield* Apps.getApp(b, { app: app.id }).pipe(Effect.flip)),
              );
              assert.ok(
                Schema.is(AppNotFound)(
                  yield* Accounts.connectAccount(b, {
                    app: app.id,
                    profile: ProfileId.make("ins_missing"),
                    requirement: "service",
                  }).pipe(Effect.flip),
                ),
              );
              const profile = yield* executor.apps.profiles.create({
                app: app.id,
                owner: a,
                subject: "fixture-admin",
                idempotencyKey: "test",
                accounts: {},
              });
              const connection = yield* Accounts.connectAccount(a, {
                profile: profile.id,
                app: app.id,
                requirement: "service",
              });
              assert.ok(
                Schema.is(AccountConnectionNotFound)(
                  yield* Accounts.getConnection(b, { connection: connection.id }).pipe(Effect.flip),
                ),
              );
              const account = yield* Accounts.submitConnection(a, {
                connection: connection.id,
                method: "key",
                label: "Default",
                fields: Redacted.make({ token: "synthetic-token" }),
              });
              assert.equal(
                (yield* executor.apps.profiles.get({ app: app.id, profile: profile.id })).accounts
                  .service,
                account.id,
              );
              const catalog = yield* Tools.listTools({ app: app.id, profile: profile.id });
              assert.deepEqual(
                catalog.items.map((tool) => tool.name),
                ["mutations.greeting"],
              );
              assert.deepEqual(
                yield* Tools.callTool({
                  profile: profile.id,
                  app: app.id,
                  tool: ToolName.make("mutations.greeting"),
                  input: { name: "Ada" },
                }),
                { hello: "Ada", connected: true },
              );
              const other = yield* Apps.deployApp(b, {
                name: "Fixture",
                files: [{ path: "index.ts", content: source }],
              });
              assert.ok(
                Schema.is(AccountNotFound)(
                  yield* checkAccounts(executor, b, { service: account.id }).pipe(Effect.flip),
                ),
              );
              assert.ok(
                Schema.is(AppNameTaken)(
                  yield* Apps.deployApp(a, {
                    name: "Fixture",
                    files: [{ path: "index.ts", content: source }],
                  }).pipe(Effect.flip),
                ),
              );

              // Both hosted products use this adapter. Authority comes from this request,
              // not from model-supplied owner IDs or a privileged management credential.
              const backendFor = (organization: string, role: "admin" | "member") => {
                const id = OrganizationId.make(organization);
                return hostedMcpBackend.pipe(
                  Effect.provideService(
                    CurrentUserId,
                    role === "member" ? "fixture-member" : "fixture-admin",
                  ),
                  Effect.provideService(CurrentOrganization, {
                    organization: id,
                    owner: organizationOwner(id),
                    role,
                  }),
                );
              };
              const alpha = yield* backendFor("alpha", "admin");
              const beta = yield* backendFor("beta", "admin");
              const member = yield* backendFor("alpha", "member");
              assert.deepEqual(
                (yield* alpha.listApps()).map((app) => app.id),
                [app.id],
              );
              assert.deepEqual(
                (yield* beta.listApps()).map((app) => app.id),
                [other.id],
              );
              const input = {
                profile: profile.id,
                app: app.id,
                tool: ToolName.make("mutations.greeting"),
                input: { name: "Ada" },
              };
              assert.ok(
                Schema.is(OrganizationForbidden)(
                  yield* beta.listTools({ app: app.id }).pipe(Effect.flip),
                ),
              );
              assert.ok(
                Schema.is(OrganizationForbidden)(yield* beta.callTool(input).pipe(Effect.flip)),
              );
              assert.ok(
                Schema.is(OrganizationForbidden)(
                  yield* member.listTools({ app: app.id }).pipe(Effect.flip),
                ),
              );
              assert.ok(
                Schema.is(OrganizationForbidden)(yield* member.callTool(input).pipe(Effect.flip)),
              );
              const search = yield* execute(
                alpha,
                defaultMcpLimits,
                'return await tools.search({ query: "greeting" })',
              );
              assert.ok(search.execution.ok);
              const paths = Schema.decodeUnknownSync(SearchResult)(
                search.execution.value,
              ).items.map((item) => item.path);
              assert.equal(paths.length, 1);
              assert.equal(
                paths[0],
                `tools.${app.slug}.profiles[${JSON.stringify(profile.id)}].mutations.greeting`,
              );
              const code = `return await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(profile.id)}].mutations.greeting({ name: "Ada" })`;
              const called = yield* execute(alpha, defaultMcpLimits, code);
              assert.ok(called.execution.ok);
              assert.deepEqual(called.execution.value, { hello: "Ada", connected: true });
              const invisible = yield* execute(beta, defaultMcpLimits, code);
              assert.equal(invisible.execution.ok, false);
              assert.equal(invisible.execution.toolCalls.length, 0);
              assert.deepEqual(
                invisible.unavailableApps.map((app) => app.app),
                [],
              );
              assert.equal((yield* execute(member, defaultMcpLimits, code)).execution.ok, false);

              // Defense at execution too: even an SDK-written cross-org selection is rejected.
              const foreignProfile = yield* executor.apps.profiles.create({
                app: other.id,
                owner: other.owner,
                subject: "fixture-admin",
                idempotencyKey: "test",
                accounts: { service: account.id },
              });
              assert.ok(
                Schema.is(OrganizationForbidden)(
                  yield* beta
                    .listTools({ app: other.id, profile: foreignProfile.id })
                    .pipe(Effect.flip),
                ),
              );
              assert.ok(
                Schema.is(OrganizationForbidden)(
                  yield* beta
                    .callTool({ ...input, app: other.id, profile: foreignProfile.id })
                    .pipe(Effect.flip),
                ),
              );
              yield* Apps.removeApp(a, { app: app.id });
              assert.equal((yield* inventory(a)).accounts.length, 1);
              assert.equal((yield* inventory(a)).apps.length, 0);
            }).pipe(
              Effect.provideService(CurrentUserId, "fixture-admin"),
              Effect.provideService(CurrentAuthorization, fullAuthority),
              Effect.provideService(HostedExecutor, Effect.succeed(executor)),
              Effect.provideService(GroupDatabase, Effect.succeed(yield* SqlClient.SqlClient)),
              Effect.provideService(OrganizationDefaults, () => Effect.void),
              Effect.provideService(CurrentOrganization, {
                organization: OrganizationId.make("alpha"),
                owner: OwnerId.make("organization:alpha"),
                role: "admin",
              }),
            );
          }).pipe(
            Effect.provide(selfHostDatabase),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({
                EXECUTOR_DATA_DIR: directory,
                BETTER_AUTH_URL: "http://127.0.0.1:4400",
                BETTER_AUTH_SECRET: "synthetic-fixture-auth-secret-groups",
              }),
            ),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    ),
);
