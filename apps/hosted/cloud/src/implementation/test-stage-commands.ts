/** Deploy isolated previews with explicit database, retention and background policies. */
import { createHash } from "node:crypto";
import { Clock, Config, Console, Effect, FileSystem, Option, Path, Result, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestStageSlug, testStagePrefix } from "../infrastructure/stage.ts";
import {
  canDeployTestStage,
  isTestStageDue,
  stagesToEvict,
  testStageLimit,
  TestStageLease,
  testStageDeployMilliseconds,
  testStageLifetimeMilliseconds,
  TestStageFailed,
} from "../contracts/test-stage-lifetime.ts";
import { ReleaseRefusal, releaseRefusalReport } from "../contracts/release-guard.ts";
import { withStageAdmin } from "./test-stage-inventory.ts";
import { discoverTestStages } from "./test-stage-discovery.ts";
import { awaitStageRollout } from "./test-stage-rollout.ts";

const slug = Argument.String("slug").pipe(Argument.withSchema(TestStageSlug));
const owner = Flag.String("owner").pipe(Flag.withSchema(Schema.NonEmptyString), Flag.optional);
const json = Flag.Boolean("json").pipe(Flag.withDefault(false));
const failure = (message: string) => new TestStageFailed({ message });
const revision = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(ChildProcess.make("git", ["rev-parse", "HEAD"])).pipe(
    Effect.map((value) => value.trim()),
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))),
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
/** A release guard's refusal recorded by the Alchemy process, if it stopped the deploy. */
const releaseRefusal = (report: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(report))) return Option.none();
    return Option.some(
      yield* Schema.decodeUnknownEffect(ReleaseRefusal)(yield* fs.readFileString(report)),
    );
  });
const PackedApps = Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString }));
/**
 * Build and pack this checkout's `apps` package for the stage's compiler, which serves the package
 * files as its own assets and uses them wherever an app declares the same version. Apps on the
 * stage then run the unpublished framework. The directory is named by the package's content.
 */
const stageAppsFramework = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("../../../../..", import.meta.url));
  for (const script of ["apps:build", "e2e:apps"])
    yield* runChild(
      ChildProcess.make("bun", ["run", script], {
        cwd: root,
        extendEnv: true,
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
  const packed = path.join(root, ".local/test-runtime/apps.tgz");
  const unpacked = yield* fs.makeTempDirectoryScoped();
  yield* runChild(ChildProcess.make("tar", ["-xzf", packed, "-C", unpacked]));
  const packageRoot = path.join(unpacked, "package");
  const files: Record<string, string> = {};
  for (const entry of yield* fs.readDirectory(packageRoot, { recursive: true })) {
    const file = path.join(packageRoot, entry);
    if ((yield* fs.stat(file)).type === "File")
      files[entry.split(path.sep).join("/")] = yield* fs.readFileString(file);
  }
  const { version } = yield* Schema.decodeUnknownEffect(PackedApps)(files["package.json"]);
  const content = JSON.stringify(files);
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const directory = path.join(root, ".local/stage-apps", `apps-${version}-${digest}`);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(path.join(directory, "framework.json"), content);
  yield* Console.log(`Apps on this stage that declare apps@${version} use this checkout's build.`);
  return { EXECUTOR_APPS_FRAMEWORK: directory, EXECUTOR_APPS_VERSION: version };
}).pipe(Effect.scoped);
/**
 * `expectedOwner` destroys the stage only while the registry names exactly that owner. It is
 * checked under the stage lock, so no deploy can reassign the stage between the check and removal.
 */
const destroy = (stageSlug: string, automatic: boolean, expectedOwner: Option.Option<string>) =>
  withStageAdmin((admin) =>
    Effect.gen(function* () {
      yield* admin.lock(stageSlug);
      const lease = yield* admin.get(stageSlug);
      if (
        automatic &&
        (lease === undefined || !isTestStageDue(lease, yield* Clock.currentTimeMillis))
      )
        return;
      if (Option.isSome(expectedOwner) && lease?.owner !== expectedOwner.value)
        return yield* failure(
          `test-${stageSlug} is not registered to ${expectedOwner.value}. It was not destroyed.`,
        );
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
      database: Flag.Literals("database", ["neon", "planetscale"]).pipe(Flag.optional),
      retention: Flag.Literals("retention", ["retained", "temporary"]).pipe(Flag.optional),
      background: Flag.Literals("background", ["active", "paused"]).pipe(Flag.optional),
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
          const existing = yield* admin.get(input.slug);
          const metadata = {
            slug: input.slug,
            owner: yield* ownerName(input.owner),
            database: Option.getOrElse(input.database, () => existing?.database ?? "neon"),
            retention: Option.getOrElse(input.retention, () => existing?.retention ?? "retained"),
            background: Option.getOrElse(input.background, () => existing?.background ?? "active"),
          };
          if (metadata.retention === "temporary" && metadata.background !== "active")
            return yield* failure("Disposable test environments must run all background work.");
          if (
            existing !== undefined &&
            (metadata.database !== existing.database || metadata.retention !== existing.retention)
          )
            return yield* failure(
              "A preview's database and retention cannot change on redeploy. Use a new slug.",
            );
          // A new stage replaces the oldest ones beyond the limit, before it creates resources.
          if (existing === undefined)
            for (const stage of stagesToEvict(yield* admin.list, input.slug)) {
              yield* Console.log(
                `${name === "deploy" ? "Removing" : "Deploying will remove"} the oldest test stage, ${stage.slug} (${stage.owner}), to stay within ${testStageLimit}.`,
              );
              if (name === "deploy")
                yield* destroy(stage.slug, false, Option.none()).pipe(
                  Effect.catch(() =>
                    Console.error(`Could not remove ${stage.slug}; deploying anyway.`),
                  ),
                );
            }
          const lease =
            name === "deploy"
              ? yield* admin.reserve(metadata)
              : (existing ??
                (yield* Schema.decodeUnknownEffect(TestStageLease)({
                  ...metadata,
                  createdAt: now,
                  expiresAt:
                    metadata.retention === "retained" ? null : now + testStageLifetimeMilliseconds,
                })));
          if (!canDeployTestStage(lease, now))
            return yield* failure(
              "This preview is nearing its three-hour deadline. Use a new slug; redeployment cannot extend its lifetime.",
            );
          const version = yield* Config.String("EXECUTOR_BUILD_VERSION").pipe(Config.option);
          const env = {
            ALCHEMY_STAGE: `${testStagePrefix}${input.slug}`,
            EXECUTOR_BUILD_VERSION: Option.isSome(version) ? version.value : source,
            TEST_STAGE_DATABASE_PROVIDER: lease.database,
            TEST_STAGE_RETENTION: lease.retention,
            TEST_STAGE_BACKGROUND: metadata.background,
            TEST_STAGE_EXPIRES_AT:
              lease.expiresAt === null ? "" : String(Math.floor(lease.expiresAt)),
          };
          yield* Console.log(
            lease.expiresAt === null
              ? `Retained ${lease.database} preview. Background work: ${metadata.background}. Destroy it explicitly when finished.`
              : `Preview expires at ${new Date(lease.expiresAt).toISOString()}.`,
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
            const apps = name === "deploy" ? yield* stageAppsFramework : {};
            const path = yield* Path.Path;
            const report = path.join(
              yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped(),
              "release-refusal.json",
            );
            yield* runChild(
              ChildProcess.make(
                "alchemy",
                [name, ...(input.noInput ? ["--no-input"] : []), ...(input.yes ? ["--yes"] : [])],
                {
                  env: { ...env, ...apps, [releaseRefusalReport]: report },
                  extendEnv: true,
                  stdin: "inherit",
                  stdout: "inherit",
                  stderr: "inherit",
                },
              ),
            ).pipe(
              Effect.catchTag("TestStageFailed", (failed) =>
                Effect.gen(function* () {
                  const refusal = yield* releaseRefusal(report);
                  return yield* Option.isSome(refusal) ? refusal.value : failed;
                }),
              ),
            );
          }).pipe(Effect.scoped, Effect.timeout(testStageDeployMilliseconds));
          if (name === "deploy") {
            const domain = yield* Config.String("TEST_STAGE_DOMAIN").pipe(
              Config.withDefault("executor.engineering"),
            );
            const origin = `https://${input.slug}.${domain}`;
            yield* awaitStageRollout(origin);
            yield* Console.log(`Ready: ${origin}`);
          }
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
          expiresAt: lease.expiresAt === null ? null : new Date(lease.expiresAt).toISOString(),
          status:
            lease.expiresAt === null
              ? "retained"
              : now >= lease.expiresAt
                ? "overdue"
                : isTestStageDue(lease, now)
                  ? "cleanup"
                  : "temporary",
        }));
        if (json) yield* Console.log(JSON.stringify({ stages: report }, null, 2));
        else {
          yield* Console.log("STAGE\tOWNER\tDATABASE\tEXPIRES\tBACKGROUND\tSTATUS");
          for (const stage of report)
            yield* Console.log(
              [
                stage.slug,
                stage.owner,
                stage.database,
                stage.expiresAt ?? "retained",
                stage.background,
                stage.status,
              ].join("\t"),
            );
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
      stages.filter((stage) => isTestStageDue(stage, now)),
      (stage) =>
        destroy(stage.slug, true, Option.none()).pipe(
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
/** Ordinary previews use Neon and remain until deleted; CI explicitly requests a temporary lease. */
export const testStageCommand = Command.make("test-stage").pipe(
  Command.withDescription(
    "Deploy isolated Neon previews or disposable PlanetScale release checks.",
  ),
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
        expectedOwner: Flag.String("expected-owner").pipe(
          Flag.withSchema(Schema.NonEmptyString),
          Flag.optional,
        ),
        noInput: Flag.Boolean("no-input").pipe(Flag.withDefault(false)),
        yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
      },
      (input) =>
        input.yes
          ? destroy(input.slug, false, input.expectedOwner)
          : Effect.fail(
              failure("Destruction removes this preview and its data. Pass --yes to proceed."),
            ),
    ),
  ]),
);
