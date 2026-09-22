/** Deploy previews with isolated database branches and a fixed three-hour lease. */
import { Clock, Config, Console, Effect, Option, Result, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { TestStageSlug, testStagePrefix } from "../infrastructure/stage.ts";
import {
  canDeployTestStage,
  testStageCleanupAt,
  testStageDeployMilliseconds,
  testStageLifetimeMilliseconds,
  TestStageFailed,
} from "../contracts/test-stage-lifetime.ts";
import { withStageAdmin } from "./test-stage-inventory.ts";
import { discoverTestStages } from "./test-stage-discovery.ts";

const slug = Argument.String("slug").pipe(Argument.withSchema(TestStageSlug));
const owner = Flag.String("owner").pipe(Flag.withSchema(Schema.NonEmptyString), Flag.optional);
const json = Flag.Boolean("json").pipe(Flag.withDefault(false));
const failure = (message: string) => new TestStageFailed({ message });
const revision = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(ChildProcess.make("git", ["rev-parse", "HEAD"])).pipe(
    Effect.map((value) => value.trim()),
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
    ),
  );
});
const ownerName = (selected: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isSome(selected)) return selected.value;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.string(ChildProcess.make("git", ["config", "user.name"])).pipe(
      Effect.map((name) => name.trim()),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.NonEmptyString)),
      Effect.mapError(() => failure("Pass --owner or configure git user.name.")),
    );
  });
const runChild = (command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = Number(yield* spawner.exitCode(command));
    if (code !== 0) return yield* failure(`The child command exited with status ${code}.`);
  });
const destroy = (stageSlug: string, automatic: boolean) =>
  withStageAdmin((admin) =>
    Effect.gen(function* () {
      yield* admin.lock(stageSlug);
      const lease = yield* admin.get(stageSlug);
      if (
        automatic &&
        (lease === undefined || (yield* Clock.currentTimeMillis) < testStageCleanupAt(lease))
      )
        return;
      yield* Console.log(`Removing test-${stageSlug} and its database branch.`);
      yield* runChild(
        ChildProcess.make(
          "alchemy",
          ["destroy", "alchemy.test-cleanup.ts", "--no-input", "--yes"],
          {
            env: { ALCHEMY_STAGE: `${testStagePrefix}${stageSlug}` },
            extendEnv: true,
            stdout: "inherit",
            stderr: "inherit",
          },
        ),
      ).pipe(Effect.timeout("10 minutes"));
      // Failed destruction retains the lease, so the next scheduled run retries it.
      yield* admin.remove(stageSlug);
    }),
  );
const operation = (name: "deploy" | "plan") =>
  Command.make(
    name,
    {
      slug,
      owner,
      noInput: Flag.Boolean("no-input").pipe(Flag.withDefault(false)),
      yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
    },
    (input) =>
      withStageAdmin((admin) =>
        Effect.gen(function* () {
          yield* admin.lock(input.slug);
          if ((yield* admin.get(input.slug)) === undefined) {
            const existing = (yield* discoverTestStages).find((stage) => stage.slug === input.slug);
            if (existing !== undefined) yield* admin.observe(existing);
          }
          const source = yield* revision;
          const now = yield* Clock.currentTimeMillis;
          const metadata = {
            slug: input.slug,
            owner: yield* ownerName(input.owner),
          };
          const lease =
            name === "deploy"
              ? yield* admin.reserve(metadata)
              : ((yield* admin.get(input.slug)) ?? {
                  ...metadata,
                  createdAt: now,
                  expiresAt: now + testStageLifetimeMilliseconds,
                });
          if (!canDeployTestStage(lease, now))
            return yield* failure(
              "This preview is nearing its three-hour deadline. Use a new slug; redeployment cannot extend its lifetime.",
            );
          const version = yield* Config.String("EXECUTOR_BUILD_VERSION").pipe(Config.option);
          const env = {
            ALCHEMY_STAGE: `${testStagePrefix}${input.slug}`,
            EXECUTOR_BUILD_VERSION: Option.isSome(version) ? version.value : source,
            TEST_STAGE_EXPIRES_AT: String(Math.floor(lease.expiresAt)),
          };
          yield* Console.log(
            `Preview expires at ${new Date(lease.expiresAt).toISOString()}. Cleanup starts at ${new Date(testStageCleanupAt(lease)).toISOString()}.`,
          );
          yield* Effect.gen(function* () {
            if (name === "deploy")
              yield* runChild(
                ChildProcess.make("bun", ["run", "framework:build"], {
                  env,
                  extendEnv: true,
                  stdout: "inherit",
                  stderr: "inherit",
                }),
              );
            yield* runChild(
              ChildProcess.make(
                "alchemy",
                [name, ...(input.noInput ? ["--no-input"] : []), ...(input.yes ? ["--yes"] : [])],
                {
                  env,
                  extendEnv: true,
                  stdin: "inherit",
                  stdout: "inherit",
                  stderr: "inherit",
                },
              ),
            );
          }).pipe(Effect.timeout(testStageDeployMilliseconds));
          if (name === "deploy")
            yield* Console.log(`Ready: https://${input.slug}.executor.engineering`);
        }),
      ),
  );
const inspect = (name: "list" | "check") =>
  Command.make(name, { json }, ({ json }) =>
    withStageAdmin((admin) =>
      Effect.gen(function* () {
        const stages = yield* admin.list;
        const now = yield* Clock.currentTimeMillis;
        const report = stages.map((lease) => ({
          ...lease,
          createdAt: new Date(lease.createdAt).toISOString(),
          expiresAt: new Date(lease.expiresAt).toISOString(),
          status:
            now >= lease.expiresAt
              ? "overdue"
              : now >= testStageCleanupAt(lease)
                ? "cleanup"
                : "temporary",
        }));
        if (json) yield* Console.log(JSON.stringify({ stages: report }, null, 2));
        else {
          yield* Console.log("STAGE\tOWNER\tEXPIRES\tSTATUS");
          for (const stage of report)
            yield* Console.log([stage.slug, stage.owner, stage.expiresAt, stage.status].join("\t"));
        }
        if (name === "check" && report.some((stage) => stage.status === "overdue"))
          return yield* failure(
            "A preview passed its deadline. Run test-stage cleanup and inspect the scheduled cleanup job.",
          );
      }),
    ),
  );
const cleanup = Command.make("cleanup", {}, () =>
  Effect.gen(function* () {
    const discovery = yield* discoverTestStages.pipe(Effect.result);
    const stages = yield* withStageAdmin((admin) =>
      Effect.gen(function* () {
        // A failed discovery must not prevent known expired leases from being removed.
        if (Result.isSuccess(discovery))
          yield* Effect.forEach(discovery.success, (stage) => admin.observe(stage), {
            discard: true,
          });
        else
          yield* Console.error(
            "Preview discovery failed; cleaning known leases. Check Cloudflare access.",
          );
        return yield* admin.list;
      }),
    );
    const now = yield* Clock.currentTimeMillis;
    const results = yield* Effect.forEach(
      stages.filter((stage) => now >= testStageCleanupAt(stage)),
      (stage) =>
        destroy(stage.slug, true).pipe(
          Effect.as(true),
          Effect.catch(() =>
            Console.error(`Cleanup failed for ${stage.slug}; its lease remains for retry.`).pipe(
              Effect.as(false),
            ),
          ),
        ),
      { concurrency: 4 },
    );
    const failures = results.filter((success) => !success).length;
    if (failures > 0)
      return yield* failure(
        `Could not remove ${failures} preview(s). Other due previews were still processed.`,
      );
    if (Result.isFailure(discovery)) return yield* discovery.failure;
    yield* Console.log("Preview cleanup complete.");
  }),
);
/** Every staging deployment is disposable. There is no keep or lifetime extension command. */
export const testStageCommand = Command.make("test-stage").pipe(
  Command.withDescription("Deploy isolated PlanetScale previews for at most three hours."),
  Command.withSubcommands([
    inspect("list"),
    inspect("check"),
    operation("plan"),
    operation("deploy"),
    cleanup,
    Command.make(
      "destroy",
      {
        slug,
        noInput: Flag.Boolean("no-input").pipe(Flag.withDefault(false)),
        yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
      },
      (input) =>
        input.yes
          ? destroy(input.slug, false)
          : Effect.fail(
              failure("Destruction removes this preview and its data. Pass --yes to proceed."),
            ),
    ),
  ]),
);
