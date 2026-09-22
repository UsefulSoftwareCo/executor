import { AppManagementHost } from "@executor-js/app-management";
import { GroupDatabase, GroupsUnavailable } from "@executor-js/hosted-server/groups";
import { OrganizationId as ReferenceOrganizationId } from "@executor-js/hosted-server";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
/** Request services must stay lazy, including when database acquisition fails. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { AppId, StorageError, ToolName } from "@executor-js/sdk/core";
import {
  CurrentOrganization,
  HostedExecutor,
  ApiAuthentication,
  OrganizationDefaults,
  HostedCatalog,
  Authentication,
  OrganizationId,
  OrganizationForbidden,
  hostedMcpBackend,
  organizationOwner,
  requireOrganizationLive,
  requireUserLive,
  OrganizationIcons,
  makeOrganizationIcons,
} from "@executor-js/hosted-server";
import { Principal } from "../../server/src/contracts/auth.ts";
import { hostedHandlers } from "@executor-js/hosted-server";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HostedApi } from "@executor-js/hosted-server/contracts";

// This legacy fixture exercises shared handlers; full product composition is verified in e2e.
const selfHostApi = HttpApiBuilder.layer(HostedApi).pipe(
  Layer.provide(hostedHandlers),
  HttpRouter.provideRequest(
    Layer.succeed(AppManagementHost, Effect.die("App authoring is outside this fixture")),
  ),
);

const origin = "http://localhost:4400";
test("health and unavailable policy do not acquire the SDK; failures keep their HTTP contracts", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const acquisitions = yield* Ref.make(0);
        const signedIn = yield* Ref.make(true);
        const role = yield* Ref.make<"admin" | "member">("member");
        const principal = Schema.decodeUnknownSync(Principal)({
          userId: "user_fixture",
          sessionId: "session_fixture",
          name: "Fixture",
        });
        const acquireSdk = Ref.update(acquisitions, (n) => n + 1).pipe(
          Effect.andThen(Effect.fail(new StorageError())),
        );
        const sdk = Layer.succeed(HostedExecutor, acquireSdk);
        const organization = OrganizationId.make("org_fixture");
        const member = yield* hostedMcpBackend.pipe(
          Effect.provideService(HostedExecutor, acquireSdk),
          Effect.provideService(GroupDatabase, Effect.fail(new GroupsUnavailable())),
          Effect.provideService(OrganizationDefaults, () => Effect.void),
          Effect.provideService(CurrentOrganization, {
            organization,
            owner: organizationOwner(organization),
            role: "member",
          }),
        );
        assert.equal(yield* Ref.get(acquisitions), 0);
        const denied = yield* member
          .callTool({ app: AppId.make("app_fixture"), tool: ToolName.make("hello") })
          .pipe(Effect.flip);
        assert.ok(Schema.is(OrganizationForbidden)(denied));
        assert.equal(yield* Ref.get(acquisitions), 0);
        const catalog = Layer.succeed(HostedCatalog, {
          list: Effect.succeed([]),
          prepare: () => Effect.die("Unexpected catalog import"),
          custom: () => Effect.die("This fixture does not import custom apps"),
        });
        const auth = Layer.succeed(Authentication, {
          apiKey: () => Effect.die("API key creation is outside this fixture"),
          origin,
          organization: (reference) => Effect.succeed(ReferenceOrganizationId.make(reference)),
          organizationSlug: () => Effect.succeed("synthetic"),
          current: () => Ref.get(signedIn).pipe(Effect.map((value) => (value ? principal : null))),
          membership: () =>
            Ref.get(role).pipe(Effect.map((role) => ({ role, headers: new Headers() }))),
          removeOrganization: () => Effect.die("Organization removal is outside this fixture"),
        });
        const routes = selfHostApi.pipe(
          HttpRouter.provideRequest(
            Layer.succeed(GroupDatabase, Effect.fail(new GroupsUnavailable())),
          ),
          HttpRouter.provideRequest(
            Layer.mergeAll(
              sdk,
              catalog,
              Layer.succeed(OrganizationDefaults, () => Effect.void),
            ),
          ),
          Layer.provide(requireUserLive),
          Layer.provide(requireOrganizationLive),
          Layer.provide(auth),
          Layer.provide(
            Layer.succeed(ApiAuthentication, {
              origin,
              authenticate: () => Effect.die("Unexpected bearer grant"),
            }),
          ),
          HttpRouter.provideRequest(
            Layer.succeed(OrganizationIcons, makeOrganizationIcons(memoryBlobStore())),
          ),
          Layer.provide(HttpServer.layerServices),
          Layer.provide(
            Layer.succeed(ApiAuthentication, {
              origin,
              authenticate: () => Effect.die("Bearer access is not used in this fixture"),
            }),
          ),
          HttpRouter.provideRequest(Layer.succeed(OrganizationDefaults, () => Effect.void)),
        );
        const web = yield* Effect.acquireRelease(
          Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
          (web) => Effect.promise(() => web.dispose()),
        );
        const request = (path: string, init?: RequestInit) =>
          Effect.promise(() => web.handler(new Request(`${origin}${path}`, init)));
        assert.equal((yield* request("/health")).status, 200);
        assert.equal((yield* request("/api/catalog")).status, 200);
        assert.equal(yield* Ref.get(acquisitions), 0);

        const call = () =>
          request("/api/organizations/org_fixture/apps/app_fixture/tools/call", {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ tool: "hello", input: {} }),
          });
        assert.equal((yield* call()).status, 500);
        assert.equal(yield* Ref.get(acquisitions), 0);
        yield* Ref.set(signedIn, false);
        assert.equal((yield* request("/api/organizations/org_fixture/inventory")).status, 401);
        assert.equal(yield* Ref.get(acquisitions), 0);

        yield* Ref.set(signedIn, true);
        yield* Ref.set(role, "admin");
        const failed = yield* call();
        assert.equal(failed.status, 500);
        const failure = yield* Effect.promise(() => failed.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(StorageError)),
        );
        assert.ok(Schema.is(StorageError)(failure));
        assert.equal(yield* Ref.get(acquisitions), 0);
        assert.equal((yield* request("/api/organizations/org_fixture/inventory")).status, 500);
        assert.equal(yield* Ref.get(acquisitions), 1);
      }),
    ),
  ));
