import { SqlClient } from "effect/unstable/sql";
import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Public package entry points over real storage and an injected native runtime. */
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Context, Deferred, Effect, Fiber, Layer, Redacted, Result, Schema, Stream } from "effect";
import { createExecutor as createPromiseExecutor } from "@executor-js/sdk";
import {
  AppId,
  AppNotFound,
  AppNameTaken,
  AccountId,
  AccountNotFound,
  BuildId,
  OwnerId,
  ToolName,
  RequestInvalid,
  createExecutor,
  makeExecutorStorage,
  runtimeAdapter,
  type ExecutorOptions,
  type Runtime,
} from "@executor-js/sdk/core";
import { aesGcmCredentials as credentials } from "@executor-js/sdk/core";

const owner = OwnerId.make("alice");
const files = [
  { path: "index.ts", content: "synthetic source handled by the supplied runtime" },
] as const;
const runtime: Runtime = {
  build: () =>
    Effect.succeed({
      build: BuildId.make("bld_fixture"),
      requirements: {
        accounts: {
          service: {
            cardinality: "one",
            definition: {
              name: "Synthetic",
              auth: {
                key: {
                  type: "secrets",
                  label: "API key",
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
  query: () => Effect.succeed(null),
  mutate: () => Effect.succeed(null),
  call: () => Effect.succeed(null),
};

const fixture = (nativeRuntime = runtime) =>
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
  "root and core share accounts and deployments, with plain versus redacted inputs",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const options = yield* fixture();
          const executor = yield* createExecutor(options);
          const promise = yield* Effect.promise(() => createPromiseExecutor(options));
          const { app } = yield* executor.apps.deploy({ owner, name: "Example", files });
          const requirement = app.requirements.accounts.service;
          assert.ok(requirement);
          const account = yield* executor.accounts.add({
            owner,
            provider: requirement.provider,
            method: "key",
            label: "Native",
            fields: Redacted.make({ token: "synthetic-token" }),
          });
          assert.ok(
            Schema.is(AccountNotFound)(
              yield* Effect.flip(
                executor.accounts.get({ account: account.id, owner: OwnerId.make("bob") }),
              ),
            ),
          );
          assert.deepEqual(yield* Effect.promise(() => promise.accounts.list()), [account]);
          const other = yield* Effect.promise(() =>
            promise.accounts.add({
              owner,
              provider: requirement.provider,
              method: "key",
              label: "Promise",
              fields: { token: "other-synthetic-token" },
            }),
          );
          assert.deepEqual(yield* executor.accounts.get({ account: other.id }), other);
          assert.equal("fields" in account, false);
          const profile = yield* executor.apps.profiles.create({
            app: app.id,
            owner,
            subject: "alice",
            idempotencyKey: "test",
            accounts: { service: account.id },
          });
          assert.deepEqual(
            (yield* Effect.promise(() =>
              promise.tools.list({ app: app.id, profile: profile.id, limit: 1 }),
            )).items,
            [],
          );
          yield* Effect.promise(() =>
            assert.rejects(
              promise.tools.list({ app: app.id, profile: profile.id, limit: 0 }),
              Schema.is(RequestInvalid),
            ),
          );

          // Creation by name must not overwrite an existing app.
          yield* Effect.promise(() =>
            assert.rejects(promise.apps.deploy({ owner, name: "Example", files }), {
              _tag: "AppNameTaken",
            }),
          );
          assert.equal(
            (yield* executor.apps.get({ app: app.id })).activeDeployment,
            app.activeDeployment,
          );
          const missing = AccountId.make("acc_missing");
          const recovered = yield* executor.accounts
            .get({ account: missing })
            .pipe(Effect.catchTag("AccountNotFound", (error) => Effect.succeed(error.account)));
          assert.equal(recovered, missing);
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test(
  "core reads track dependencies and core writes join the caller's transaction",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const options = yield* fixture();
          const executor = yield* createExecutor(options);
          const { app } = yield* executor.apps.deploy({ owner, name: "Reactive", files });
          const requirement = app.requirements.accounts.service;
          assert.ok(requirement);
          const add = executor.accounts.add({
            owner,
            provider: requirement.provider,
            method: "key",
            label: "Example",
            fields: Redacted.make({ token: "synthetic-token" }),
          });
          const db = options.storage.orm("4.0.0");
          yield* db
            .transaction(add.pipe(Effect.andThen(Effect.fail("rollback"))))
            .pipe(Effect.result);
          assert.deepEqual(yield* executor.accounts.list(), []);
          const first = yield* Deferred.make<void>();
          const counts: number[] = [];
          const subscriber = yield* options.storage.reactivity
            .subscribe(executor.accounts.list())
            .pipe(
              Stream.take(2),
              Stream.runForEach(({ value }) =>
                Effect.gen(function* () {
                  counts.push(value.length);
                  yield* Deferred.succeed(first, undefined);
                }),
              ),
              Effect.forkChild,
            );
          yield* Deferred.await(first);
          yield* add;
          yield* Fiber.join(subscriber);
          assert.deepEqual(counts, [0, 1]);
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test(
  "core tool calls retain request context and propagate interruption to the runtime",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const Request = Context.Reference<string>("test/sdk-core/request", {
            defaultValue: () => "absent",
          });
          const started = yield* Deferred.make<void>();
          const released = yield* Deferred.make<void>();
          const options = yield* fixture({
            ...runtime,
            build: () =>
              Effect.succeed({
                build: BuildId.make("bld_context"),
                requirements: { accounts: {} },
              }),
            call: ({ tool }) =>
              tool === "context"
                ? Effect.map(Request, (value) => value)
                : Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(released, undefined)),
                  ),
          });
          const executor = yield* createExecutor(options);
          const { app } = yield* executor.apps.deploy({ owner, name: "Context", files });
          const value = yield* executor.tools
            .call({ app: app.id, tool: ToolName.make("context") })
            .pipe(Effect.provideService(Request, "request-A"));
          assert.deepEqual(value, { status: "completed", value: "request-A" });
          const call = yield* executor.tools
            .call({ app: app.id, tool: ToolName.make("wait") })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(call);
          yield* Deferred.await(released);
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test(
  "renaming preserves configured identity, rejects name conflicts and respects owner filters",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const options = yield* fixture();
          const executor = yield* createExecutor(options);
          const promise = yield* Effect.promise(() => createPromiseExecutor(options));
          const { app } = yield* executor.apps.deploy({ owner, name: "Original", files });
          const requirement = app.requirements.accounts.service;
          assert.ok(requirement);
          const account = yield* executor.accounts.add({
            owner,
            provider: requirement.provider,
            method: "key",
            label: "Default",
            fields: Redacted.make({ token: "synthetic" }),
          });
          const profile = yield* executor.apps.profiles.create({
            owner,
            subject: "alice",
            idempotencyKey: "test",
            app: app.id,
            accounts: { service: account.id },
          });
          const renamed = yield* Effect.promise(() =>
            promise.apps.rename({ owner, app: app.id, name: "Renamed" }),
          );
          assert.deepEqual(renamed, { ...app, name: "Renamed", slug: "renamed" });
          assert.deepEqual(
            yield* executor.apps.profiles.get({ app: app.id, profile: profile.id }),
            profile,
          );
          assert.deepEqual(
            yield* executor.apps.rename({ app: app.id, owner, name: "Renamed" }),
            renamed,
          );
          assert.ok(
            Schema.is(AppNotFound)(
              yield* Effect.flip(
                executor.apps.rename({ owner: OwnerId.make("bob"), app: app.id, name: "Foreign" }),
              ),
            ),
          );
          const other = yield* executor.apps.copy({ from: app.id, owner, name: "Other" });
          assert.ok(
            Schema.is(AppNameTaken)(
              yield* Effect.flip(executor.apps.rename({ owner, app: app.id, name: "Other" })),
            ),
          );
          assert.deepEqual(yield* executor.apps.get({ app: app.id }), renamed);
          yield* executor.apps.copy({ from: app.id, owner: OwnerId.make("bob"), name: "Renamed" });
          const competition = yield* Effect.all(
            [
              executor.apps.rename({ owner, app: app.id, name: "Contended" }).pipe(Effect.result),
              executor.apps.rename({ owner, app: other.id, name: "Contended" }).pipe(Effect.result),
            ],
            { concurrency: 2 },
          );
          const names = (yield* executor.apps.list({ owner })).map((app) => app.name);
          assert.equal(names.filter((name) => name === "Contended").length, 1);
          assert.equal(competition.filter(Result.isSuccess).length, 1);
          for (const result of competition)
            if (Result.isFailure(result)) assert.ok(Schema.is(AppNameTaken)(result.failure));
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test("app names determine slugs; normalized collisions fail without allocating suffixes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const options = yield* fixture();
        const executor = yield* createExecutor(options);
        const { AppInputs, AppSlugTaken } = yield* Effect.promise(
          () => import("@executor-js/sdk/core"),
        );
        const results = yield* Effect.forEach(
          ["Axiom", "AXIOM", "Axiom!", "Axiom?"],
          (name) => executor.apps.deploy({ owner, name, files }).pipe(Effect.result),
          { concurrency: 4 },
        );
        const successful = results.filter(Result.isSuccess);
        assert.equal(successful.length, 1);
        const first = successful[0]?.success.app;
        assert.ok(first);
        assert.equal(first.slug, "axiom");
        for (const result of results)
          if (Result.isFailure(result)) assert.ok(Schema.is(AppSlugTaken)(result.failure));
        assert.equal((yield* executor.apps.list({ owner })).length, 1);
        const second = yield* executor.apps.copy({ from: first.id, owner, name: "Other" });
        const renamed = yield* executor.apps.rename({
          app: first.id,
          name: "Friendly display name",
        });
        assert.equal(renamed.slug, "friendly-display-name");
        assert.equal(renamed.id, first.id);
        assert.equal(renamed.code, first.code);
        assert.equal(renamed.activeDeployment, first.activeDeployment);
        assert.equal(Object.hasOwn(renamed, "accounts"), false);
        const deployed = yield* executor.apps.deploy({
          owner,
          app: first.id,
          files,
        });
        assert.equal(deployed.app.slug, renamed.slug);
        assert.equal(deployed.app.name, renamed.name);
        const conflict = yield* executor.apps
          .rename({ app: second.id, name: "Friendly-display-name" })
          .pipe(Effect.flip);
        assert.ok(Schema.is(AppSlugTaken)(conflict));
        assert.deepEqual(yield* executor.apps.get({ app: second.id }), second);
        const parsedRename = Schema.decodeUnknownSync(AppInputs.rename)({
          app: first.id,
          name: "Fresh name",
          slug: "independent",
        });
        const derivedRename = yield* executor.apps.rename(parsedRename);
        assert.equal(derivedRename.slug, "fresh-name");
        const copy = yield* executor.apps.copy({ from: first.id, owner, name: "Work Axiom" });
        assert.equal(copy.slug, "work-axiom");
        assert.ok(
          Schema.is(AppSlugTaken)(
            yield* executor.apps
              .copy({ from: first.id, owner, name: "Work-Axiom" })
              .pipe(Effect.flip),
          ),
        );
        const other = yield* executor.apps.copy({
          from: first.id,
          owner: OwnerId.make("other"),
          name: "Work Axiom",
        });
        assert.equal(other.slug, "work-axiom");
        const race = yield* Effect.all(
          [
            executor.apps.rename({ app: first.id, name: "Collision Name" }).pipe(Effect.result),
            executor.apps.rename({ app: second.id, name: "Collision-Name" }).pipe(Effect.result),
          ],
          { concurrency: 2 },
        );
        assert.equal(race.filter(Result.isSuccess).length, 1);
        for (const result of race)
          if (Result.isFailure(result)) assert.ok(Schema.is(AppSlugTaken)(result.failure));
        const reserved = yield* executor.apps.deploy({ owner, name: "Search", files });
        assert.equal(reserved.app.slug, "app-search");
        yield* options.storage.migrate;
        for (const app of yield* executor.apps.list({ owner })) {
          const { appSlug } = yield* Effect.promise(() => import("../src/contracts/app-slug.ts"));
          assert.equal(app.slug, appSlug(app.name));
        }
      }),
    ).pipe(Effect.provide(services)),
  ));

test("app listing restricts IDs in storage before loading excluded deployments", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const options = yield* fixture();
        const executor = yield* createExecutor(options);
        const promise = yield* Effect.promise(() => createPromiseExecutor(options));
        const a = yield* executor.apps.deploy({ owner, name: "Selected", files });
        const b = yield* executor.apps.deploy({
          owner: OwnerId.make("bob"),
          name: "Other owner",
          files,
        });
        const broken = yield* executor.apps.deploy({ owner, name: "Unselected", files });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`update executor_deployments set requirements = '{}'::jsonb where id = ${broken.deployment.id}`;
        assert.deepEqual(
          (yield* executor.apps.list({ owner, ids: [a.app.id, b.app.id, a.app.id] })).map(
            (x) => x.id,
          ),
          [a.app.id],
        );
        assert.deepEqual(yield* executor.apps.list({ ids: [] }), []);
        assert.deepEqual(yield* executor.apps.list({ ids: [AppId.make("app_missing")] }), []);
        assert.deepEqual(
          (yield* Effect.promise(() => promise.apps.list({ ids: [b.app.id] }))).map((x) => x.id),
          [b.app.id],
        );
        assert.ok(Result.isFailure(yield* Effect.result(executor.apps.list({ owner }))));
      }),
    ).pipe(Effect.provide(services)),
  ));

test("app predicates match scalar and collection account selections before deployment reads", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const options = yield* fixture();
        const executor = yield* createExecutor(options);
        const first = yield* executor.apps.deploy({ owner, name: "Scalar", files });
        const second = yield* executor.apps.deploy({ owner, name: "Many", files });
        const unrelated = yield* executor.apps.deploy({ owner, name: "Unrelated", files });
        const account = AccountId.make("acc_filter");
        const other = AccountId.make("acc_other");
        const sql = yield* SqlClient.SqlClient;
        const scalarProfile = yield* executor.apps.profiles.create({
          app: first.app.id,
          owner,
          subject: "alice",
          idempotencyKey: "test",
          accounts: {},
        });
        const collectionProfile = yield* executor.apps.profiles.create({
          app: second.app.id,
          owner,
          subject: "alice",
          idempotencyKey: "test",
          accounts: {},
        });
        yield* sql`update executor_installations set accounts = ${JSON.stringify({ service: account })}::jsonb where id = ${scalarProfile.id}`;
        yield* sql`update executor_installations set accounts = ${JSON.stringify({ service: [account, other] })}::jsonb where id = ${collectionProfile.id}`;
        yield* sql`update executor_deployments set requirements = 'null'::jsonb where id = ${unrelated.deployment.id}`;
        assert.deepEqual(
          (yield* executor.apps.list({ account })).map((app) => app.name).toSorted(),
          ["Many", "Scalar"],
        );
        assert.deepEqual(
          (yield* executor.apps.list({ account: other })).map((app) => app.name).toSorted(),
          ["Many"],
        );
      }),
    ).pipe(Effect.provide(services)),
  ));
