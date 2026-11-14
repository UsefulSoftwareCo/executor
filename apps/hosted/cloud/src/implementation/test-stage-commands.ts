/** Deploy isolated previews with explicit database, retention and background policies. */
import { createHash } from "node:crypto";
import { Clock, Config, Console, Effect, FileSystem, Option, Path, Result, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { testStagePrefix } from "../infrastructure/stage.ts";
import {
  canDeployTestStage,
  isTestStageDue,
  stagesToEvict,
  testStageLimit,
  TestStageLease,
  testStageDeployMilliseconds,
  testStageLifetimeMilliseconds,
  TestStageFailed,
  TestStageSlug,
} from "../contracts/test-stage-lifetime.ts";
import { ReleaseRefusal, releaseRefusalReport } from "../contracts/release-guard.ts";
import { withStageAdmin } from "./test-stage-inventory.ts";
import { discoverTestStages } from "./test-stage-discovery.ts";
import { findOrphanBranches } from "./test-stage-orphans.ts";
import { awaitStageRollout } from "./test-stage-rollout.ts";
import {
  destroyUnreadableStage,
  inventoryCount,
  recordBlockers,
  stageInventory,
  stageRecords,
} from "./test-stage-unreadable.ts";

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
/** How a destroy may proceed; only an explicit `test-stage destroy --by-name` sets `byName`. */
interface DestroyOptions {
  /** Scheduled cleanup: only a lease whose deadline has passed. */
  readonly automatic: boolean;
  readonly expectedOwner: Option.Option<string>;
  /** Remove a stage whose records the state store cannot read by its names and tags. */
  readonly byName: boolean;
}
/**
 * `expectedOwner` destroys the stage only while the registry names exactly that owner. It is
 * checked under the stage lock, so no deploy can reassign the stage between the check and removal.
 * A stage whose records predate the state store's key is removed only by name, which eviction and
 * scheduled cleanup never ask for: they fail and say which command removes it.
 */
const destroy = (stageSlug: string, options: DestroyOptions) =>
  withStageAdmin((admin) =>
    Effect.gen(function* () {
      yield* admin.lock(stageSlug);
      const lease = yield* admin.get(stageSlug);
      if (
        options.automatic &&
        (lease === undefined || !isTestStageDue(lease, yield* Clock.currentTimeMillis))
      )
        return;
      if (Option.isSome(options.expectedOwner) && lease?.owner !== options.expectedOwner.value)
        return yield* failure(
          `test-${stageSlug} is not registered to ${options.expectedOwner.value}. It was not destroyed.`,
        );
      const records = yield* stageRecords(stageSlug);
      if (!records.readable) {
        if (!options.byName)
          return yield* failure(
            `test-${stageSlug}'s Alchemy records predate the state store's current key, so Alchemy cannot destroy it. Run \`bun run test-stage inventory ${stageSlug}\`, then \`bun run test-stage destroy ${stageSlug} --by-name --yes\` to remove it by name.`,
          );
        if (lease === undefined)
          return yield* failure(
            `test-${stageSlug} has no record in the registry, so its database kind is unknown and removal by name does not start.`,
          );
        if (lease.database === "planetscale")
          return yield* failure(
            `test-${stageSlug} uses PlanetScale, which removal by name does not cover. It was not destroyed.`,
          );
        yield* destroyUnreadableStage(stageSlug, records.fqns);
        yield* admin.remove(stageSlug);
        return;
      }
      if (options.byName)
        return yield* failure(
          `test-${stageSlug}'s Alchemy records are readable; destroy it without --by-name.`,
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
/** Free text such as an owner's name, on one line, so it cannot start a workflow command. */
const oneLine = (text: string) => text.replaceAll(/[\r\n]+/gu, " ");
/** A workflow command's message: GitHub reads `%`, CR and LF in it as escapes. */
const annotation = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
/** Account, zone and project identifiers do not belong in a job summary others read. */
const withoutIds = (text: string) =>
  text.replaceAll(/\/(accounts|zones|projects)\/[^/\s]+/gu, "/$1/…");
/**
 * A stage the limit should have removed is still there. Say so in the deploy's log and, in GitHub
 * Actions, as a warning annotation and a line in the job summary, so neither the person deploying
 * nor the stage's owner reads it as evicted.
 */
const reportEvictionFailure = (stage: TestStageLease, reason: string, total: number) =>
  Effect.gen(function* () {
    const message = `Could not evict ${stage.slug} (${stage.owner}): ${reason.replace(/\.?$/u, ".")} Its record remains, so a later destroy retries it, and this deploy continues with ${total} test stages, over the limit of ${testStageLimit}.`;
    // A line break in the owner's free text must not start a workflow command of its own.
    const line = oneLine(withoutIds(message));
    yield* Console.error(line);
    const actions = yield* Config.String("GITHUB_ACTIONS").pipe(Config.withDefault(""));
    if (actions !== "true") return;
    yield* Console.log(
      `::warning title=Test stage not evicted::${annotation(withoutIds(message))}`,
    );
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.withDefault(""));
    if (summary !== "")
      yield* (yield* FileSystem.FileSystem)
        .writeFileString(summary, `- **Test stage not evicted:** ${line}\n`, { flag: "a" })
        .pipe(Effect.ignore);
  });
const operation = (name: "deploy" | "plan") =>
  Command.make(
    name,
    {
      slug,
      owner,
      database: Flag.Literals("database", ["neon", "planetscale"]).pipe(Flag.optional),
      retention: Flag.Literals("retention", ["retained", "temporary"]).pipe(Flag.optional),
      background: Flag.Literals("background", ["active", "paused"]).pipe(Flag.optional),
      // Each deploy chooses again; a redeploy without the flag stops the export.
      telemetry: Flag.Literals("telemetry", ["export", "off"]).pipe(Flag.withDefault("off")),
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
          // An eviction that fails does not stop this deploy, whose author did not cause it, but
          // it is reported where they look: the log, a run annotation and the job summary.
          if (existing === undefined)
            for (const stage of stagesToEvict(yield* admin.list, input.slug)) {
              yield* Console.log(
                `${name === "deploy" ? "Evicting" : "Deploying will evict"} the oldest test stage, ${stage.slug} (${oneLine(stage.owner)}), to stay within ${testStageLimit}.`,
              );
              if (name !== "deploy") continue;
              const evicted = yield* destroy(stage.slug, {
                automatic: false,
                expectedOwner: Option.none(),
                byName: false,
              }).pipe(Effect.result);
              if (Result.isSuccess(evicted)) yield* Console.log(`Evicted ${stage.slug}.`);
              else
                yield* reportEvictionFailure(
                  stage,
                  Schema.is(TestStageFailed)(evicted.failure)
                    ? evicted.failure.message
                    : "its teardown failed",
                  (yield* admin.list).length + 1,
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
            TEST_STAGE_TELEMETRY: input.telemetry,
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
        destroy(stage.slug, { automatic: true, expectedOwner: Option.none(), byName: false }).pipe(
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
    // Leases as read before this pass destroyed anything: a stage removed just now may still be
    // deleting its branch, and is looked at again next pass, when its lease is gone.
    const orphans = yield* findOrphanBranches(new Set(stages.map((stage) => stage.slug)), now).pipe(
      Effect.result,
    );
    if (failures > 0)
      return yield* failure(
        `Could not remove ${failures} preview(s). Other due previews were still processed.`,
      );
    if (Result.isFailure(discovery)) return yield* discovery.failure;
    if (Result.isFailure(orphans)) return yield* failure(orphans.failure.message);
    if (Option.isSome(orphans.success) && orphans.success.value.length > 0)
      return yield* failure(
        `PlanetScale branches of deployed E2E runs with no stage lease, older than the 3-hour lease: ${orphans.success.value.join(", ")}. Nothing was deleted. Their stages are gone from the registry and \`destroy --by-name\` refuses PlanetScale stages; check that nothing uses them, then delete them in PlanetScale.`,
      );
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
    Command.make("inventory", { slug }, ({ slug }) =>
      Effect.gen(function* () {
        const records = yield* stageRecords(slug);
        const found = yield* stageInventory(slug);
        yield* Console.log(
          JSON.stringify(
            {
              stage: `test-${slug}`,
              state: { records: records.fqns.length, readable: records.readable },
              count: inventoryCount(found),
              ...found,
              blockers: [...recordBlockers(slug, records.fqns), ...found.blockers],
            },
            null,
            2,
          ),
        );
      }),
    ),
    Command.make(
      "destroy",
      {
        slug,
        expectedOwner: Flag.String("expected-owner").pipe(
          Flag.withSchema(Schema.NonEmptyString),
          Flag.optional,
        ),
        byName: Flag.Boolean("by-name").pipe(Flag.withDefault(false)),
        noInput: Flag.Boolean("no-input").pipe(Flag.withDefault(false)),
        yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
      },
      (input) =>
        input.yes
          ? destroy(input.slug, {
              automatic: false,
              expectedOwner: input.expectedOwner,
              byName: input.byName,
            })
          : Effect.fail(
              failure("Destruction removes this preview and its data. Pass --yes to proceed."),
            ),
    ),
  ]),
);
