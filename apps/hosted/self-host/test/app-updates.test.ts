import {
  fullAuthority,
  selectedAuthority,
  type AuthorizationPolicy,
} from "@executor-js/authorization";
import { SqlClient } from "effect/unstable/sql";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import { OrganizationId as ReferenceOrganizationId } from "@executor-js/hosted-server";
import { gitSourceStorage } from "@executor-js/app-source";
import { nativeRepositories } from "@executor-js/app-source/node";
import { remoteRegistry } from "@executor-js/app-registry";
import { AppManagementHost } from "@executor-js/app-management";
/** Hosted source/update/activation through real HTTP contracts, PGlite and Node-built apps. */
import { WebhookSubscription, WebhookSetupView } from "@executor-js/sdk/core";
import { OpenApi } from "effect/unstable/httpapi";
import { HostedApi } from "@executor-js/hosted-server/contracts";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Redacted, Ref, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { pgliteLayer } from "fumadb-effect/pglite";
import {
  AppNotFound,
  SourceFiles,
  SourceSnapshot,
  AppDeploymentChanged,
  DeploymentBuildFailed,
  DeploymentNotFound,
  App,
  Deployment,
  DeploymentSummary,
  OwnerId,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
} from "@executor-js/sdk/core";
import { nodeRuntime } from "@executor-js/sdk/node";
import {
  OrganizationDefaults,
  Authentication,
  ApiAuthentication,
  HostedCatalog,
  HostedExecutor,
  requireOrganizationLive,
  requireUserLive,
  OrganizationIcons,
  makeOrganizationIcons,
} from "@executor-js/hosted-server";
import { Principal } from "../../server/src/contracts/auth.ts";
import { hostedHandlers } from "@executor-js/hosted-server";
import { HttpApiBuilder } from "effect/unstable/httpapi";

// This legacy fixture exercises shared handlers; full product composition is verified in e2e.
const selfHostApi = HttpApiBuilder.layer(HostedApi).pipe(Layer.provide(hostedHandlers));

const origin = "http://localhost:4400";
const source = (version: string) =>
  [
    {
      path: "index.ts",
      content: `import { query, mutation, defineApp, defineProvider, secrets, object, string } from "apps";
const service = defineProvider({ name: "Fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { service } }, async (appContext) => {
    const { accounts } = appContext;
    return ({
         webhooks: { manual: { account: "service", config: object({}), state: object({}), setup: { instructions: "Configure the provider.", signingSecret: "executor" }, async handle() { return new Response(null, {status: 204}); } } }, mutations: { version: mutation({ description: "Version",
                input: object({}) }, async (operationContext, _input) => {
                return ({ version: "${version}", account: accounts.service.id });
            }) }
    });
});
`,
    },
  ] as const;

test(
  "hosted apps update and roll back without losing accounts, and reject unauthorized or stale changes",
  { timeout: 60_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "hosted-app-updates-" });
          const storage = yield* makeExecutorStorage({ provider: "postgresql" });
          yield* storage.migrate;
          const credentials = yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto);
          const repositories = nativeRepositories(`${directory}/repositories`);
          const sources = gitSourceStorage(repositories);
          const blobs = memoryBlobStore();
          const executor = yield* createExecutor({
            webhookOrigin: origin,
            blobs,
            sources,
            storage,
            credentials,
            runtime: nodeRuntime({ workDirectory: directory }),
          });
          const role = yield* Ref.make<"admin" | "member">("admin");
          const signedIn = yield* Ref.make(true);
          const authority = yield* Ref.make<AuthorizationPolicy>(fullAuthority);
          const principal = Schema.decodeUnknownSync(Principal)({
            userId: "fixture",
            sessionId: "fixture",
            name: "Fixture",
          });
          const auth = Layer.succeed(Authentication, {
            origin,
            organization: (reference) => Effect.succeed(ReferenceOrganizationId.make(reference)),
            organizationSlug: () => Effect.succeed("alpha"),
            current: () => Ref.get(signedIn).pipe(Effect.map((yes) => (yes ? principal : null))),
            membership: () =>
              Ref.get(role).pipe(Effect.map((role) => ({ role, headers: new Headers() }))),
            removeOrganization: () => Effect.die("Organization removal is outside this fixture"),
          });
          const routes = selfHostApi.pipe(
            HttpRouter.provideRequest(
              Layer.succeed(
                AppManagementHost,
                Effect.succeed({
                  executor,
                  sources,
                  repositories,
                  blobs,
                  registry: remoteRegistry(origin),
                  publisher: undefined,
                }),
              ),
            ),
            HttpRouter.provideRequest(
              Layer.succeed(GroupDatabase, Effect.succeed(yield* SqlClient.SqlClient)),
            ),
            HttpRouter.provideRequest(Layer.succeed(HostedExecutor, Effect.succeed(executor))),
            HttpRouter.provideRequest(Layer.succeed(OrganizationDefaults, () => Effect.void)),
            HttpRouter.provideRequest(
              Layer.succeed(HostedCatalog, {
                list: Effect.succeed([]),
                prepare: () => Effect.die("No catalog in this fixture"),
                custom: () => Effect.die("This fixture does not import custom apps"),
              }),
            ),
            Layer.provide(requireUserLive),
            Layer.provide(requireOrganizationLive),
            Layer.provide(auth),
            Layer.provide(
              Layer.succeed(ApiAuthentication, {
                origin,
                authenticate: () =>
                  Effect.gen(function* () {
                    return {
                      userId: principal.userId,
                      organizationSlug: "alpha",
                      access: {
                        organization: ReferenceOrganizationId.make("alpha"),
                        owner: OwnerId.make("organization:alpha"),
                        role: yield* Ref.get(role),
                      },
                      policy: yield* Ref.get(authority),
                    };
                  }),
              }),
            ),
            HttpRouter.provideRequest(
              Layer.succeed(OrganizationIcons, makeOrganizationIcons(memoryBlobStore())),
            ),
            Layer.provide(HttpServer.layerServices),
          );
          const web = yield* Effect.acquireRelease(
            Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
            (web) => Effect.promise(() => web.dispose()),
          );
          const request = (path: string, body?: unknown, organization = "alpha") =>
            Effect.promise(() =>
              web.handler(
                new Request(`${origin}/api/organizations/${organization}${path}`, {
                  method: body === undefined ? "GET" : "POST",
                  headers: { origin, "content-type": "application/json" },
                  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                }),
              ),
            );
          const read = <A>(response: Response, schema: Schema.Decoder<A>) =>
            Effect.gen(function* () {
              assert.equal(
                response.status,
                200,
                yield* Effect.promise(() => response.clone().text()),
              );
              return yield* Effect.promise(() => response.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(schema)),
              );
            });
          const rejected = (response: Response, schema: Schema.Decoder<unknown>, status: number) =>
            Effect.gen(function* () {
              assert.equal(response.status, status);
              yield* Effect.promise(() => response.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(schema)),
              );
            });
          const updateSource = (
            path: string,
            input: {
              files: typeof SourceFiles.Type;
            },
          ) =>
            Effect.gen(function* () {
              const response = yield* request(`${path}/workspace`);
              if (!response.ok) return response;
              const workspace = yield* read(response, SourceSnapshot);
              const saved = yield* request(`${path}/commits`, {
                expected: workspace.revision.commit,
                files: input.files,
                message: "Update through HTTP",
              });
              if (!saved.ok) return saved;
              const commit = yield* read(saved, SourceSnapshot);
              return yield* request(`${path}/deploy`, {
                commit: commit.revision.commit,
              });
            });
          const first = yield* read(
            yield* request("/apps/deploy", { name: "Fixture", files: source("one") }),
            Schema.toCodecJson(App),
          );
          const bearerRequest = (path: string, body?: unknown) =>
            Effect.promise(() =>
              web.handler(
                new Request(`${origin}/api/organizations/alpha${path}`, {
                  method: body === undefined ? "GET" : "POST",
                  headers: {
                    authorization: "Bearer synthetic",
                    "content-type": "application/json",
                  },
                  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                }),
              ),
            );
          yield* Ref.set(
            authority,
            selectedAuthority(["discover", "read"], {
              kind: "tools",
              apps: [{ app: first.id, tools: { kind: "all" } }],
            }),
          );
          const visible = yield* read(
            yield* bearerRequest("/apps"),
            Schema.Array(Schema.toCodecJson(App)),
          );
          assert.deepEqual(
            visible.map((app) => app.id),
            [first.id],
          );
          assert.equal((yield* bearerRequest(`/apps/${first.id}/workspace`)).status, 200);
          assert.equal(
            (yield* bearerRequest("/apps/drafts", { name: "Denied", files: source("denied") }))
              .status,
            403,
          );
          yield* Ref.set(
            authority,
            selectedAuthority(["discover", "read", "manage"], { kind: "tools", apps: [] }),
          );
          assert.deepEqual(
            yield* read(yield* bearerRequest("/apps"), Schema.Array(Schema.toCodecJson(App))),
            [],
          );
          assert.equal((yield* bearerRequest(`/apps/${first.id}/workspace`)).status, 403);
          assert.equal(
            (yield* bearerRequest("/apps/copies", { from: { app: first.id }, name: "Denied copy" }))
              .status,
            403,
          );
          assert.equal(
            (yield* bearerRequest("/app-publications/unpublish", { package: "@alpha/test" }))
              .status,
            403,
          );
          yield* Ref.set(authority, fullAuthority);
          const provider = first.requirements.accounts.service?.provider;
          assert.ok(provider);
          const account = yield* executor.accounts.add({
            owner: first.owner,
            provider,
            method: "key",
            label: "Default",
            fields: Redacted.make({ token: "synthetic" }),
          });
          const profile = yield* executor.apps.profiles.create({
            app: first.id,
            owner: first.owner,
            subject: "fixture",
            idempotencyKey: "test",
            accounts: { service: account.id },
          });
          const appPath = `/apps/${first.id}`;
          const before = yield* read(
            yield* request(`${appPath}/source`),
            Schema.toCodecJson(Deployment),
          );
          assert.deepEqual(before.files, source("one"));
          let updated = (yield* read(
            yield* updateSource(appPath, {
              files: source("two"),
            }),
            Schema.toCodecJson(Schema.Struct({ app: App })),
          )).app;
          assert.equal(updated.id, first.id);
          assert.equal(updated.code, first.code);
          assert.deepEqual(
            (yield* executor.apps.profiles.get({ app: first.id, profile: profile.id })).accounts,
            { service: account.id },
          );
          const history = yield* read(
            yield* request(`${appPath}/deployments`),
            Schema.toCodecJson(Schema.Array(DeploymentSummary)),
          );
          assert.equal(history.length, 2);
          assert.ok(history.every((item) => !("files" in item)));
          assert.deepEqual(
            (yield* read(
              yield* request(`${appPath}/source?deployment=${before.id}`),
              Schema.toCodecJson(Deployment),
            )).files,
            source("one"),
          );
          const resultSchema = Schema.Struct({ version: Schema.String, account: Schema.String });
          assert.deepEqual(
            yield* read(
              yield* request(`${appPath}/tools/call`, {
                profile: profile.id,
                tool: "mutations.version",
                input: {},
              }),
              resultSchema,
            ),
            { version: "two", account: account.id },
          );
          updated = (yield* read(
            yield* request(`${appPath}/deploy`, { files: source("raw files") }),
            Schema.toCodecJson(Schema.Struct({ app: App })),
          )).app;
          assert.deepEqual(
            (yield* executor.apps.workspace({ app: first.id })).files,
            source("two"),
          );
          yield* rejected(
            yield* updateSource(appPath, {
              files: [{ path: "index.ts", content: "export default !!!" }],
            }),
            DeploymentBuildFailed,
            422,
          );
          assert.equal(
            (yield* executor.apps.get({ app: first.id })).activeDeployment,
            updated.activeDeployment,
          );
          assert.equal((yield* executor.apps.deployments({ app: first.id })).length, 3);
          yield* rejected(
            yield* request(`${appPath}/activate`, {
              expectedDeployment: before.id,
              deployment: before.id,
            }),
            AppDeploymentChanged,
            409,
          );
          const rolled = yield* read(
            yield* request(`${appPath}/activate`, {
              expectedDeployment: updated.activeDeployment,
              deployment: before.id,
            }),
            Schema.toCodecJson(App),
          );
          assert.equal(rolled.activeDeployment, before.id);
          assert.equal(Object.hasOwn(rolled, "accounts"), false);
          assert.deepEqual(
            yield* read(
              yield* request(`${appPath}/tools/call`, {
                profile: profile.id,
                tool: "mutations.version",
                input: {},
              }),
              resultSchema,
            ),
            { version: "one", account: account.id },
          );
          // Same code lineage alone does not authorize another organization's deployment.
          const copy = yield* executor.apps.copy({
            from: first.id,
            owner: OwnerId.make("organization:beta"),
            name: "Other owner",
          });
          const foreign = yield* executor.apps.deploy({
            owner: copy.owner,
            app: copy.id,
            files: source("foreign"),
          });
          yield* rejected(
            yield* request(`${appPath}/source?deployment=${foreign.deployment.id}`),
            Schema.Union([AppNotFound, DeploymentNotFound]),
            404,
          );
          yield* rejected(
            yield* request(`${appPath}/activate`, {
              deployment: foreign.deployment.id,
              expectedDeployment: rolled.activeDeployment,
            }),
            Schema.Union([AppNotFound, DeploymentNotFound]),
            404,
          );
          assert.equal(
            (yield* read(
              yield* request(`${appPath}/deployments`),
              Schema.toCodecJson(Schema.Array(DeploymentSummary)),
            )).length,
            2,
          );
          for (const path of ["/source", "/deployments", "/webhooks", "/webhook-definitions"])
            yield* rejected(
              yield* request(appPath + path, undefined, "beta"),
              Schema.Union([AppNotFound, DeploymentNotFound]),
              404,
            );
          const manual = yield* read(
            yield* request(`${appPath}/webhooks`, { key: "manual", name: "manual", config: {} }),
            Schema.toCodecJson(WebhookSubscription),
          );
          const privatePath = `/webhook-setup/${first.id}/${manual.id}`;
          const setup = yield* read(
            yield* request(privatePath),
            Schema.toCodecJson(WebhookSetupView),
          );
          assert.equal(setup.step, "configure");
          assert.ok(
            Object.keys(OpenApi.fromApi(HostedApi).paths).some((path) =>
              path.includes("/webhook-setup/"),
            ),
          );
          const setupLink = yield* request(`${appPath}/webhooks/${manual.id}/setup-link`);
          assert.equal(setupLink.status, 200);
          assert.deepEqual(yield* Effect.promise(() => setupLink.json()), {
            url: `${origin}/org/alpha/webhooks/${first.id}/${manual.id}`,
          });
          const bearerRead = yield* Effect.promise(() =>
            web.handler(
              new Request(`${origin}/api/organizations/alpha${privatePath}`, {
                headers: { authorization: "Bearer synthetic-token" },
              }),
            ),
          );
          assert.equal(bearerRead.status, 401);
          assert.equal((yield* request(privatePath, undefined, "beta")).status, 404);
          assert.equal((yield* request(`${appPath}/webhooks`)).status, 200);
          yield* Ref.set(role, "member");
          assert.equal((yield* request(privatePath)).status, 403);
          assert.equal((yield* request(`${appPath}/webhooks`)).status, 200);
          assert.equal(
            (yield* request(`${appPath}/webhooks`, { key: "events", name: "changed", config: {} }))
              .status,
            403,
          );
          assert.equal(
            (yield* request(`${appPath}/webhooks/whk_missing/reconcile`, {})).status,
            403,
          );
          const removedHook = yield* Effect.promise(() =>
            web.handler(
              new Request(`${origin}/api/organizations/alpha${appPath}/webhooks/whk_missing`, {
                method: "DELETE",
                headers: { origin },
              }),
            ),
          );
          assert.equal(removedHook.status, 403);
          for (const path of ["/source", "/deployments"])
            assert.equal((yield* request(appPath + path)).status, 403);
          assert.equal(
            (yield* updateSource(appPath, {
              files: source("denied"),
            })).status,
            403,
          );
          assert.equal(
            (yield* request(`${appPath}/activate`, {
              expectedDeployment: rolled.activeDeployment,
              deployment: updated.activeDeployment,
            })).status,
            403,
          );
          yield* Ref.set(signedIn, false);
          assert.equal((yield* request(privatePath)).status, 401);
          assert.equal((yield* request(`${appPath}/source`)).status, 401);
          assert.equal((yield* request(`${appPath}/webhooks`)).status, 401);
        }),
      ).pipe(Effect.provide(pgliteLayer()), Effect.provide(NodeServices.layer)),
    ),
);
