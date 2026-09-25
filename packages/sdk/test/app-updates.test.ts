import { memorySourceStorage } from "@executor-js/sdk/testing";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Deferred, Effect, Fiber, Layer, Redacted, Result, Schema } from "effect";
import {
  AccountSelectionInvalid,
  AppDeploymentChanged,
  AppNameTaken,
  AppNotFound,
  BuildId,
  DeploymentBuildFailed,
  DeploymentNotFound,
  OwnerId,
  RuntimeBuildFailed,
  createExecutor,
  makeExecutorStorage,
  runtimeAdapter,
  type ExecutorOptions,
  type Runtime,
} from "@executor-js/sdk/core";
import { createExecutor as createPromiseExecutor } from "@executor-js/sdk";
import { aesGcmCredentials as credentials } from "@executor-js/sdk/core";

const owner = OwnerId.make("updates-owner");
const otherOwner = OwnerId.make("other-owner");
const files = (content: string) => [{ path: "index.ts", content }] as const;
const definition = (name: string) => ({
  name,
  auth: {
    key: {
      type: "secrets" as const,
      label: "API key",
      fields: {
        type: "object" as const,
        properties: { token: { type: "string" as const } },
        required: ["token"],
      },
    },
  },
});
const requirements = (name: string) => ({
  accounts: {
    service: { cardinality: "one" as const, definition: definition(name) },
  },
});

const runtimeFor = (build: Runtime["build"]): Runtime => ({
  build,
  workflow: () => Effect.die("Unexpected workflow invocation"),
  webhook: () => Effect.die("Unexpected webhook invocation"),
  skills: () => Effect.die("This fixture does not load skills"),
  inspect: () => Effect.succeed([]),
  index: () => Effect.succeed([]),
  query: () => Effect.succeed(null),
  mutate: () => Effect.succeed(null),
  call: () => Effect.succeed(null),
});
const fixture = (
  nativeRuntime: Runtime = runtimeFor(() =>
    Effect.succeed({ build: BuildId.make("bld_updates"), requirements: requirements("Synthetic") }),
  ),
) =>
  Effect.gen(function* () {
    const storage = yield* makeExecutorStorage({ provider: "postgresql" });
    yield* storage.migrate;
    const credentialStore = yield* credentials(Redacted.make("ab".repeat(32)), crypto);
    return {
      blobs: memoryBlobStore(),
      sources: memorySourceStorage(),
      storage,
      credentials: credentialStore,
      runtime: runtimeAdapter(nativeRuntime),
    } satisfies ExecutorOptions;
  });
const services = Layer.mergeAll(BrowserCrypto.layer, pgliteLayer());

test(
  "ID deploy preserves app identity and supports source, list, and rollback",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const executor = yield* createExecutor(yield* fixture());
          const first = yield* executor.apps.deploy({ owner, name: "Hosted", files: files("one") });
          const second = yield* executor.apps.deploy({
            owner,
            app: first.app.id,
            files: files("two"),
          });
          assert.equal(second.app.id, first.app.id);
          assert.equal(second.app.code, first.app.code);
          assert.equal(second.app.activeDeployment, second.deployment.id);
          const summaries = yield* executor.apps.deployments({ app: first.app.id, owner });
          assert.deepEqual(
            new Set(summaries.map(({ id }) => id)),
            new Set([second.deployment.id, first.deployment.id]),
          );
          assert.equal(summaries.length, 2);
          assert.equal(summaries[0]?.fileCount, 1);
          assert.equal(
            (yield* executor.apps.source({
              app: first.app.id,
              owner,
              deployment: first.deployment.id,
            })).id,
            first.deployment.id,
          );
          const rolled = yield* executor.apps.activate({
            app: first.app.id,
            owner,
            deployment: first.deployment.id,
            expectedDeployment: second.deployment.id,
          });
          assert.equal(rolled.activeDeployment, first.deployment.id);
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test(
  "failed builds preserve deployment; changed requirements preserve profiles for repair",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const failing = runtimeFor((input) =>
            input.files[0]?.content === "fail"
              ? Effect.fail(new RuntimeBuildFailed({ stage: "compile" }))
              : Effect.succeed({
                  build: BuildId.make("bld_ok"),
                  requirements: requirements("Synthetic"),
                }),
          );
          const options = yield* fixture(failing);
          const executor = yield* createExecutor(options);
          const initial = yield* executor.apps.deploy({
            owner,
            name: "Stable",
            files: files("ok"),
          });
          const failed = yield* Effect.flip(
            executor.apps.deploy({
              owner,
              app: initial.app.id,
              files: files("fail"),
            }),
          );
          assert.ok(Schema.is(DeploymentBuildFailed)(failed));
          assert.equal(
            (yield* executor.apps.get({ app: initial.app.id })).activeDeployment,
            initial.deployment.id,
          );
          assert.equal((yield* executor.apps.deployments({ app: initial.app.id })).length, 1);

          let incompatibleBuild = 0;
          const incompatible = runtimeFor(() =>
            Effect.succeed({
              build: BuildId.make(`bld_incompatible_${++incompatibleBuild}`),
              requirements: incompatibleBuild === 1 ? requirements("Synthetic") : { accounts: {} },
            }),
          );
          const incompatibleExecutor = yield* createExecutor(yield* fixture(incompatible));
          const app = yield* incompatibleExecutor.apps.deploy({
            owner,
            name: "Selection",
            files: files("ok"),
          });
          const requirement = app.app.requirements.accounts.service;
          assert.ok(requirement);
          const account = yield* incompatibleExecutor.accounts.add({
            owner,
            provider: requirement.provider,
            method: "key",
            label: "Default",
            fields: Redacted.make({ token: "token" }),
          });
          const profile = yield* incompatibleExecutor.apps.profiles.create({
            owner,
            subject: "alice",
            idempotencyKey: "test",
            app: app.app.id,
            accounts: { service: account.id },
          });
          const next = yield* incompatibleExecutor.apps.deploy({
            owner,
            app: app.app.id,
            files: files("next"),
          });
          assert.equal(
            (yield* incompatibleExecutor.apps.get({ app: app.app.id })).activeDeployment,
            next.deployment.id,
          );
          assert.equal(
            (yield* incompatibleExecutor.apps.deployments({ app: app.app.id })).length,
            2,
          );
          assert.deepEqual(
            (yield* incompatibleExecutor.apps.profiles.get({
              app: app.app.id,
              profile: profile.id,
            })).accounts,
            profile.accounts,
          );
          const invalid = yield* Effect.flip(
            incompatibleExecutor.tools.list({ app: app.app.id, profile: profile.id }),
          );
          assert.ok(Schema.is(AccountSelectionInvalid)(invalid));
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test(
  "stale activations and foreign lineage or owner lookups are rejected",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const executor = yield* createExecutor(yield* fixture());
          const first = yield* executor.apps.deploy({
            owner,
            name: "Concurrent",
            files: files("one"),
          });
          const second = yield* executor.apps.deploy({
            owner,
            app: first.app.id,
            files: files("two"),
          });
          const stale = yield* Effect.flip(
            executor.apps.activate({
              owner,
              app: first.app.id,
              deployment: first.deployment.id,
              expectedDeployment: first.deployment.id,
            }),
          );
          assert.ok(Schema.is(AppDeploymentChanged)(stale));
          assert.equal(
            (yield* executor.apps.get({ app: first.app.id })).activeDeployment,
            second.deployment.id,
          );
          assert.ok(
            Schema.is(AppNotFound)(
              yield* Effect.flip(executor.apps.get({ app: first.app.id, owner: otherOwner })),
            ),
          );
          assert.ok(
            Schema.is(AppNotFound)(
              yield* Effect.flip(executor.apps.source({ app: first.app.id, owner: otherOwner })),
            ),
          );
          const other = yield* executor.apps.deploy({
            owner: otherOwner,
            name: "Other",
            files: files("other"),
          });
          assert.ok(
            Schema.is(DeploymentNotFound)(
              yield* Effect.flip(
                executor.apps.source({ app: first.app.id, owner, deployment: other.deployment.id }),
              ),
            ),
          );
          const shared = yield* executor.apps.copy({
            from: first.app.id,
            owner: otherOwner,
            name: "Shared",
          });
          assert.equal(
            (yield* executor.apps.deployments({ app: shared.id, owner: otherOwner })).length,
            1,
          );
          assert.equal(
            (yield* executor.apps.deployments({
              app: shared.id,
              owner: otherOwner,
              deploymentOwner: owner,
            })).length,
            0,
          );
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test(
  "rename during an ID build keeps the same app and latest selections",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let buildCount = 0;
          const building = runtimeFor(() =>
            ++buildCount === 1
              ? Effect.succeed({
                  build: BuildId.make("bld_initial"),
                  requirements: requirements("Synthetic"),
                })
              : Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({
                    build: BuildId.make("bld_rename"),
                    requirements: requirements("Synthetic"),
                  }),
                ),
          );
          const options = yield* fixture(building);
          const executor = yield* createExecutor(options);
          const initial = yield* executor.apps.deploy({
            owner,
            name: "Before",
            files: files("one"),
          });
          const requirement = initial.app.requirements.accounts.service;
          assert.ok(requirement);
          const account = yield* executor.accounts.add({
            owner,
            provider: requirement.provider,
            method: "key",
            label: "Default",
            fields: Redacted.make({ token: "token" }),
          });
          const profile = yield* executor.apps.profiles.create({
            app: initial.app.id,
            owner,
            subject: "alice",
            idempotencyKey: "test",
            accounts: { service: account.id },
          });
          const update = yield* executor.apps
            .deploy({
              owner,
              app: initial.app.id,
              files: files("two"),
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* executor.apps.rename({ app: initial.app.id, owner, name: "After" });
          yield* Deferred.succeed(release, undefined);
          const deployed = yield* Fiber.join(update);
          assert.equal(deployed.app.id, initial.app.id);
          assert.equal(deployed.app.name, "After");
          assert.equal(Object.hasOwn(deployed.app, "accounts"), false);
          assert.deepEqual(
            (yield* executor.apps.profiles.get({ app: initial.app.id, profile: profile.id }))
              .accounts,
            { service: account.id },
          );
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test("deploy by name creates a fresh app and rejects a duplicate", { timeout: 10_000 }, () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(yield* fixture());
        const created = yield* executor.apps.deploy({
          owner,
          name: "Fresh",
          files: files("one"),
        });
        const duplicate = yield* Effect.flip(
          executor.apps.deploy({ owner, name: "Fresh", files: files("two") }),
        );
        assert.equal(created.app.name, "Fresh");
        assert.ok(Schema.is(AppNameTaken)(duplicate));
      }).pipe(Effect.provide(services)),
    ),
  ),
);

test(
  "a late older build is retained without replacing the newer successful deployment",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const building = runtimeFor((input) =>
            input.files[0]?.content === "slow"
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({
                    build: BuildId.make("bld_slow"),
                    requirements: requirements("Synthetic"),
                  }),
                )
              : Effect.succeed({
                  build: BuildId.make("bld_fast"),
                  requirements: requirements("Synthetic"),
                }),
          );
          const executor = yield* createExecutor(yield* fixture(building));
          const first = yield* executor.apps.deploy({
            owner,
            name: "Concurrent builds",
            files: files("initial"),
          });
          const slow = yield* executor.apps
            .deploy({
              owner,
              app: first.app.id,
              files: files("slow"),
            })
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(started);
          const latest = yield* executor.apps.deploy({
            owner,
            app: first.app.id,
            files: files("fast"),
          });
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(slow);
          assert.ok(Result.isSuccess(result));
          assert.equal(result.success.deployment.build, BuildId.make("bld_slow"));
          assert.equal(result.success.app.activeDeployment, latest.deployment.id);
          assert.equal(
            (yield* executor.apps.get({ app: first.app.id })).activeDeployment,
            latest.deployment.id,
          );
          assert.equal((yield* executor.apps.deployments({ app: first.app.id })).length, 3);
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test(
  "Promise facade preserves deployment selectors and source/activation arguments",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const options = yield* fixture();
          const executor = yield* Effect.promise(() => createPromiseExecutor(options));
          const first = yield* Effect.promise(() =>
            executor.apps.deploy({ owner, name: "Promise", files: files("one") }),
          );
          const next = yield* Effect.promise(() =>
            executor.apps.deploy({
              owner,
              app: first.app.id,
              files: files("two"),
            }),
          );
          const retained = yield* Effect.promise(() =>
            executor.apps.source({ owner, app: first.app.id, deployment: first.deployment.id }),
          );
          assert.deepEqual(retained.files, files("one"));
          assert.equal(
            (yield* Effect.promise(() => executor.apps.deployments({ owner, app: first.app.id })))
              .length,
            2,
          );
          const rolled = yield* Effect.promise(() =>
            executor.apps.activate({
              owner,
              app: first.app.id,
              deployment: first.deployment.id,
              expectedDeployment: next.deployment.id,
            }),
          );
          assert.equal(rolled.activeDeployment, first.deployment.id);
        }).pipe(Effect.provide(services)),
      ),
    ),
);

// A failing Git adapter makes any accidental read, commit, or retention observable.
test("file deployments and copies run with Git unavailable and preserve exact inputs", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const options = yield* fixture();
        const unavailable = () => Effect.die("File deployment must not access Git");
        const executor = yield* createExecutor({
          ...options,
          sources: {
            workspace: unavailable,
            commit: unavailable,
            read: unavailable,
            retain: unavailable,
          },
        });
        const first = yield* executor.apps.deploy({ owner, name: "No Git", files: files("first") });
        assert.equal(first.app.repository, null);
        assert.equal(first.deployment.sourceCommit, null);
        assert.equal("source" in first, false);
        const next = yield* executor.apps.deploy({
          owner,
          app: first.app.id,
          files: files("next"),
        });
        assert.deepEqual(
          (yield* executor.apps.source({ app: first.app.id, deployment: first.deployment.id }))
            .files,
          files("first"),
        );
        assert.deepEqual((yield* executor.apps.source({ app: first.app.id })).files, files("next"));
        const copied = yield* executor.apps.copy({
          owner,
          from: first.app.id,
          name: "No Git copy",
        });
        assert.equal(copied.repository, null);
        assert.deepEqual(
          (yield* executor.apps.source({ app: copied.id })).files,
          next.deployment.files,
        );
        const draft = yield* executor.apps.create({
          owner,
          name: "No Git draft",
          files: files("draft"),
        });
        const draftCopy = yield* executor.apps.copy({
          owner,
          from: draft.id,
          name: "No Git draft copy",
        });
        assert.equal(draftCopy.activeDeployment, null);
        assert.equal(draftCopy.repository, null);
      }).pipe(Effect.provide(services)),
    ),
  ));

test("a newer slow success promotes after an older success; a failed newer build does not fence success", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        for (const newerFails of [false, true]) {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const runtime = runtimeFor((input) =>
            input.files[0].content === "slow"
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({
                    build: BuildId.make("bld_slow"),
                    requirements: requirements("Synthetic"),
                  }),
                )
              : input.files[0].content === "fail"
                ? Effect.fail(new RuntimeBuildFailed({ stage: "compile" }))
                : Effect.succeed({
                    build: BuildId.make("bld_fast"),
                    requirements: requirements("Synthetic"),
                  }),
          );
          const executor = yield* createExecutor(yield* fixture(runtime));
          const first = yield* executor.apps.deploy({
            owner,
            name: `Ordering ${newerFails}`,
            files: files("initial"),
          });
          if (!newerFails)
            yield* executor.apps.deploy({ owner, app: first.app.id, files: files("older") });
          const slow = yield* executor.apps
            .deploy({ owner, app: first.app.id, files: files("slow") })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          if (newerFails) {
            const failure = yield* executor.apps
              .deploy({ owner, app: first.app.id, files: files("fail") })
              .pipe(Effect.flip);
            assert.ok(Schema.is(DeploymentBuildFailed)(failure));
          }
          yield* Deferred.succeed(release, undefined);
          const successful = yield* Fiber.join(slow);
          assert.equal(
            (yield* executor.apps.get({ app: first.app.id })).activeDeployment,
            successful.deployment.id,
          );
        }
      }).pipe(Effect.provide(services)),
    ),
  ));
