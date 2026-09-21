import { GroupDatabase } from "@executor-js/hosted-server/groups";
import { AppManagementHost, AppSourceView } from "@executor-js/app-management";
import { gitSourceStorage } from "@executor-js/app-source";
import { nativeRepositories } from "@executor-js/app-source/node";
import { remoteRegistry } from "@executor-js/app-registry";
/** Shared-session regressions through real Better Auth, PGlite and hosted HTTP routes. */
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { betterAuth } from "better-auth";
import { makeSignature } from "better-auth/crypto";
import { ConfigProvider, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import {
  OrganizationDefaults,
  Authentication,
  ApiAuthentication,
  apiAuthenticationError,
  AuthenticationUnavailable,
  sessionPrincipal,
  lookupMembership,
  deleteOrganizationRecords,
  lookupOrganizationSlug,
  resolveOrganizationReference,
  authOptions,
  authSettings,
  HostedCatalog,
  HostedExecutor,
  Inventory,
  requireOrganizationLive,
  requireUserLive,
  OrganizationIcons,
  makeOrganizationIcons,
} from "@executor-js/hosted-server";
import {
  AppNameTaken,
  AppNotFound,
  AccountNotFound,
  AccountConnectionNotFound,
  Account,
  AccountConnection,
  App,
  BuildId,
  OwnerId,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
  runtimeAdapter,
} from "@executor-js/sdk/core";
import { selfHostDatabase } from "../src/database.ts";
import { AuthDatabase } from "../src/contracts/database.ts";
import { hostedHandlers } from "@executor-js/hosted-server";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HostedApi } from "@executor-js/hosted-server/contracts";

// This legacy fixture exercises shared handlers; full product composition is verified in e2e.
const selfHostApi = HttpApiBuilder.layer(HostedApi).pipe(Layer.provide(hostedHandlers));

const origin = "http://127.0.0.1:55440";
const secret = "synthetic-organization-session-secret";
const encryptionKey = "ab".repeat(32);
const Organization = Schema.Struct({ id: Schema.NonEmptyString, slug: Schema.NonEmptyString });
const Invitation = Schema.Struct({ id: Schema.NonEmptyString });

test(
  "two clients share login identity but every read and mutation keeps its explicit organization",
  { timeout: 30_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "executor-organizations-",
          });
          const configuration = ConfigProvider.fromUnknown({
            EXECUTOR_DATA_DIR: directory,
            BETTER_AUTH_URL: origin,
            BETTER_AUTH_SECRET: secret,
            EXECUTOR_ENCRYPTION_KEY: encryptionKey,
            GOOGLE_CLIENT_ID: "synthetic-google",
            GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
            GITHUB_CLIENT_ID: "synthetic-github",
            GITHUB_CLIENT_SECRET: "synthetic-github-secret",
          });
          yield* Effect.gen(function* () {
            const database = yield* AuthDatabase;
            const settings = yield* authSettings;
            const auth = betterAuth({
              ...authOptions(settings, []),
              database,
              secret,
              rateLimit: { enabled: false },
            });
            const context = yield* Effect.promise(() => auth.$context);
            const user = yield* Effect.promise(() =>
              context.internalAdapter.createUser(
                { name: "Example", email: "example@example.test", emailVerified: true },
                { method: "admin" },
              ),
            );
            const other = yield* Effect.promise(() =>
              context.internalAdapter.createUser(
                { name: "Other", email: "other@example.test", emailVerified: true },
                { method: "admin" },
              ),
            );
            const session = yield* Effect.promise(() =>
              context.internalAdapter.createSession(user.id),
            );
            const signature = yield* Effect.promise(() => makeSignature(session.token, secret));
            const cookie = `executor-hosted.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;
            const a = yield* Effect.promise(() =>
              auth.api.createOrganization({
                body: { name: "Alpha", slug: "alpha", userId: user.id },
              }),
            );
            const b = yield* Effect.promise(() =>
              auth.api.createOrganization({
                body: { name: "Beta", slug: "beta", userId: user.id },
              }),
            );
            const c = yield* Effect.promise(() =>
              auth.api.createOrganization({
                body: { name: "Gamma", slug: "gamma", userId: other.id },
              }),
            );
            assert.ok(a && b && c);
            const sql = yield* SqlClient.SqlClient;
            yield* sql`update "session" set "activeOrganizationId" = ${b.id} where "id" = ${session.id}`;
            const credentials = yield* aesGcmCredentials(Redacted.make(encryptionKey), crypto);
            const storage = yield* makeExecutorStorage({ provider: "postgresql" });
            const blobs = memoryBlobStore();
            const repositories = nativeRepositories(`${directory}/repositories`);
            const sources = gitSourceStorage(repositories);
            const executor = yield* createExecutor({
              blobs,
              sources,
              storage,
              credentials,
              runtime: runtimeAdapter({
                build: () =>
                  Effect.succeed({
                    build: BuildId.make("bld_org_fixture"),
                    requirements: {
                      accounts: {
                        service: {
                          cardinality: "one",
                          definition: {
                            name: "Synthetic",
                            auth: {
                              key: {
                                type: "secrets",
                                label: "Key",
                                fields: {
                                  type: "object",
                                  properties: { token: { type: "string" } },
                                  required: ["token"],
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  }),
                workflow: () => Effect.die("Unexpected workflow invocation"),
                webhook: () => Effect.die("Unexpected webhook invocation"),
                inspect: () => Effect.succeed([]),
                call: () => Effect.succeed(null),
                query: () => Effect.succeed(null),
                mutate: () => Effect.succeed(null),
              }),
            });
            const app = yield* executor.apps.deploy({
              owner: OwnerId.make(`organization:${a.id}`),
              name: "Alpha app",
              files: [{ path: "index.ts", content: "synthetic" }],
            });
            const provider = app.app.requirements.accounts.service?.provider;
            assert.ok(provider);
            const alpha = yield* executor.accounts.add({
              owner: OwnerId.make(`organization:${a.id}`),
              provider,
              method: "key",
              label: "Alpha account",
              fields: Redacted.make({ token: "synthetic-alpha" }),
            });
            const beta = yield* executor.accounts.add({
              owner: OwnerId.make(`organization:${b.id}`),
              provider,
              method: "key",
              label: "Beta account",
              fields: Redacted.make({ token: "synthetic-beta" }),
            });
            // Exercise the shared multi-organization routes. Self-host registration now
            // deliberately admits one organization and has its own policy tests.
            const identity = Layer.succeed(Authentication, {
              apiKey: () => Effect.die("API key creation is outside this fixture"),
              origin,
              current: (headers) =>
                Effect.tryPromise({
                  try: () =>
                    auth.api.getSession({
                      headers,
                      query: { disableRefresh: true, disableCookieCache: true },
                    }),
                  catch: () => new AuthenticationUnavailable(),
                }).pipe(Effect.flatMap(sessionPrincipal)),
              organization: (reference) => resolveOrganizationReference(context.adapter, reference),
              organizationSlug: (headers, organizationId) =>
                lookupOrganizationSlug(() =>
                  auth.api.getOrganization({ headers, query: { organizationId } }),
                ),
              membership: (headers, organizationId) =>
                lookupMembership(() =>
                  auth.api.getActiveMemberRole({
                    headers,
                    query: { organizationId },
                    returnHeaders: true,
                  }),
                ),
              removeOrganization: (organizationId) =>
                deleteOrganizationRecords(context.adapter, organizationId),
            });
            const handler = Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const web = yield* HttpServerRequest.toWeb(request);
              return HttpServerResponse.fromWeb(yield* Effect.promise(() => auth.handler(web)));
            });
            const routes = Layer.mergeAll(
              selfHostApi.pipe(
                HttpRouter.provideRequest(
                  Layer.succeed(GroupDatabase, Effect.succeed(yield* SqlClient.SqlClient)),
                ),
                HttpRouter.provideRequest(
                  Layer.succeed(
                    AppManagementHost,
                    Effect.succeed({
                      executor,
                      blobs,
                      sources,
                      repositories,
                      registry: remoteRegistry(origin),
                      publisher: undefined,
                    }),
                  ),
                ),
              ),
              HttpRouter.add("*", "/api/auth/*", handler),
            ).pipe(
              HttpRouter.provideRequest(Layer.succeed(HostedExecutor, Effect.succeed(executor))),
              HttpRouter.provideRequest(Layer.succeed(OrganizationDefaults, () => Effect.void)),
              HttpRouter.provideRequest(
                Layer.succeed(HostedCatalog, {
                  list: Effect.succeed([]),
                  prepare: () => Effect.die("Catalog preparation is outside this fixture"),
                  custom: () => Effect.die("This fixture does not import custom apps"),
                }),
              ),
              Layer.provide(requireOrganizationLive),
              Layer.provide(requireUserLive),
              Layer.provide(identity),
              Layer.provide(
                Layer.succeed(ApiAuthentication, {
                  origin,
                  authenticate: (headers, organization) =>
                    Effect.tryPromise({
                      try: () => auth.api.getApiAccess({ headers, query: { organization } }),
                      catch: apiAuthenticationError,
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
            const request = (
              path: string,
              body?: unknown,
              method = "POST",
              requestCookie = cookie,
            ) =>
              Effect.promise(() =>
                web.handler(
                  new Request(`${origin}${path}`, {
                    method: body === undefined ? "GET" : method,
                    headers: { cookie: requestCookie, origin, "content-type": "application/json" },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                  }),
                ),
              );
            const json = <A>(response: Response, schema: Schema.Decoder<A>) =>
              Effect.promise(() => response.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(schema)),
              );
            const tab = (slug: string, organization: string) => ({
              url: `/org/${slug}/accounts`,
              read: () =>
                request(`/api/organizations/${organization}/inventory`).pipe(
                  Effect.tap((response) =>
                    Effect.promise(async () =>
                      assert.equal(response.status, 200, await response.clone().text()),
                    ),
                  ),
                  Effect.flatMap((response) => json(response, Schema.toCodecJson(Inventory))),
                ),
              rename: (account: string, label: string) =>
                request(
                  `/api/organizations/${organization}/accounts/${account}`,
                  { label },
                  "PATCH",
                ),
            });
            const sourcePath = `/api/organizations/${a.id}/apps/${app.app.id}/workspace`;
            const sourceView = yield* json(yield* request(sourcePath), AppSourceView);
            assert.equal(sourceView.files[0]?.content, "synthetic");
            assert.equal(sourceView.publication, null);
            assert.equal(
              (yield* request(`/api/organizations/${b.id}/apps/${app.app.id}/workspace`)).status,
              404,
            );
            const savedSource = yield* request(
              `/api/organizations/${a.id}/apps/${app.app.id}/commits`,
              {
                expected: sourceView.revision.commit,
                files: [...sourceView.files, { path: "README.md", content: "Edited in Alpha." }],
                message: "Edit source",
              },
            );
            assert.equal(savedSource.status, 200);
            assert.equal(
              (yield* executor.apps.get({ app: app.app.id })).activeDeployment,
              app.deployment.id,
            );
            const tabA = tab(a.slug, a.id);
            const tabB = tab(b.slug, b.id);
            assert.equal((yield* tabA.read()).accounts[0]?.id, alpha.id);
            assert.equal((yield* tabB.read()).accounts[0]?.id, beta.id);
            const key = yield* Effect.promise(
              async () =>
                await auth.api.createApiKey({
                  headers: new Headers({ cookie, origin }),
                  body: { name: "Organization test" },
                }),
            );
            for (const [reference, status] of [
              [a.id, 200],
              [a.slug, 200],
              [c.slug, 403],
            ] as const) {
              const response = yield* Effect.promise(() =>
                web.handler(
                  new Request(`${origin}/api/organizations/${reference}/inventory`, {
                    headers: { authorization: `Bearer ${key.key}` },
                  }),
                ),
              );
              assert.equal(response.status, status);
            }
            const slugTab = tab(a.slug, a.slug);
            assert.equal((yield* slugTab.read()).accounts[0]?.id, alpha.id);
            assert.equal((yield* slugTab.rename(alpha.id, "Alpha via slug")).status, 200);
            assert.equal((yield* slugTab.rename(beta.id, "Foreign via slug")).status, 404);
            assert.equal((yield* request(`/api/organizations/${c.slug}/inventory`)).status, 403);
            assert.equal((yield* request("/api/organizations/missing/inventory")).status, 403);
            // One input must not silently choose between an ID and another tenant's slug.
            yield* sql`update "organization" set "slug" = ${a.id} where "id" = ${b.id}`;
            assert.equal((yield* request(`/api/organizations/${a.id}/inventory`)).status, 403);
            yield* sql`update "organization" set "slug" = ${b.slug} where "id" = ${b.id}`;

            assert.equal((yield* tabA.rename(alpha.id, "Alpha first")).status, 200);
            assert.equal((yield* tabA.rename(beta.id, "Wrong organization")).status, 404);
            assert.equal((yield* request(`/api/organizations/${c.id}/inventory`)).status, 403);
            assert.equal((yield* request("/api/organizations//inventory")).status, 404);
            for (const path of [
              "get-full-organization",
              "get-active-member",
              "get-active-member-role",
              "list-members",
              "list-invitations",
              "get-organization",
            ]) {
              assert.ok(
                [400, 404].includes((yield* request(`/api/auth/organization/${path}`)).status),
                path,
              );
            }
            for (const [path, body] of [
              ["set-active", { organizationId: a.id }],
              ["invite-member", { email: "invited@example.test", role: "member" }],
              ["remove-member", { memberIdOrEmail: other.id }],
              ["create", { name: "Implicit", slug: "implicit" }],
            ] as const) {
              assert.ok(
                [400, 404].includes(
                  (yield* request(`/api/auth/organization/${path}`, body)).status,
                ),
                path,
              );
            }
            assert.equal(
              (yield* request(
                `/api/auth/organization/get-full-organization?organizationId=${a.id}`,
              )).status,
              200,
            );
            assert.equal(
              (yield* request(
                `/api/auth/organization/get-full-organization?organizationId=${c.id}`,
              )).status,
              403,
            );
            assert.equal(
              (yield* request(
                `/api/auth/organization/get-full-organization?organizationId=${a.id}&organizationSlug=beta`,
              )).status,
              400,
            );
            const invitationForAlpha = yield* json(
              yield* request("/api/auth/organization/invite-member", {
                organizationId: a.id,
                email: "invited@example.test",
                role: "member",
              }),
              Schema.Struct({ id: Schema.String, organizationId: Schema.String }),
            );
            assert.equal(invitationForAlpha.organizationId, a.id);
            const foreignInvite = yield* request("/api/auth/organization/invite-member", {
              organizationId: c.id,
              email: "invited@example.test",
              role: "member",
            });
            // Better Auth reports a missing membership as 400 MEMBER_NOT_FOUND on this endpoint.
            assert.equal(foreignInvite.status, 400);
            assert.equal(
              (yield* json(foreignInvite, Schema.Struct({ code: Schema.String }))).code,
              "MEMBER_NOT_FOUND",
            );
            // Creating an organization navigates one tab in the UI but cannot change session selection.
            yield* sql`update "session" set "activeOrganizationId" = ${b.id} where "id" = ${session.id}`;
            const created = yield* json(
              yield* request("/api/auth/organization/create", {
                name: "Delta",
                slug: "delta",
                keepCurrentActiveOrganization: true,
              }),
              Organization,
            );
            assert.equal(created.slug, "delta");
            assert.equal(
              (yield* Effect.promise(() =>
                auth.api.getSession({ headers: new Headers({ cookie }) }),
              ))?.session.activeOrganizationId,
              b.id,
            );
            // An invitation is a verified resource target; the library still changes its internal field.
            const otherSession = yield* Effect.promise(() =>
              context.internalAdapter.createSession(other.id),
            );
            const otherSignature = yield* Effect.promise(() =>
              makeSignature(otherSession.token, secret),
            );
            const otherCookie = `executor-hosted.session_token=${encodeURIComponent(`${otherSession.token}.${otherSignature}`)}`;
            const invitation = yield* Effect.promise(() =>
              auth.api.createInvitation({
                headers: new Headers({ cookie: otherCookie, origin }),
                body: { organizationId: c.id, email: user.email, role: "admin" },
              }),
            );
            const invited = yield* Schema.decodeUnknownEffect(Invitation)(invitation);
            assert.equal(
              (yield* request("/api/auth/organization/accept-invitation", {
                invitationId: invited.id,
              })).status,
              200,
            );
            assert.equal(
              (yield* Effect.promise(() =>
                auth.api.getSession({ headers: new Headers({ cookie }) }),
              ))?.session.activeOrganizationId,
              c.id,
            );
            assert.equal((yield* tabA.rename(alpha.id, "Alpha after invitation")).status, 200);
            assert.equal((yield* tabB.rename(beta.id, "Beta after invitation")).status, 200);
            assert.equal((yield* tabA.read()).accounts[0]?.label, "Alpha after invitation");
            assert.equal((yield* tabB.read()).accounts[0]?.label, "Beta after invitation");
            assert.equal(tabA.url, "/org/alpha/accounts");
            assert.equal(tabB.url, "/org/beta/accounts");
            // Display and URL changes retain identity; slugs are globally unique, even across owners.
            const renamed = yield* json(
              yield* request("/api/auth/organization/update", {
                organizationId: a.id,
                data: { name: "Alpha renamed" },
              }),
              Schema.Struct({ name: Schema.String, slug: Schema.String }),
            );
            assert.deepEqual(renamed, { name: "Alpha renamed", slug: "alpha" });
            assert.equal(
              (yield* request("/api/auth/organization/update", { data: { name: "No target" } }))
                .status,
              400,
            );
            assert.equal(
              (yield* request("/api/auth/organization/update", {
                organizationId: a.id,
                data: { name: "Alpha", metadata: { unauthorized: true } },
              })).status,
              400,
            );
            for (const logo of ["https://example.test/logo.png", null]) {
              const updated = yield* json(
                yield* request("/api/auth/organization/update", {
                  organizationId: a.id,
                  data: { logo },
                }),
                Schema.Struct({ logo: Schema.NullOr(Schema.String) }),
              );
              assert.equal(updated.logo, logo);
            }
            assert.equal(
              (yield* request("/api/auth/organization/update", {
                organizationId: a.id,
                data: { logo: "javascript:alert(1)" },
              })).status,
              400,
            );
            assert.equal(
              (yield* request("/api/auth/organization/update", {
                organizationId: a.id,
                data: { name: "   " },
              })).status,
              400,
            );
            for (const slug of ["beta", "gamma"]) {
              const collision = yield* request("/api/auth/organization/update", {
                organizationId: a.id,
                data: { slug },
              });
              assert.equal(collision.status, 400);
              assert.equal(
                (yield* json(collision, Schema.Struct({ code: Schema.String }))).code,
                "ORGANIZATION_SLUG_ALREADY_TAKEN",
              );
            }
            for (const slug of [
              "",
              "Uppercase",
              "with spaces",
              "a/b",
              "-leading",
              "trailing-",
              "a".repeat(81),
            ]) {
              assert.equal(
                (yield* request("/api/auth/organization/update", {
                  organizationId: a.id,
                  data: { slug },
                })).status,
                400,
              );
            }
            assert.equal(
              (yield* request("/api/auth/organization/update", { organizationId: a.id, data: {} }))
                .status,
              400,
            );
            const changedUrl = yield* json(
              yield* request("/api/auth/organization/update", {
                organizationId: a.id,
                data: { slug: "alpha-renamed" },
              }),
              Organization,
            );
            assert.deepEqual(changedUrl, { id: a.id, slug: "alpha-renamed" });
            assert.equal((yield* tabA.read()).accounts[0]?.id, alpha.id);
            // The unique constraint also guards competing updates, beyond the friendly preflight.
            const indexes = yield* sql<{
              indexdef: string;
            }>`select indexdef from pg_indexes where tablename = 'organization'`;
            assert.ok(
              indexes.some(
                (index) => /UNIQUE/i.test(index.indexdef) && /\(slug\)/.test(index.indexdef),
              ),
            );
            const member = yield* Effect.promise(() =>
              auth.api.addMember({
                body: { organizationId: a.id, userId: other.id, role: "member" },
              }),
            );
            assert.ok(member);
            const ownerMember = a.members.find((member) => member?.userId === user.id);
            assert.ok(ownerMember);
            assert.equal(
              (yield* request(
                "/api/auth/organization/update",
                { organizationId: a.id, data: { name: "Denied" } },
                "POST",
                otherCookie,
              )).status,
              403,
            );
            assert.equal(
              (yield* request(
                "/api/auth/organization/update",
                { organizationId: a.id, data: { slug: "denied" } },
                "POST",
                otherCookie,
              )).status,
              403,
            );
            assert.equal(
              (yield* request("/api/auth/organization/update-member-role", {
                organizationId: a.id,
                memberId: ownerMember.id,
                role: "member",
              })).status,
              400,
              "last owner cannot demote themselves",
            );
            assert.equal(
              (yield* request("/api/auth/organization/update-member-role", {
                memberId: member.id,
                role: "admin",
              })).status,
              400,
            );
            assert.equal(
              (yield* request("/api/auth/organization/update-member-role", {
                organizationId: b.id,
                memberId: member.id,
                role: "admin",
              })).status,
              403,
            );
            assert.equal(
              (yield* request(
                "/api/auth/organization/update-member-role",
                { organizationId: a.id, memberId: member.id, role: "admin" },
                "POST",
                otherCookie,
              )).status,
              403,
            );
            assert.equal(
              (yield* request("/api/auth/organization/update-member-role", {
                organizationId: a.id,
                memberId: member.id,
                role: "admin",
              })).status,
              200,
            );
            assert.equal(
              (yield* request(
                "/api/auth/organization/update-member-role",
                { organizationId: a.id, memberId: ownerMember.id, role: "member" },
                "POST",
                otherCookie,
              )).status,
              403,
              "admins cannot change owners",
            );
            assert.equal(
              (yield* request("/api/auth/organization/update-member-role", {
                organizationId: a.id,
                memberId: member.id,
                role: "member",
              })).status,
              200,
            );
            const pending = yield* json(
              yield* request(`/api/auth/organization/list-invitations?organizationId=${a.id}`),
              Schema.Array(Schema.Struct({ email: Schema.String, status: Schema.String })),
            );
            assert.ok(
              pending.some(
                (invitation) =>
                  invitation.email === "invited@example.test" && invitation.status === "pending",
              ),
            );
            // Revocation targets the invitation itself, checks current authority, and invalidates its join link.
            const recipient = yield* Effect.promise(() =>
              context.internalAdapter.createUser(
                { name: "Invite recipient", email: "invited@example.test", emailVerified: true },
                { method: "admin" },
              ),
            );
            const recipientSession = yield* Effect.promise(() =>
              context.internalAdapter.createSession(recipient.id),
            );
            const recipientSignature = yield* Effect.promise(() =>
              makeSignature(recipientSession.token, secret),
            );
            const recipientCookie = `executor-hosted.session_token=${encodeURIComponent(`${recipientSession.token}.${recipientSignature}`)}`;
            const revoke = { invitationId: invitationForAlpha.id };
            assert.equal(
              (yield* request("/api/auth/organization/cancel-invitation", {})).status,
              400,
            );
            assert.equal(
              (yield* request("/api/auth/organization/cancel-invitation", {
                ...revoke,
                organizationId: b.id,
              })).status,
              400,
            );
            assert.equal(
              (yield* request(
                "/api/auth/organization/cancel-invitation",
                revoke,
                "POST",
                recipientCookie,
              )).status,
              400,
              "non-members cannot revoke invitations",
            );
            assert.equal(
              (yield* request(
                "/api/auth/organization/cancel-invitation",
                revoke,
                "POST",
                otherCookie,
              )).status,
              403,
              "ordinary members cannot revoke invitations",
            );
            const revoked = yield* json(
              yield* request("/api/auth/organization/cancel-invitation", revoke),
              Schema.Struct({ id: Schema.String, status: Schema.String }),
            );
            assert.deepEqual(revoked, { id: invitationForAlpha.id, status: "canceled" });
            assert.equal(
              (yield* request(
                "/api/auth/organization/accept-invitation",
                revoke,
                "POST",
                recipientCookie,
              )).status,
              400,
              "a revoked invitation cannot grant membership",
            );
            assert.equal(
              (yield* request(
                `/api/organizations/${a.id}/inventory`,
                undefined,
                "GET",
                recipientCookie,
              )).status,
              403,
            );
            const page = yield* json(
              yield* request(
                `/api/auth/organization/list-members?organizationId=${a.id}&limit=1&offset=1`,
              ),
              Schema.Struct({
                members: Schema.Array(Schema.Struct({ id: Schema.String })),
                total: Schema.Number,
              }),
            );
            assert.equal(page.members.length, 1);
            assert.equal(page.total, 2);

            const notFound = (response: Response) =>
              Effect.gen(function* () {
                assert.equal(response.status, 404);
                yield* json(
                  response,
                  Schema.Union([AppNotFound, AccountNotFound, AccountConnectionNotFound]),
                );
              });
            // App rename is administrative, organization-specific metadata only.
            const appPath = `/api/organizations/${a.id}/apps/${app.app.id}/name`;
            assert.equal(
              (yield* request(appPath, { name: "Denied" }, "PATCH", otherCookie)).status,
              403,
            );
            yield* notFound(
              yield* request(
                `/api/organizations/${b.id}/apps/${app.app.id}/name`,
                { name: "Foreign" },
                "PATCH",
              ),
            );
            assert.equal((yield* request(appPath, { name: "   " }, "PATCH")).status, 400);
            const renamedApp = yield* json(
              yield* request(appPath, { name: "Renamed app" }, "PATCH"),
              Schema.toCodecJson(App),
            );
            assert.equal(renamedApp.id, app.app.id);
            assert.equal(renamedApp.name, "Renamed app");
            assert.equal(renamedApp.activeDeployment, app.app.activeDeployment);
            assert.equal(renamedApp.code, app.app.code);
            const collision = yield* executor.apps.copy({
              from: app.app.id,
              owner: app.app.owner,
              name: "Already used",
            });
            const conflict = yield* request(appPath, { name: collision.name }, "PATCH");
            assert.equal(conflict.status, 409);
            assert.equal((yield* json(conflict, AppNameTaken)).name, collision.name);
            // Account reconnect is targetless but stays tied to one owner and saved identity.
            yield* executor.apps.update({ app: app.app.id, accounts: { service: alpha.id } });
            const accountPath = `/api/organizations/${a.id}/accounts/${alpha.id}`;
            const detail = yield* json(
              yield* request(accountPath),
              Schema.Struct({
                canManage: Schema.Boolean,
                apps: Schema.Array(Schema.Struct({ id: Schema.String })),
              }),
            );
            assert.equal(detail.canManage, true);
            assert.deepEqual(
              detail.apps.map((app) => app.id),
              [app.app.id],
            );
            yield* notFound(yield* request(`/api/organizations/${b.id}/accounts/${alpha.id}`));
            const readOnly = yield* json(
              yield* request(accountPath, undefined, "GET", otherCookie),
              Schema.Struct({ canManage: Schema.Boolean }),
            );
            assert.equal(readOnly.canManage, false);
            assert.equal((yield* request(sourcePath, undefined, "GET", otherCookie)).status, 403);
            assert.equal(
              (yield* request(`${accountPath}/connections`, {}, "POST", otherCookie)).status,
              403,
            );
            assert.equal((yield* request(accountPath, {}, "DELETE", otherCookie)).status, 403);
            yield* notFound(
              yield* request(`/api/organizations/${b.id}/accounts/${alpha.id}/connections`, {}),
            );
            const connection = yield* json(
              yield* request(`${accountPath}/connections`, {}),
              Schema.toCodecJson(AccountConnection),
            );
            assert.equal(connection.target, null);
            assert.equal(connection.reconnectAccount?.id, alpha.id);
            const submitPath = `/api/organizations/${a.id}/connections/${connection.id}/submit`;
            const replacement = {
              method: "key",
              label: "Ignored on reconnect",
              fields: { token: "synthetic-new" },
            };
            assert.equal(
              (yield* request(submitPath, replacement, "POST", otherCookie)).status,
              403,
            );
            yield* notFound(
              yield* request(
                `/api/organizations/${b.id}/connections/${connection.id}/submit`,
                replacement,
              ),
            );
            const reconnected = yield* json(
              yield* request(submitPath, replacement),
              Schema.toCodecJson(Account),
            );
            assert.equal(reconnected.id, alpha.id);
            assert.equal((yield* executor.accounts.list({ owner: alpha.owner })).length, 1);
            assert.equal(
              (yield* executor.apps.get({ app: app.app.id })).accounts.service,
              alpha.id,
            );
            assert.equal(
              (yield* executor.accounts.provider({ owner: alpha.owner, account: alpha.id })).id,
              provider,
            );
            yield* notFound(
              yield* request(`/api/organizations/${b.id}/accounts/${alpha.id}`, {}, "DELETE"),
            );
            assert.equal((yield* request(accountPath, {}, "DELETE")).status, 200);
            assert.equal((yield* executor.accounts.list({ owner: alpha.owner })).length, 0);
            assert.equal(
              (yield* executor.accounts.get({ owner: beta.owner, account: beta.id })).id,
              beta.id,
            );
            assert.equal(
              (yield* executor.apps.get({ app: app.app.id })).accounts.service,
              alpha.id,
              "disconnect leaves a visible unresolved selection",
            );
            yield* notFound(yield* request(accountPath));
            assert.equal(
              (yield* request("/api/auth/organization/remove-member", {
                organizationId: a.id,
                memberIdOrEmail: member.id,
              })).status,
              200,
            );
            assert.equal((yield* request(accountPath, undefined, "GET", otherCookie)).status, 403);
            // Live revocation is checked per target; the other tab remains usable.
            yield* sql`delete from "member" where "userId" = ${user.id} and "organizationId" = ${a.id}`;
            assert.equal((yield* tabA.rename(alpha.id, "Revoked")).status, 403);
            assert.equal((yield* tabB.rename(beta.id, "Beta remains available")).status, 200);
          }).pipe(
            Effect.provide(selfHostDatabase),
            Effect.provideService(ConfigProvider.ConfigProvider, configuration),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ),
);
