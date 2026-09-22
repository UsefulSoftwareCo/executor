/** Real control database and CLI processes; no production credentials or cloud resources. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "pg";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { testStageCommand } from "../src/implementation/test-stage-commands.ts";
import { withStageAdmin } from "../src/implementation/test-stage-inventory.ts";
import { testStageLifetimeMilliseconds } from "../src/contracts/test-stage-lifetime.ts";

const connectionString =
  "postgresql://admin.fixture:synthetic-test-password@127.0.0.1:5432/postgres";
const config = ConfigProvider.fromUnknown({
  TEST_STAGE_DATABASE_ADMIN_URL: connectionString,
  CLOUDFLARE_ACCOUNT_ID: "fixture",
  CLOUDFLARE_API_TOKEN: "synthetic-token",
});
const client = new Client({ connectionString });
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(ConfigProvider.ConfigProvider, config)));
before(async () => {
  await client.connect();
  await client.query("drop table if exists executor_test_stage_leases");
});
after(async () => {
  await client.query("drop table if exists executor_test_stage_leases");
  await client.end();
});

const runCommand = (
  args: string[],
  exits: { build: number; alchemy: (stage: string) => number },
  discovery = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json({ success: true, result: [] })),
    ),
  ),
) => {
  const commands: ChildProcess.StandardCommand[] = [];
  const result = Effect.runPromise(
    Effect.gen(function* () {
      const native = yield* ChildProcessSpawner.ChildProcessSpawner;
      const controlled = ChildProcessSpawner.make((command) => {
        assert.ok(ChildProcess.isStandardCommand(command));
        commands.push(command);
        if (command.command === "git") return native.spawn(command);
        if (command.command !== "bun" && command.command !== "alchemy")
          return Effect.die(new Error("Unexpected executable"));
        const stage = command.options.env?.ALCHEMY_STAGE;
        assert.equal(typeof stage, "string");
        const code = command.command === "bun" ? exits.build : exits.alchemy(String(stage));
        return native.spawn(ChildProcess.make(process.execPath, ["-e", `process.exit(${code})`]));
      });
      yield* Command.runWith(testStageCommand, { version: "0.0.0", renderErrors: false })(
        args,
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, controlled),
        Effect.provideService(ConfigProvider.ConfigProvider, config),
        Effect.provideService(HttpClient.HttpClient, discovery),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  return { result, commands };
};
const reserve = (slug: string) =>
  run(withStageAdmin((admin) => admin.reserve({ slug, owner: "fixture" })));
const age = async (slug: string, minutes: number) =>
  client.query(
    "update executor_test_stage_leases set created_at = now() - $2 * interval '1 minute', expires_at = now() - $2 * interval '1 minute' + interval '3 hours' where slug = $1",
    [slug, minutes],
  );

test("leases are durable before provisioning and cannot be renewed by redeployment", async () => {
  const first = await reserve("fixed");
  const second = await reserve("fixed");
  assert.deepEqual(second, first);
  assert.equal(first.expiresAt - first.createdAt, testStageLifetimeMilliseconds);
});

test("same-stage operations exclude each other; separate previews can deploy concurrently", async () => {
  let ready: () => void = () => {};
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const controller = new AbortController();
  const first = Effect.runPromise(
    withStageAdmin((admin) =>
      admin.lock("fixed").pipe(Effect.andThen(Effect.sync(ready)), Effect.andThen(Effect.never)),
    ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, config)),
    { signal: controller.signal },
  ).catch(() => undefined);
  await acquired;
  await assert.rejects(run(withStageAdmin((admin) => admin.lock("fixed"))), /Another operation/);
  await run(withStageAdmin((admin) => admin.lock("independent")));
  controller.abort();
  await first;
  await run(withStageAdmin((admin) => admin.lock("fixed")));
});

test("failed builds are tracked for cleanup and never start Alchemy", async () => {
  const attempt = runCommand(
    ["deploy", "failed-build", "--owner", "fixture", "--no-input", "--yes"],
    { build: 23, alchemy: () => 0 },
  );
  await assert.rejects(attempt.result, /status 23/);
  assert.ok(!attempt.commands.some((command) => command.command === "alchemy"));
  assert.ok(await run(withStageAdmin((admin) => admin.get("failed-build"))));
});

test("losing the control connection interrupts the operation and releases its lock", async () => {
  await assert.rejects(
    run(
      withStageAdmin((admin) =>
        admin
          .lock("lost-connection")
          .pipe(
            Effect.andThen(
              Effect.promise(() =>
                client.query(
                  "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'executor-test-stage' and pid <> pg_backend_pid()",
                ),
              ),
            ),
            Effect.andThen(Effect.never),
          ),
      ),
    ),
    /control connection closed/,
  );
  await run(withStageAdmin((admin) => admin.lock("lost-connection")));
});

test("an eleventh independent preview is allowed and receives the persisted deadline", async () => {
  for (let i = 0; i < 10; i++) await reserve(`parallel-${i}`);
  const attempt = runCommand(["deploy", "eleventh", "--owner", "fixture", "--no-input", "--yes"], {
    build: 0,
    alchemy: () => 0,
  });
  await attempt.result;
  const deployed = attempt.commands.find((command) => command.command === "alchemy");
  assert.equal(deployed?.options.env?.ALCHEMY_STAGE, "test-eleventh");
  const lease = await run(withStageAdmin((admin) => admin.get("eleventh")));
  assert.ok(lease);
  assert.equal(deployed?.options.env?.TEST_STAGE_EXPIRES_AT, String(Math.floor(lease.expiresAt)));
});

test("redeploy refuses an old lease before a build can run", async () => {
  await reserve("too-old");
  await age("too-old", 136);
  const attempt = runCommand(["deploy", "too-old", "--owner", "fixture"], {
    build: 0,
    alchemy: () => 0,
  });
  await assert.rejects(attempt.result, /cannot extend/);
  assert.ok(
    !attempt.commands.some((command) => command.command === "bun" || command.command === "alchemy"),
  );
});

test("cleanup skips recent stages, retains failed deletion, processes other stages, and retries", async () => {
  await reserve("cleanup-fails");
  await age("cleanup-fails", 166);
  await reserve("cleanup-ok");
  await age("cleanup-ok", 166);
  const attempt = runCommand(["cleanup"], {
    build: 0,
    alchemy: (stage) => (stage === "test-cleanup-fails" ? 9 : 0),
  });
  await assert.rejects(attempt.result, /1 preview/);
  assert.deepEqual(attempt.commands.map((command) => command.options.env?.ALCHEMY_STAGE).sort(), [
    "test-cleanup-fails",
    "test-cleanup-ok",
  ]);
  assert.ok(await run(withStageAdmin((admin) => admin.get("cleanup-fails"))));
  assert.equal(await run(withStageAdmin((admin) => admin.get("cleanup-ok"))), undefined);
  await runCommand(["cleanup"], { build: 0, alchemy: () => 0 }).result;
  assert.equal(await run(withStageAdmin((admin) => admin.get("cleanup-fails"))), undefined);
});

test("caller cannot extend expiry, keep a stage, or override the Alchemy stage", async () => {
  for (const args of [
    ["keep", "fixed"],
    ["deploy", "fixed", "--days", "2"],
    ["deploy", "fixed", "--", "--stage", "v2"],
  ]) {
    const attempt = runCommand(args, { build: 0, alchemy: () => 0 });
    await assert.rejects(attempt.result);
    assert.equal(attempt.commands.length, 0);
  }
});

test("cleanup discovers old-checkout previews across pages and excludes production and other stacks", async () => {
  const pages: number[] = [];
  const discovery = HttpClient.make((request, url) => {
    const page = Number(url.searchParams.get("page"));
    pages.push(page);
    const created_on = new Date(Date.now() - 181 * 60000).toISOString();
    const result =
      page === 1
        ? [
            { created_on, tags: ["alchemy:stack:executor-next-hosted", "alchemy:stage:v2"] },
            { created_on, tags: ["alchemy:stack:unrelated", "alchemy:stage:test-protected"] },
          ]
        : [
            {
              created_on,
              tags: ["alchemy:stack:executor-next-hosted", "alchemy:stage:test-discovered-old"],
            },
          ];
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({ success: true, result, result_info: { total_pages: 2 } }),
      ),
    );
  });
  const attempt = runCommand(["cleanup"], { build: 0, alchemy: () => 0 }, discovery);
  await attempt.result;
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(
    attempt.commands.map((command) => command.options.env?.ALCHEMY_STAGE),
    ["test-discovered-old"],
  );
  assert.equal(await run(withStageAdmin((admin) => admin.get("discovered-old"))), undefined);
});

test("failed discovery still removes known expired previews and reports failure", async () => {
  await reserve("known-due");
  await age("known-due", 166);
  const discovery = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response("Unavailable", { status: 503 })),
    ),
  );
  const attempt = runCommand(["cleanup"], { build: 0, alchemy: () => 0 }, discovery);
  await assert.rejects(attempt.result, /Could not discover/);
  assert.equal(await run(withStageAdmin((admin) => admin.get("known-due"))), undefined);
});
