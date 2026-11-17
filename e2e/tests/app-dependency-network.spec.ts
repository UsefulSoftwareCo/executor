/**
 * An app build reaches its registry's own origin over the host's network, and everything else, a
 * dependency declared by tarball URL or a tarball or redirect the registry sends elsewhere, over
 * the network app code uses: on self-host, public addresses only unless the operator sets
 * `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH`. A failed install names the declared package and an HTTP
 * status or a fixed reason, never a dependency's name or anything a server sent.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, SessionClients, type Session } from "../support/api.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { withApps } from "../support/apps-release.ts";
import {
  appPackageFixture,
  missingArchiveReason,
  privateRegistryFixture,
  upstreamMarker,
} from "../support/app-package.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";

const BuildFailed = Schema.Struct({
  _tag: Schema.Literal("VersionBuildFailed"),
  stage: Schema.String,
  message: Schema.String,
});
const Organizations = Schema.NonEmptyArray(Schema.Struct({ id: Schema.String }));

/** An app whose one tool returns `returned`, computed from what it imports from its dependency. */
const files = (name: string, version: string, imported = "{ value }", returned = "value") => [
  {
    path: "package.json",
    content: JSON.stringify({ type: "module", dependencies: withApps({ [name]: version }) }),
  },
  {
    path: "index.ts",
    content: `import { defineApp, query, object, router } from "apps";
import ${imported} from "${name}";
export default defineApp({}, { tools: router({ value: query({ input: object({}) }, async () => ${returned}) }) });`,
  },
];

/** Deploy and call apps as `owner` in the organization at `prefix`. */
const appsOf = (api: typeof Api.Service, owner: Session, prefix: string) => {
  const deploy = (name: string, version: string, imported?: string, returned?: string) =>
    Effect.gen(function* () {
      const deployed = yield* api.request(owner, "POST", `${prefix}/deploy`, {
        name: `Dependency ${randomUUID().slice(0, 8)}`,
        files: files(name, version, imported, returned),
      });
      if (deployed.status === 200) {
        const created = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(owner, "DELETE", `${prefix}/${created.id}`).pipe(Effect.orDie),
        );
      }
      return deployed;
    });
  /** Deploy, then return what the app's tool returns. */
  const installed = (name: string, version: string, imported?: string, returned?: string) =>
    Effect.gen(function* () {
      const deployed = yield* deploy(name, version, imported, returned);
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
      const app = yield* body(App, deployed);
      const called = yield* api.request(owner, "POST", `${prefix}/${app.id}/tools/call`, {
        tool: "value",
        kind: "query",
        input: {},
      });
      expect(called.status, JSON.stringify(called.body)).toBe(200);
      return called.body;
    });
  /** Deploy, expect the build to fail, and return its message. */
  const failed = (name: string, version: string) =>
    Effect.gen(function* () {
      const deployed = yield* deploy(name, version);
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(422);
      return (yield* Schema.decodeUnknownEffect(BuildFailed)(deployed.body)).message;
    });
  return { installed, failed };
};

const suiteApps = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  return appsOf(api, actors.owner, `/api/organizations/${actors.organization.id}/apps`);
});

const refused = "the network policy refused its address";

layer(HostedLive, { excludeTestServices: true })("App dependency network", (it) => {
  it.effect(scenarios.appDependencyTarballPrivateRefused.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        // The archives listen on loopback. `apps` itself still installs from the suite's
        // registry, which also listens on loopback: the registry's origin is not restricted.
        const packages = yield* appPackageFixture;
        const { failed } = yield* suiteApps;
        expect(yield* failed("direct-fixture", packages.direct)).toContain(
          `Installing direct-fixture@${packages.direct} failed: Failed to install direct-fixture: ${refused}`,
        );
        expect(yield* packages.requests).toEqual({});
      }),
    ),
  );

  it.effect(scenarios.appDependencyTarballPublic.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        // npm's own archive host is public; nothing else in the suite is.
        const { installed } = yield* suiteApps;
        expect(
          yield* installed(
            "is-number",
            "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
            "isNumber",
            "isNumber(5)",
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect(scenarios.appDependencyTarballPrivateAllowed.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const packages = yield* appPackageFixture;
        const { installed, failed } = yield* suiteApps;
        // The archive and the one it depends on, both on loopback, install.
        expect(yield* installed("direct-fixture", packages.direct)).toBe("transitive-package");
        expect(yield* packages.requests).toEqual({
          "/direct-fixture.tgz": 1,
          "/transitive-fixture.tgz": 1,
        });
        // A missing archive fails the build with its status, not the server's reason or body.
        const message = yield* failed("missing-fixture", packages.unused);
        expect(message).toContain(
          `Installing missing-fixture@${packages.unused} failed: Failed to install missing-fixture: the tarball download answered HTTP 404`,
        );
        expect(message).not.toContain(missingArchiveReason);
        expect(message).not.toContain("is not served here");
      }),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("App dependency registry", (it) => {
  it.effect(scenarios.appDependencyRegistryOrigin.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const registry = yield* privateRegistryFixture;
        const origin = yield* startFreshSelfHost(target, {
          EXECUTOR_NPM_REGISTRY: registry.url,
          EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: "false",
        });
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const owner = yield* api.session();
        expect(
          (yield* api.request(owner, "POST", "/api/auth/self-host/setup", {
            name: "Registry Owner",
            email: "registry-owner@example.test",
            password: "Synthetic-registry-password-123!",
            organizationName: "Registry lab",
          })).status,
        ).toBe(200);
        const [organization] = yield* body(
          Organizations,
          yield* api.request(owner, "GET", "/api/auth/organization/list"),
        );
        const { installed, failed } = appsOf(
          api,
          owner,
          `/api/organizations/${organization.id}/apps`,
        );
        const failure = (name: string) => `Installing ${name}@1.0.0 failed: Failed to install`;

        // The registry's own origin is private and still serves `apps` and its packages.
        expect(yield* installed("registry-fixture", "1.0.0")).toBe("registry-package");
        // A tarball its metadata names on another private origin, and one its redirect lands on.
        expect(yield* failed("offsite-fixture", "1.0.0")).toContain(
          `${failure("offsite-fixture")} offsite-fixture: ${refused}`,
        );
        expect(yield* failed("redirected-fixture", "1.0.0")).toContain(
          `${failure("redirected-fixture")} redirected-fixture: ${refused}`,
        );
        // A tarball URL dependency on another private origin, beneath a package that installs.
        expect(yield* failed("nested-fixture", "1.0.0")).toContain(
          `${failure("nested-fixture")} a dependency of nested-fixture: ${refused}`,
        );
        const requests = yield* registry.requests;
        expect(requests["/redirected-fixture.tgz"]).toBe(1);
        expect(requests["/nested-fixture/-/nested-fixture-1.0.0.tgz"]).toBe(1);
        expect(yield* registry.offsite).toEqual({});

        // Failures name a fixed reason, never what the registry sent. The registry's own URL is
        // written as the build's failure text writes URLs, with its path.
        const messages = [
          [
            "malformed-fixture",
            `${failure("malformed-fixture")} malformed-fixture: the registry's metadata is not valid JSON`,
          ],
          [
            "versionless-fixture",
            `${failure("versionless-fixture")} versionless-fixture: the registry's metadata names no tarball for the version it resolved`,
          ],
          [
            "manifest-fixture",
            `${failure("manifest-fixture")} a dependency of manifest-fixture: the registry at ${new URL(registry.url).href} has no such package (HTTP 404)`,
          ],
        ] as const;
        for (const [name, expected] of messages) {
          const message = yield* failed(name, "1.0.0");
          expect(message).toContain(expected);
          expect(message.toLowerCase()).not.toContain(upstreamMarker.toLowerCase());
        }
      }),
    ),
  );
});
