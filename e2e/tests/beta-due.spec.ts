/**
 * `.github/workflows/beta.yml` runs `scripts/releases/beta-due.ts` on every push to main, on a
 * schedule and on manual dispatch to decide whether to publish a beta, and
 * `scripts/releases/beta-bump.sh` to push the version bump. These cases run the scripts in a
 * scratch repository whose history has a `Release <version>` commit, as main does, with stub `npm`
 * and `gh` first on PATH answering what the registry and the release runs say, and a scratch bare
 * repository standing in for GitHub's main.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const repository = "UsefulSoftwareCo/executor-next";
const version = "2.0.0-beta.5";
const apps = "0.0.1-beta.3";
const hour = 60 * 60 * 1000;

/** Answers `npm view <package> time dist-tags --json` from `$FAKE_NPM/<package>.json`. */
const stubNpm = `#!/bin/sh
[ "$1" = view ] && [ "$3 $4 $5" = "time dist-tags --json" ] || { echo "stub npm: unsupported: $*" >&2; exit 2; }
cat "$FAKE_NPM/$2.json"
`;

/**
 * Answers `gh run list` from `$FAKE_GITHUB/runs.json` and `gh run view <id> --json jobs` from
 * `$FAKE_GITHUB/jobs-<id>.json`, and appends every call to `$FAKE_GITHUB/calls`.
 */
const stubGh = `#!/bin/sh
echo "$*" >> "$FAKE_GITHUB/calls"
case "$1 $2" in
  "run list") cat "$FAKE_GITHUB/runs.json" ;;
  "run view") cat "$FAKE_GITHUB/jobs-$3.json" ;;
  *) echo "stub gh: unsupported: $*" >&2; exit 2 ;;
esac
`;

interface ReleaseRun {
  readonly id: number;
  readonly status?: "queued" | "in_progress" | "completed";
  readonly conclusion?: "success" | "failure" | "cancelled" | "";
  readonly hoursAgo: number;
  readonly headSha: string;
  readonly attempt?: number;
  /** The publish job's conclusion; it is skipped when a build or test job failed. */
  readonly publish?: "success" | "failure" | "skipped";
  /** `build` builds and tests without publishing; a dispatch of Beta asks for `beta`. */
  readonly channel?: "beta" | "build";
  /** The metadata job's conclusion. When it fails, the run's channel is unknown. */
  readonly metadata?: "success" | "failure";
  /** The name of the metadata step that runs only when publishing, if the workflow renamed it. */
  readonly publishingStep?: string;
}

const run = (
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make(command, args, { cwd, env, extendEnv: true }),
    );
    const [output, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { output, exitCode };
  }).pipe(Effect.scoped);

const ago = (hours: number) => new Date(Date.now() - hours * hour).toISOString();

/**
 * A scratch main whose commits are `Start`, where the previous beta's run built, `Release
 * 2.0.0-beta.5` and any merges after it. npm lists `executor@2.0.0-beta.5` when `published` gives
 * its age in hours.
 */
const world = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const script = path.resolve("scripts/releases/beta-due.ts");
  const bumpScript = path.resolve("scripts/releases/beta-bump.sh");
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-beta-due-" });
  const gitConfig = path.join(root, "gitconfig");
  yield* fs.writeFileString(
    gitConfig,
    "[init]\n\tdefaultBranch = main\n[user]\n\tname = Maintainer\n\temail = maintainer@example.com\n",
  );
  const bin = path.join(root, "bin");
  const npm = path.join(root, "npm");
  const github = path.join(root, "github");
  const main = path.join(root, "executor-next");
  const remote = path.join(root, "remote.git");
  for (const directory of [
    bin,
    npm,
    github,
    path.join(main, "apps/cli"),
    path.join(main, "packages/apps"),
  ])
    yield* fs.makeDirectory(directory, { recursive: true });
  for (const [name, text] of [
    ["npm", stubNpm],
    ["gh", stubGh],
  ] as const) {
    yield* fs.writeFileString(path.join(bin, name), text);
    yield* fs.chmod(path.join(bin, name), 0o755);
  }
  const env = {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FAKE_NPM: npm,
    FAKE_GITHUB: github,
    GITHUB_REPOSITORY: repository,
  };
  const git = (...args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const result = yield* run(main, "git", args, env);
      expect(result.exitCode, `git ${args.join(" ")}: ${result.output}`).toBe(0);
      return result.output.trim();
    });
  yield* fs.writeFileString(
    path.join(main, "apps/cli/package.json"),
    `${JSON.stringify({ name: "executor", version }, null, 2)}\n`,
  );
  yield* fs.writeFileString(
    path.join(main, "bun.lock"),
    `{\n  "workspaces": {\n    "apps/cli": {\n      "name": "executor",\n      "version": "${version}",\n    },\n    "packages/apps": {\n      "name": "apps",\n      "version": "${version}",\n    },\n  },\n}\n`,
  );
  yield* fs.writeFileString(
    path.join(main, "apps/cli/CHANGELOG.md"),
    `# executor\n\n## ${version}\n\nBeta of the Executor local runtime, CLI, desktop, and self-host Docker image.\n`,
  );
  yield* fs.writeFileString(
    path.join(main, "packages/apps/package.json"),
    JSON.stringify({ version: apps }),
  );
  yield* git("init", "--quiet");
  yield* git("add", "--all");
  yield* git("commit", "--quiet", "-m", "Start");
  const previous = yield* git("rev-parse", "HEAD");
  yield* git("commit", "--quiet", "--allow-empty", "-m", `Release ${version}`);
  const released = yield* git("rev-parse", "HEAD");

  /** Lands a merge on main and returns its commit. */
  const merge = Effect.gen(function* () {
    yield* git("commit", "--quiet", "--allow-empty", "-m", "Change the product (#1)");
    return yield* git("rev-parse", "HEAD");
  });

  /** Runs the script on this event, with npm and the release runs in this state. */
  const decide = (input: {
    readonly event?: "push" | "schedule" | "workflow_dispatch" | "pull_request";
    /** Hours since npm published the committed version; npm lacks it when undefined. */
    readonly published?: number;
    readonly betaTag?: string;
    readonly appsPublished?: boolean;
    readonly runs?: ReadonlyArray<ReleaseRun>;
  }) =>
    Effect.gen(function* () {
      const time: Record<string, string> = { "2.0.0-beta.4": ago(30) };
      if (input.published !== undefined) time[version] = ago(input.published);
      yield* fs.writeFileString(
        path.join(npm, "executor.json"),
        JSON.stringify({
          time,
          "dist-tags": {
            latest: "1.4.0",
            beta: input.betaTag ?? (input.published === undefined ? "2.0.0-beta.4" : version),
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(npm, "apps.json"),
        JSON.stringify({
          time: input.appsPublished === false ? {} : { [apps]: ago(1) },
          "dist-tags": { beta: apps },
        }),
      );
      const runs = input.runs ?? [];
      yield* fs.writeFileString(
        path.join(github, "runs.json"),
        JSON.stringify(
          runs.map((release) => ({
            databaseId: release.id,
            status: release.status ?? "completed",
            conclusion:
              release.status === undefined || release.status === "completed"
                ? (release.conclusion ?? "failure")
                : "",
            headSha: release.headSha,
            createdAt: ago(release.hoursAgo),
            attempt: release.attempt ?? 1,
            url: `https://github.com/${repository}/actions/runs/${release.id}`,
          })),
        ),
      );
      for (const release of runs) {
        const metadata = release.metadata ?? "success";
        yield* fs.writeFileString(
          path.join(github, `jobs-${release.id}.json`),
          JSON.stringify({
            jobs: [
              {
                name: "metadata",
                conclusion: metadata,
                steps: [
                  { name: "Run node scripts/releases/workflow.ts", conclusion: metadata },
                  {
                    name: release.publishingStep ?? "Check the apps release is published unchanged",
                    conclusion:
                      metadata === "success" && release.channel !== "build" ? "success" : "skipped",
                  },
                ],
              },
              {
                name: "docker (blacksmith-16vcpu-ubuntu-2404-arm, arm64)",
                conclusion: release.publish === undefined ? "failure" : "success",
                steps: [],
              },
              { name: "publish", conclusion: release.publish ?? "skipped", steps: [] },
            ],
          }),
        );
      }
      yield* fs.writeFileString(path.join(github, "calls"), "");
      const output = path.join(root, "output");
      yield* fs.writeFileString(output, "");
      const result = yield* run(main, "node", [script], {
        ...env,
        GITHUB_OUTPUT: output,
        GITHUB_EVENT_NAME: input.event ?? "schedule",
      });
      const outputs = Object.fromEntries(
        (yield* fs.readFileString(output))
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      /** Each `gh` call this run made. */
      const calls = (yield* fs.readFileString(path.join(github, "calls")))
        .split("\n")
        .filter((line) => line !== "");
      return { ...result, outputs, calls };
    });

  /** GitHub's main: a bare repository holding this main's history. */
  yield* run(root, "git", ["init", "--quiet", "--bare", remote], env);
  yield* git("push", "--quiet", remote, "HEAD:main");
  const remoteMain = Effect.gen(function* () {
    const result = yield* run(root, "git", ["--git-dir", remote, "rev-parse", "main"], env);
    expect(result.exitCode, result.output).toBe(0);
    return result.output.trim();
  });
  /** Lands a merge on GitHub's main and checks it out, as the workflow's checkout does. */
  const land = Effect.gen(function* () {
    const merged = yield* merge;
    yield* git("push", "--quiet", remote, "HEAD:main");
    return merged;
  });
  /** Lands a merge on GitHub's main that this checkout has not read, and returns it. */
  const mergeElsewhere = Effect.gen(function* () {
    const head = yield* git("rev-parse", "HEAD");
    const merged = yield* merge;
    yield* git("push", "--quiet", remote, "HEAD:main");
    yield* git("reset", "--quiet", "--hard", head);
    return merged;
  });
  /** Refuses every push to GitHub's main, as a ruleset would. */
  const refusePushes = Effect.gen(function* () {
    const hook = path.join(remote, "hooks/pre-receive");
    yield* fs.writeFileString(hook, "#!/bin/sh\necho 'push declined by a ruleset' >&2\nexit 1\n");
    yield* fs.chmod(hook, 0o755);
  });
  /** Runs the bump script on this checkout of main, as the workflow does after `bump`. */
  const bump = Effect.gen(function* () {
    const output = path.join(root, "bump-output");
    yield* fs.writeFileString(output, "");
    const result = yield* run(main, bumpScript, [version, remote], {
      ...env,
      GITHUB_OUTPUT: output,
    });
    return { ...result, outputs: yield* fs.readFileString(output) };
  });
  const file = (name: string) => fs.readFileString(path.join(main, name));

  return {
    decide,
    merge,
    released,
    previous,
    bump,
    remoteMain,
    land,
    mergeElsewhere,
    refusePushes,
    git,
    file,
  };
});

layer(NodeServices.layer, { excludeTestServices: true })("Beta publication gate", (it) => {
  it.effect("a new beta waits six hours after the last one, then bumps the version", () =>
    Effect.gen(function* () {
      const { decide, merge, previous } = yield* world;
      yield* merge;

      const early = yield* decide({ published: 5.5 });
      expect(early.exitCode, early.output).toBe(0);
      expect(early.outputs.decision).toBe("none");
      expect(early.outputs.reason).toContain("waits six hours");

      const due = yield* decide({
        published: 6.5,
        runs: [
          { id: 1, conclusion: "success", publish: "success", hoursAgo: 7, headSha: previous },
        ],
      });
      expect(due.exitCode, due.output).toBe(0);
      expect(due.outputs).toMatchObject({ decision: "bump", version });
      expect(due.calls.filter((call) => call.startsWith("run view"))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("main without commits after the last beta's release commit publishes nothing", () =>
    Effect.gen(function* () {
      const { decide } = yield* world;
      const result = yield* decide({ published: 30 });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.outputs.decision).toBe("none");
      expect(result.outputs.reason).toBe(`No commits on main since ${version}.`);
    }).pipe(Effect.scoped),
  );

  it.effect("a manual dispatch publishes new commits without waiting six hours", () =>
    Effect.gen(function* () {
      const { decide, merge } = yield* world;
      yield* merge;
      const result = yield* decide({ event: "workflow_dispatch", published: 1 });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.outputs.decision).toBe("bump");
    }).pipe(Effect.scoped),
  );

  it.effect("a queued or running release run blocks every decision", () =>
    Effect.gen(function* () {
      const { decide, merge, released } = yield* world;
      const head = yield* merge;
      for (const status of ["queued", "in_progress"] as const) {
        const due = yield* decide({
          published: 7,
          runs: [{ id: 2, status, hoursAgo: 0.5, headSha: head }],
        });
        expect(due.outputs.decision, due.output).toBe("none");
        expect(due.outputs.reason).toContain(`A release run is ${status}`);
        const retry = yield* decide({
          event: "workflow_dispatch",
          runs: [
            { id: 2, status, hoursAgo: 0.5, headSha: released },
            { id: 1, hoursAgo: 1.5, headSha: released },
          ],
        });
        expect(retry.outputs.decision, retry.output).toBe("none");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("a version npm lacks is published again, at once after one failed attempt", () =>
    Effect.gen(function* () {
      const { decide, released, previous } = yield* world;
      const never = yield* decide({
        runs: [
          { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
        ],
      });
      expect(never.outputs).toMatchObject({ decision: "dispatch", version });

      const once = yield* decide({
        runs: [
          { id: 2, hoursAgo: 0.2, headSha: released },
          { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
        ],
      });
      expect(once.exitCode, once.output).toBe(0);
      expect(once.outputs).toMatchObject({ decision: "dispatch", version });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "after two failed attempts, the next waits six hours and for main to move, or a day",
    () =>
      Effect.gen(function* () {
        const { decide, merge, released, previous } = yield* world;
        const failed = (hoursAgo: number): ReadonlyArray<ReleaseRun> => [
          { id: 3, hoursAgo, headSha: released },
          { id: 2, conclusion: "cancelled", hoursAgo: hoursAgo + 1, headSha: released },
          { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
        ];

        const still = yield* decide({ runs: failed(7) });
        expect(still.outputs.decision, still.output).toBe("none");
        expect(still.output).toContain("::warning::");
        expect(still.outputs.reason).toContain("after two or more failed attempts in a row");
        expect((yield* decide({ runs: failed(25) })).outputs.decision).toBe("dispatch");

        yield* merge;
        const soon = yield* decide({ runs: failed(5) });
        expect(soon.outputs.decision, soon.output).toBe("none");
        expect(soon.output).toContain("::warning::");
        const moved = yield* decide({ runs: failed(6.5) });
        expect(moved.outputs.decision, moved.output).toBe("dispatch");
        expect(moved.outputs.reason).toContain("main has moved");

        const manual = yield* decide({ event: "workflow_dispatch", runs: failed(0.2) });
        expect(manual.outputs.decision, manual.output).toBe("dispatch");
      }).pipe(Effect.scoped),
  );

  it.effect("an attempt that failed in its publish job is re-run once from its own artifacts", () =>
    Effect.gen(function* () {
      const { decide, merge, released } = yield* world;
      yield* merge;
      const first = yield* decide({
        runs: [{ id: 7, publish: "failure", hoursAgo: 1, headSha: released }],
      });
      expect(first.exitCode, first.output).toBe(0);
      expect(first.outputs).toMatchObject({ decision: "rerun", run: "7", version });

      for (const event of ["schedule", "workflow_dispatch"] as const) {
        const again = yield* decide({
          event,
          runs: [{ id: 7, publish: "failure", attempt: 2, hoursAgo: 9, headSha: released }],
        });
        expect(again.exitCode, again.output).toBe(0);
        expect(again.outputs.decision).toBe("none");
        expect(again.output).toContain("::warning::");
        expect(again.outputs.reason).toContain("inspect it");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("a publishing run that succeeded for this version without reaching npm stops", () =>
    Effect.gen(function* () {
      const { decide, merge, released } = yield* world;
      const head = yield* merge;
      for (const [event, headSha] of [
        ["schedule", released],
        ["workflow_dispatch", head],
      ] as const) {
        const result = yield* decide({
          event,
          runs: [{ id: 4, conclusion: "success", publish: "success", hoursAgo: 1, headSha }],
        });
        expect(result.exitCode, result.output).not.toBe(0);
        expect(result.output).toContain(
          `runs/4 concluded success for executor@${version}, but npm does not list it`,
        );
        expect(result.outputs.decision).toBeUndefined();
      }
    }).pipe(Effect.scoped),
  );

  it.effect("a dispatch that only builds is not an attempt, but blocks while it runs", () =>
    Effect.gen(function* () {
      const { decide, released, previous } = yield* world;
      const beta: ReleaseRun = {
        id: 1,
        conclusion: "success",
        publish: "success",
        hoursAgo: 30,
        headSha: previous,
      };

      const running = yield* decide({
        runs: [
          { id: 5, channel: "build", status: "in_progress", hoursAgo: 0.1, headSha: released },
        ],
      });
      expect(running.outputs.decision, running.output).toBe("none");
      expect(running.outputs.reason).toContain("A release run is in_progress");
      expect(running.calls.filter((call) => call.startsWith("run view"))).toEqual([]);

      const failedBuild = yield* decide({
        runs: [
          { id: 5, channel: "build", hoursAgo: 0.1, headSha: released },
          { id: 4, hoursAgo: 1, headSha: released },
          beta,
        ],
      });
      expect(failedBuild.outputs.decision, failedBuild.output).toBe("dispatch");
      expect(failedBuild.outputs.reason).toContain("runs/4 failed");

      const passedBuild = yield* decide({
        runs: [
          { id: 6, channel: "build", conclusion: "success", hoursAgo: 0.1, headSha: released },
          { id: 5, hoursAgo: 3, headSha: released },
          { id: 4, hoursAgo: 4, headSha: released },
          beta,
        ],
      });
      expect(passedBuild.outputs.decision, passedBuild.output).toBe("none");
      expect(passedBuild.output).toContain("::warning::");
      expect(passedBuild.outputs.reason).toContain(
        "the last is https://github.com/UsefulSoftwareCo/executor-next/actions/runs/5",
      );

      const unknown = yield* decide({
        runs: [
          { id: 5, metadata: "failure", hoursAgo: 0.5, headSha: released },
          { id: 4, hoursAgo: 1, headSha: released },
          beta,
        ],
      });
      expect(unknown.outputs.decision, unknown.output).toBe("none");
      expect(unknown.outputs.reason).toContain("runs/5");
    }).pipe(Effect.scoped),
  );

  it.effect("a release run whose metadata job lacks the publishing step stops the gate", () =>
    Effect.gen(function* () {
      const { decide, released } = yield* world;
      const result = yield* decide({
        runs: [{ id: 5, publishingStep: "Check apps", hoursAgo: 1, headSha: released }],
      });
      expect(result.exitCode, result.output).not.toBe(0);
      expect(result.output).toContain("cannot tell whether it published");
      expect(result.outputs.decision).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("a release waits until npm holds the apps version main pins", () =>
    Effect.gen(function* () {
      const { decide, merge } = yield* world;
      yield* merge;
      const result = yield* decide({ published: 7, appsPublished: false });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.outputs.decision).toBe("none");
      expect(result.output).toContain(`::warning::apps@${apps} is not on npm yet`);
    }).pipe(Effect.scoped),
  );

  it.effect("a beta tag that names another version stops publication", () =>
    Effect.gen(function* () {
      const { decide, merge } = yield* world;
      yield* merge;
      const result = yield* decide({ published: 7, betaTag: "2.0.0-beta.4" });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("its beta tag names 2.0.0-beta.4");
      expect(result.outputs.decision).toBeUndefined();
    }).pipe(Effect.scoped),
  );
  it.effect("a push to main decides as a scheduled tick does, waits included", () =>
    Effect.gen(function* () {
      const { decide, merge, released, previous } = yield* world;
      yield* merge;

      const early = yield* decide({ event: "push", published: 1 });
      expect(early.exitCode, early.output).toBe(0);
      expect(early.outputs.decision).toBe("none");
      expect(early.outputs.reason).toContain("waits six hours");
      const due = yield* decide({ event: "push", published: 6.5 });
      expect(due.outputs).toMatchObject({ decision: "bump", version });

      const failed: ReadonlyArray<ReleaseRun> = [
        { id: 3, hoursAgo: 1, headSha: released },
        { id: 2, hoursAgo: 2, headSha: released },
        { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
      ];
      const held = yield* decide({ event: "push", runs: failed });
      expect(held.outputs.decision, held.output).toBe("none");
      expect(held.output).toContain("::warning::");
      expect(held.outputs.reason).toContain("after two or more failed attempts in a row");
    }).pipe(Effect.scoped),
  );

  it.effect("an event the workflow does not run on stops the gate", () =>
    Effect.gen(function* () {
      const { decide, merge } = yield* world;
      yield* merge;
      const result = yield* decide({ event: "pull_request", published: 1 });
      expect(result.exitCode, result.output).not.toBe(0);
      expect(result.output).toContain("not pull_request");
      expect(result.outputs.decision).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("the bump pushes a skip-ci release commit to main and names the release", () =>
    Effect.gen(function* () {
      const { bump, land, remoteMain, git, file } = yield* world;
      yield* land;
      const result = yield* bump;
      expect(result.exitCode, result.output).toBe(0);
      expect(result.outputs).toBe("release=2.0.0-beta.6\n");
      expect(yield* remoteMain).toBe(yield* git("rev-parse", "HEAD"));
      expect(yield* git("log", "-1", "--format=%s")).toBe("Release 2.0.0-beta.6 [skip ci]");
      expect(JSON.parse(yield* file("apps/cli/package.json")).version).toBe("2.0.0-beta.6");
      const lock = yield* file("bun.lock");
      expect(lock).toContain(`"name": "executor",\n      "version": "2.0.0-beta.6"`);
      expect(lock).toContain(`"name": "apps",\n      "version": "${version}"`);
      expect(yield* file("apps/cli/CHANGELOG.md")).toMatch(/^# executor\n\n## 2\.0\.0-beta\.6\n/);
    }).pipe(Effect.scoped),
  );

  it.effect("a bump that finds main moved since the checkout pushes nothing and passes", () =>
    Effect.gen(function* () {
      const { bump, land, mergeElsewhere, remoteMain } = yield* world;
      yield* land;
      const moved = yield* mergeElsewhere;
      const result = yield* bump;
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain(`::notice::main moved`);
      expect(result.output).toContain(`to ${moved} after this run read it`);
      expect(result.outputs).toBe("");
      expect(yield* remoteMain).toBe(moved);
    }).pipe(Effect.scoped),
  );

  it.effect("a bump refused while main is where the checkout read it fails", () =>
    Effect.gen(function* () {
      const { bump, land, refusePushes, remoteMain } = yield* world;
      const head = yield* land;
      yield* refusePushes;
      const result = yield* bump;
      expect(result.exitCode, result.output).not.toBe(0);
      expect(result.output).toContain(
        `::error::Pushing Release 2.0.0-beta.6 to main was refused, and main is still at ${head}.`,
      );
      expect(result.outputs).toBe("");
      expect(yield* remoteMain).toBe(head);
    }).pipe(Effect.scoped),
  );
});
