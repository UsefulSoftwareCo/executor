import { SqlClient } from "effect/unstable/sql";
import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Public package entry points over real storage and an injected native runtime. */
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { pgliteLayer } from "fumadb-effect/pglite";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Result,
  Schema,
  Stream,
} from "effect";
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
  ToolNotFound,
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
  skills: () => Effect.die("This fixture does not load skills"),
  inspect: () => Effect.succeed([]),
  index: () => Effect.succeed([]),
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

for (const failure of ["interruption", "defect"] as const) {
  test(`profile reconciliation releases its lease after ${failure}`, { timeout: 10_000 }, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          let failing = true;
          const options = yield* fixture({
            ...runtime,
            webhook: () =>
              !failing
                ? Effect.succeed([])
                : Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(
                      failure === "interruption"
                        ? Effect.never
                        : Effect.die("Synthetic runtime defect"),
                    ),
                  ),
          });
          const executor = yield* createExecutor(options);
          const { app } = yield* executor.apps.deploy({ owner, name: "Lease recovery", files });
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
            app: app.id,
            owner,
            subject: "alice",
            idempotencyKey: "lease",
            accounts: { service: account.id },
          });
          const input = { app: app.id, profile: profile.id };
          if (failure === "interruption") {
            const running = yield* executor.apps.profiles.reconcile(input).pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            assert.equal((yield* executor.apps.profiles.reconcile(input)).status, "pending");
            yield* Fiber.interrupt(running);
          } else {
            const result = yield* executor.apps.profiles.reconcile(input).pipe(Effect.exit);
            assert.ok(Exit.isFailure(result));
          }
          failing = false;
          const recovered = yield* executor.apps.profiles.reconcile(input);
          assert.equal(recovered.status, "ready");
          assert.equal(recovered.reconciledDeployment, app.activeDeployment);
        }).pipe(Effect.provide(services)),
      ),
    ),
  );
}

for (const operation of ["webhook-register", "webhook-unregister"] as const) {
  for (const failure of ["interruption", "defect"] as const) {
    test(`${operation} releases its lease after ${failure}`, { timeout: 10_000 }, () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            let failing = false;
            const options = yield* fixture({
              ...runtime,
              webhook: ({ command }) => {
                if (failing && command.operation === operation)
                  return Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(
                      failure === "interruption"
                        ? Effect.never
                        : Effect.die("Synthetic webhook defect"),
                    ),
                  );
                return Effect.succeed(
                  command.operation === "webhooks"
                    ? [{ name: "changed", account: "service", configSchema: {} }]
                    : {},
                );
              },
            });
            const executor = yield* createExecutor({
              ...options,
              webhookOrigin: "https://hooks.example.test",
            });
            const { app } = yield* executor.apps.deploy({ owner, name: "Hook recovery", files });
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
              app: app.id,
              owner,
              subject: "alice",
              idempotencyKey: "hook-lease",
              accounts: { service: account.id },
            });
            const create = executor.webhooks.create({
              app: app.id,
              profile: profile.id,
              key: "recovery",
              name: "changed",
              config: {},
            });
            if (operation === "webhook-unregister") yield* create;
            failing = true;
            const work =
              operation === "webhook-register"
                ? create
                : Effect.gen(function* () {
                    const [hook] = yield* executor.webhooks.list({ app: app.id });
                    assert.ok(hook);
                    return yield* executor.webhooks.remove({ app: app.id, subscription: hook.id });
                  });
            if (failure === "interruption") {
              const running = yield* work.pipe(Effect.forkChild);
              yield* Deferred.await(entered);
              const [hook] = yield* executor.webhooks.list({ app: app.id });
              assert.ok(hook);
              const conflict = yield* executor.webhooks
                .reconcile({ app: app.id, subscription: hook.id })
                .pipe(Effect.exit);
              assert.ok(Exit.isFailure(conflict), "An active lease still excludes another worker");
              yield* Fiber.interrupt(running);
            } else {
              assert.ok(Exit.isFailure(yield* work.pipe(Effect.exit)));
            }
            failing = false;
            const [hook] = yield* executor.webhooks.list({ app: app.id });
            assert.ok(hook);
            const recovered = yield* executor.webhooks.reconcile({
              app: app.id,
              subscription: hook.id,
            });
            assert.equal(recovered.status, operation === "webhook-register" ? "active" : "stopped");
          }).pipe(Effect.provide(services)),
        ),
      ),
    );
  }
}

test("reading a queued workflow recovers dispatch interrupted after the durable write", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<string>();
        const nativeRuns = new Set<string>();
        let interrupted = false;
        const options = yield* fixture({
          ...runtime,
          build: () =>
            Effect.succeed({ build: BuildId.make("bld_workflow"), requirements: { accounts: {} } }),
          workflow: ({ command }) =>
            command.operation === "workflow-validate"
              ? Effect.succeed(command.input)
              : Effect.die("Unexpected workflow operation"),
        });
        const executor = yield* createExecutor({
          ...options,
          workflows: {
            status: (run) =>
              Effect.succeed({ status: nativeRuns.has(run) ? "running" : "missing" }),
            start: (run) =>
              Effect.gen(function* () {
                if (!interrupted) {
                  yield* Deferred.succeed(entered, run);
                  yield* Effect.never;
                }
                nativeRuns.add(run);
              }),
            terminate: (run) =>
              Effect.sync(() => {
                nativeRuns.delete(run);
              }),
          },
        });
        const { app } = yield* executor.apps.deploy({ owner, name: "Queued workflow", files });
        const start = yield* executor.apps.workflowRuns
          .start({
            app: app.id,
            workflow: "example",
            input: {},
            key: "once",
          })
          .pipe(Effect.forkChild);
        const run = yield* Deferred.await(entered);
        yield* Fiber.interrupt(start);
        interrupted = true;
        const queued = (yield* executor.apps.workflowRuns.list({ app: app.id })).items[0];
        assert.ok(queued);
        assert.equal(queued.id, run);
        assert.equal(queued.status, "running");
        assert.deepEqual([...nativeRuns], [run]);
        yield* executor.apps.workflowRuns.terminate({ app: app.id, run: queued.id });
        const terminal = yield* executor.apps.workflowRuns.get({ app: app.id, run: queued.id });
        assert.equal(terminal.status, "terminated");
        assert.equal(nativeRuns.size, 0, "a terminated run must not be dispatched again");
      }),
    ).pipe(Effect.provide(services)),
  ));

const indexedCatalog = (toolIndex: boolean) =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const zeta = {
      name: "queries.zeta",
      description: "Last",
      inputSchema: { type: "object" },
    };
    const alpha = {
      name: "mutations.alpha",
      description: "First",
      readOnly: false,
      inputSchema: { type: "object", required: ["id"] },
    };
    const options = yield* fixture({
      ...runtime,
      build: (input) =>
        runtime.build(input).pipe(
          Effect.map((built) => ({
            ...built,
            requirements: {
              ...built.requirements,
              ...(toolIndex ? { capabilities: { skills: true, toolIndex: true } as const } : {}),
            },
          })),
        ),
      index: () =>
        Effect.sync(() => {
          calls.push("index");
          return [
            { name: zeta.name, description: zeta.description },
            { name: alpha.name, description: alpha.description, readOnly: false },
          ];
        }),
      inspect: ({ tools }) =>
        Effect.sync(() => {
          calls.push(tools === undefined ? "inspect" : `inspect:${tools.join(",")}`);
          return tools === undefined
            ? [zeta, alpha]
            : [zeta, alpha].filter((tool) => tools.includes(tool.name));
        }),
    });
    const executor = yield* createExecutor(options);
    const { app } = yield* executor.apps.deploy({ owner, name: "Indexed", files });
    const account = yield* executor.accounts.add({
      owner,
      provider: app.requirements.accounts.service!.provider,
      method: "key",
      label: "Native",
      fields: Redacted.make({ token: "synthetic-token" }),
    });
    const profile = yield* executor.apps.profiles.create({
      app: app.id,
      owner,
      subject: "alice",
      idempotencyKey: "index",
      accounts: { service: account.id },
    });
    const index = yield* executor.tools.index({ app: app.id, profile: profile.id });
    assert.deepEqual(
      index.items.map((tool) => [tool.name, tool.app, "inputSchema" in tool]),
      [
        ["mutations.alpha", app.id, false],
        ["queries.zeta", app.id, false],
      ],
    );
    assert.equal(index.profile, profile.id);
    const tool = yield* executor.tools.get({
      app: app.id,
      profile: profile.id,
      tool: ToolName.make("queries.zeta"),
    });
    assert.deepEqual(tool.inputSchema, { type: "object" });
    assert.equal(tool.deployment, index.deployment);
    const missing = yield* Effect.flip(
      executor.tools.get({
        app: app.id,
        profile: profile.id,
        tool: ToolName.make("queries.missing"),
      }),
    );
    assert.ok(Schema.is(ToolNotFound)(missing));
    return calls;
  }).pipe(Effect.provide(services), Effect.scoped);

test(
  "builds declaring toolIndex list summaries and describe only the named tool",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      indexedCatalog(true).pipe(
        Effect.map((calls) =>
          assert.deepEqual(calls, ["index", "inspect:queries.zeta", "inspect:queries.missing"]),
        ),
      ),
    ),
);

// Earlier builds decode host requests strictly and reject inspect detail and tools.
test(
  "earlier builds only receive plain inspection; the host reduces their catalog",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      indexedCatalog(false).pipe(
        Effect.map((calls) => assert.deepEqual(calls, ["inspect", "inspect", "inspect"])),
      ),
    ),
);
