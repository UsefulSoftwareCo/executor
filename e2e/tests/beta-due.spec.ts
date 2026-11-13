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
 * Answers `gh run list` for push runs from `$FAKE_GITHUB/pushes.json`, the finished ones alone
 * when it asks for completed runs, and for dispatches from
 * `$FAKE_GITHUB/runs.json`, and `gh run view <id> --json jobs` from `$FAKE_GITHUB/jobs-<id>.json`,
 * and appends every call to `$FAKE_GITHUB/calls`.
 */
const stubGh = `#!/bin/sh
echo "$*" >> "$FAKE_GITHUB/calls"
case "$1 $2 $*" in
  "run list "*" -e push "*) if [ -f "$FAKE_GITHUB/push-list-fails" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi ;;
esac
case "$1 $2 $*" in
  "run list "*" -e push "*" -s completed "*) jq '[.[] | select(.status == "completed")]' "$FAKE_GITHUB/pushes.json" ;;
  "run list "*" -e push "*) cat "$FAKE_GITHUB/pushes.json" ;;
  "run list "*) cat "$FAKE_GITHUB/runs.json" ;;
  "run view "*) cat "$FAKE_GITHUB/jobs-$3.json" ;;
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

/** A push run of the release matrix on main, which release-artifacts.yml starts after merge. */
interface MatrixRun {
  readonly id: number;
  readonly status?: "queued" | "in_progress" | "completed";
  readonly conclusion?: "success" | "failure" | "cancelled";
  readonly hoursAgo: number;
  readonly headSha: string;
  /** Its pace job; it fails before the matrix runs when, say, the API fails. Passed by default. */
  readonly pace?: "success" | "failure" | "cancelled";
  /** Its releases job, which judges the matrix; by default as the run concluded. */
  readonly releases?: "success" | "failure" | "skipped" | "missing";
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
 * its age in hours. Main holds this checkout's release-artifacts.yml, whose push trigger names the
 * paths that start the release matrix, and that matrix passed on `Start` unless a case says
 * otherwise.
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
    path.join(main, ".github/workflows"),
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
  yield* fs.copyFile(
    ".github/workflows/release-artifacts.yml",
    path.join(main, ".github/workflows/release-artifacts.yml"),
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
  /** Lands a commit on main that changes these files, and returns it. */
  const change = (files: ReadonlyArray<string>, subject = "Change the product (#2)") =>
    Effect.gen(function* () {
      for (const file of files) {
        yield* fs.makeDirectory(path.dirname(path.join(main, file)), { recursive: true });
        yield* fs.writeFileString(path.join(main, file), `${subject}\n`, { flag: "a" });
      }
      yield* git("add", "--all");
      yield* git("commit", "--quiet", "-m", subject);
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
    /** The matrix's push runs on main; by default one that passed on `Start` just now. */
    readonly matrix?: ReadonlyArray<MatrixRun>;
    /** GitHub fails the listing of push runs. */
    readonly pushListFails?: boolean;
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
      yield* fs.writeFileString(
        path.join(github, "pushes.json"),
        JSON.stringify(
          (
            input.matrix ?? [{ id: 900, conclusion: "success", hoursAgo: 0.05, headSha: previous }]
          ).map((push) => ({
            databaseId: push.id,
            status: push.status ?? "completed",
            conclusion:
              push.status === undefined || push.status === "completed"
                ? (push.conclusion ?? "failure")
                : "",
            headSha: push.headSha,
            createdAt: ago(push.hoursAgo),
            attempt: 1,
            url: `https://github.com/${repository}/actions/runs/${push.id}`,
          })),
        ),
      );
      for (const push of input.matrix ?? [
        { id: 900, conclusion: "success", hoursAgo: 0.05, headSha: previous },
      ])
        yield* fs.writeFileString(
          path.join(github, `jobs-${push.id}.json`),
          JSON.stringify({
            jobs: [
              { name: "pace", conclusion: push.pace ?? "success", steps: [] },
              ...(push.releases === "missing"
                ? []
                : [
                    {
                      name: "releases",
                      conclusion:
                        push.releases ?? (push.conclusion === "success" ? "success" : "failure"),
                      steps: [],
                    },
                  ]),
            ],
          }),
        );
      if (input.pushListFails === true)
        yield* fs.writeFileString(path.join(github, "push-list-fails"), "");
      else yield* fs.remove(path.join(github, "push-list-fails"), { force: true });
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
              {
                name: "releases",
                conclusion: (release.conclusion ?? "failure") === "success" ? "success" : "failure",
                steps: [],
              },
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
    change,
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
      // The gate reads the jobs of the matrix run that decides, and of no run before it.
      expect(due.calls.filter((call) => call.startsWith("run view"))).toEqual([
        `run view 900 -R ${repository} --json jobs`,
      ]);
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

  it.effect(
    "a failed matrix run on main holds a new beta and another attempt until one passes",
    () =>
      Effect.gen(function* () {
        const { decide, merge, previous, released } = yield* world;
        const head = yield* merge;
        const red: MatrixRun = { id: 901, hoursAgo: 0.1, headSha: previous };
        for (const input of [
          { published: 7 },
          { runs: [{ id: 2, hoursAgo: 1, headSha: released }] },
        ]) {
          const held = yield* decide({ ...input, matrix: [red] });
          expect(held.exitCode, held.output).toBe(0);
          expect(held.outputs.decision, held.output).toBe("none");
          expect(held.output).toContain(
            `::warning::The newest finished release matrix run on main, https://github.com/${repository}/actions/runs/901, failed its releases job on ${previous}.`,
          );
          // A run still going does not clear it, and nor does an older run that passed.
          const later = yield* decide({
            ...input,
            matrix: [
              { id: 902, status: "in_progress", hoursAgo: 0.05, headSha: head },
              red,
              { id: 900, conclusion: "success", hoursAgo: 3, headSha: previous },
            ],
          });
          expect(later.outputs.decision, later.output).toBe("none");
          expect(later.outputs.reason).toContain("runs/901, failed its releases job");
        }
        const fixed = yield* decide({
          published: 7,
          matrix: [{ id: 902, conclusion: "success", hoursAgo: 0.05, headSha: head }, red],
        });
        expect(fixed.outputs.decision, fixed.output).toBe("bump");
        const retried = yield* decide({
          runs: [{ id: 2, hoursAgo: 1, headSha: released }],
          matrix: [{ id: 902, conclusion: "success", hoursAgo: 0.05, headSha: head }, red],
        });
        expect(retried.outputs.decision, retried.output).toBe("dispatch");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a build dispatched from main counts as a matrix run, and a publishing run does not",
    () =>
      Effect.gen(function* () {
        const { decide, change, previous } = yield* world;
        const head = yield* change(["packages/apps/src/index.ts"]);
        const red: MatrixRun = { id: 901, hoursAgo: 2, headSha: previous };
        const built = yield* decide({
          published: 7,
          matrix: [red],
          runs: [{ id: 5, channel: "build", conclusion: "success", hoursAgo: 1, headSha: head }],
        });
        expect(built.outputs.decision, built.output).toBe("bump");
        const failedBuild = yield* decide({
          published: 7,
          matrix: [{ id: 900, conclusion: "success", hoursAgo: 2, headSha: head }],
          runs: [{ id: 5, channel: "build", hoursAgo: 1, headSha: head }],
        });
        expect(failedBuild.outputs.decision, failedBuild.output).toBe("none");
        expect(failedBuild.outputs.reason).toContain("runs/5, failed its releases job");

        const published = yield* decide({
          published: 7,
          matrix: [red],
          runs: [{ id: 6, conclusion: "success", publish: "success", hoursAgo: 1, headSha: head }],
        });
        expect(published.outputs.decision, published.output).toBe("none");
        expect(published.outputs.reason).toContain("runs/901, failed its releases job");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a matrix run still pacing or building holds nothing; the newest finished decides",
    () =>
      Effect.gen(function* () {
        const { decide, change, previous } = yield* world;
        const head = yield* change(["apps/cli/src/main.ts"]);
        for (const status of ["queued", "in_progress"] as const) {
          const green = yield* decide({
            published: 7,
            matrix: [
              { id: 903, status, hoursAgo: 0.1, headSha: head },
              { id: 900, conclusion: "success", hoursAgo: 1, headSha: previous },
            ],
          });
          // The publishing run tests this commit on every platform before it publishes.
          expect(green.outputs.decision, green.output).toBe("bump");
          const red = yield* decide({
            published: 7,
            matrix: [
              { id: 903, status, hoursAgo: 0.1, headSha: head },
              { id: 901, hoursAgo: 1, headSha: previous },
            ],
          });
          expect(red.outputs.decision, red.output).toBe("none");
          expect(red.outputs.reason).toContain("runs/901, failed its releases job");
        }
      }).pipe(Effect.scoped),
  );

  it.effect("a run that gave way to a newer push tested nothing and never counts", () =>
    Effect.gen(function* () {
      const { decide, change, previous } = yield* world;
      const head = yield* change(["apps/cli/src/main.ts"]);
      const gaveWay: MatrixRun = { id: 903, conclusion: "cancelled", hoursAgo: 0.1, headSha: head };
      const red = yield* decide({
        published: 7,
        matrix: [gaveWay, { id: 901, hoursAgo: 1, headSha: previous }],
      });
      expect(red.outputs.decision, red.output).toBe("none");
      expect(red.outputs.reason).toContain("runs/901, failed its releases job");
      const none = yield* decide({ published: 7, matrix: [gaveWay] });
      expect(none.outputs.decision, none.output).toBe("none");
      expect(none.output).toContain("::warning::No release matrix run on main has finished");
      expect(none.outputs.reason).toContain(
        `or re-run https://github.com/${repository}/actions/runs/903, which tested nothing`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a dispatch whose channel cannot be told never counts, passed or not", () =>
    Effect.gen(function* () {
      const { decide, change, previous } = yield* world;
      const head = yield* change(["apps/cli/src/main.ts"]);
      const red: MatrixRun = { id: 901, hoursAgo: 2, headSha: previous };
      for (const conclusion of ["success", "failure"] as const) {
        const result = yield* decide({
          published: 7,
          matrix: [red],
          runs: [{ id: 5, metadata: "failure", conclusion, hoursAgo: 1, headSha: head }],
        });
        expect(result.outputs.decision, result.output).toBe("none");
        expect(result.outputs.reason).toContain("runs/901, failed its releases job");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("a push run whose pace job failed tested nothing and never counts", () =>
    Effect.gen(function* () {
      const { decide, change, previous } = yield* world;
      const head = yield* change(["apps/cli/src/main.ts"]);
      for (const pace of ["failure", "cancelled"] as const) {
        // Red as a run, from its pace job alone: the matrix never ran.
        const untested: MatrixRun = {
          id: 905,
          pace,
          releases: "failure",
          hoursAgo: 0.1,
          headSha: head,
        };
        const green = yield* decide({
          published: 7,
          matrix: [untested, { id: 900, conclusion: "success", hoursAgo: 1, headSha: previous }],
        });
        expect(green.outputs.decision, green.output).toBe("bump");
        const alone = yield* decide({ published: 7, matrix: [untested] });
        expect(alone.outputs.decision, alone.output).toBe("none");
        expect(alone.outputs.reason).toContain(
          "No release matrix run on main has finished testing",
        );
        expect(alone.outputs.reason).toContain(
          "gh workflow run release-artifacts.yml --ref main -f channel=build",
        );
        expect(alone.outputs.reason).toContain("runs/905, which tested nothing");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("a run red only from its report job passed the matrix", () =>
    Effect.gen(function* () {
      const { decide, change } = yield* world;
      const head = yield* change(["apps/cli/src/main.ts"]);
      const result = yield* decide({
        published: 7,
        matrix: [
          { id: 906, conclusion: "failure", releases: "success", hoursAgo: 0.1, headSha: head },
        ],
      });
      expect(result.outputs.decision, result.output).toBe("bump");
    }).pipe(Effect.scoped),
  );

  it.effect("a red matrix says how to clear the hold once the cause is fixed", () =>
    Effect.gen(function* () {
      const { decide, merge, previous } = yield* world;
      yield* merge;
      const held = yield* decide({
        published: 7,
        matrix: [{ id: 901, hoursAgo: 1, headSha: previous }],
      });
      expect(held.outputs.reason).toContain(
        "fix the cause, then dispatch Executor releases from main with channel build (gh workflow run release-artifacts.yml --ref main -f channel=build), or merge the fix",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("the gate reads finished push runs past a busy day of runs that gave way", () =>
    Effect.gen(function* () {
      const { decide, change, previous } = yield* world;
      const head = yield* change(["apps/cli/src/main.ts"]);
      const gaveWay = Array.from({ length: 40 }, (_, index): MatrixRun => ({
        id: 1000 + index,
        conclusion: "cancelled",
        hoursAgo: 0.1 + index * 0.1,
        headSha: head,
      }));
      const result = yield* decide({
        published: 7,
        matrix: [
          { id: 999, status: "in_progress", hoursAgo: 0.05, headSha: head },
          ...gaveWay,
          { id: 901, hoursAgo: 5, headSha: previous },
        ],
      });
      expect(result.outputs.decision, result.output).toBe("none");
      expect(result.outputs.reason).toContain("runs/901, failed its releases job");
      expect(result.calls).toContain(
        `run list -R ${repository} -w release-artifacts.yml -e push -b main -s completed -L 100 --json databaseId,status,conclusion,headSha,createdAt,attempt,url`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a GitHub failure, or a run without a releases job, stops the gate", () =>
    Effect.gen(function* () {
      const { decide, merge, previous } = yield* world;
      yield* merge;
      const failed = yield* decide({ published: 7, pushListFails: true });
      expect(failed.exitCode, failed.output).not.toBe(0);
      expect(failed.output).toContain("HTTP 502: Bad Gateway");
      expect(failed.outputs.decision).toBeUndefined();
      const unjudged = yield* decide({
        published: 7,
        matrix: [
          { id: 907, conclusion: "success", releases: "missing", hoursAgo: 0.1, headSha: previous },
        ],
      });
      expect(unjudged.exitCode, unjudged.output).not.toBe(0);
      expect(unjudged.output).toContain("runs/907 has no releases job");
      expect(unjudged.outputs.decision).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("no finished matrix run on main publishes nothing", () =>
    Effect.gen(function* () {
      const { decide, merge } = yield* world;
      yield* merge;
      const none = yield* decide({ published: 7, matrix: [] });
      expect(none.outputs.decision, none.output).toBe("none");
      expect(none.output).toContain("::warning::No release matrix run on main has finished");
    }).pipe(Effect.scoped),
  );

  it.effect("waiting and re-running read no matrix runs", () =>
    Effect.gen(function* () {
      const { decide, released } = yield* world;
      const unchanged = yield* decide({ published: 30, matrix: [] });
      expect(unchanged.outputs.decision).toBe("none");
      const rerun = yield* decide({
        matrix: [],
        runs: [{ id: 7, publish: "failure", hoursAgo: 1, headSha: released }],
      });
      expect(rerun.outputs.decision, rerun.output).toBe("rerun");
      for (const result of [unchanged, rerun])
        expect(result.calls.filter((call) => call.includes("-e push"))).toEqual([]);
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

/**
 * Answers `gh api <path> --jq <filter>` by applying the filter to `$FAKE_GITHUB/<path with every
 * character but letters and digits as _>.json` with jq, as gh does, and records `gh run cancel`.
 * `sleep` records how long it was asked to wait and returns at once.
 */
const stubPaceGh = `#!/bin/sh
echo "$*" >> "$FAKE_GITHUB/calls"
if [ "$1 $2" = "run cancel" ]; then exit 0; fi
[ "$1" = api ] && [ "$3" = --jq ] || { echo "stub gh: unsupported: $*" >&2; exit 2; }
jq -r "$4" "$FAKE_GITHUB/$(printf '%s' "$2" | tr -c 'A-Za-z0-9' _).json"
`;
const stubSleep = `#!/bin/sh
echo "$1" >> "$FAKE_GITHUB/sleeps"
`;

/** A push run of Executor releases on main, as the runs list reports it. */
interface PushRun {
  readonly id: number;
  /** Hours since the run was created. */
  readonly created: number;
  readonly status?: "completed" | "in_progress" | "pending";
  readonly conclusion?: "success" | "failure" | "cancelled";
  /** Hours since its pace job passed, when it did. */
  readonly built?: number;
}

const pace = (self: number, runs: ReadonlyArray<PushRun>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-matrix-pace-" });
    const bin = path.join(root, "bin");
    const github = path.join(root, "github");
    yield* fs.makeDirectory(bin);
    yield* fs.makeDirectory(github);
    for (const [name, text] of [
      ["gh", stubPaceGh],
      ["sleep", stubSleep],
    ] as const) {
      yield* fs.writeFileString(path.join(bin, name), text);
      yield* fs.chmod(path.join(bin, name), 0o755);
    }
    const file = (api: string) => path.join(github, `${api.replace(/[^A-Za-z0-9]/g, "_")}.json`);
    const iso = (hours: number) =>
      new Date(Date.now() - hours * hour).toISOString().replace(/\.\d+/, "");
    const listed = runs.map((push) => ({
      id: push.id,
      created_at: iso(push.created),
      status: push.status ?? "completed",
      conclusion:
        (push.status ?? "completed") === "completed" ? (push.conclusion ?? "success") : null,
    }));
    const list = `repos/${repository}/actions/workflows/release-artifacts.yml/runs?branch=main&event=push`;
    // The script reads finished runs for the last build, and every run for a newer push.
    yield* fs.writeFileString(
      file(`${list}&status=completed&per_page=100`),
      JSON.stringify({ workflow_runs: listed.filter((push) => push.status === "completed") }),
    );
    yield* fs.writeFileString(
      file(`${list}&per_page=30`),
      JSON.stringify({ workflow_runs: listed }),
    );
    for (const push of runs) {
      yield* fs.writeFileString(
        file(`repos/${repository}/actions/runs/${push.id}`),
        JSON.stringify({ created_at: iso(push.created) }),
      );
      yield* fs.writeFileString(
        file(`repos/${repository}/actions/runs/${push.id}/jobs?per_page=100`),
        JSON.stringify({
          jobs: [
            {
              name: "pace",
              conclusion: push.built === undefined ? "failure" : "success",
              completed_at: push.built === undefined ? null : iso(push.built),
            },
          ],
        }),
      );
    }
    yield* fs.writeFileString(path.join(github, "calls"), "");
    yield* fs.writeFileString(path.join(github, "sleeps"), "");
    const result = yield* run(root, path.resolve("scripts/releases/matrix-pace.sh"), [], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_GITHUB: github,
      GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: String(self),
    });
    const lines = (name: string) =>
      fs
        .readFileString(path.join(github, name))
        .pipe(Effect.map((text) => text.split("\n").filter((line) => line !== "")));
    return {
      ...result,
      calls: yield* lines("calls"),
      sleeps: (yield* lines("sleeps")).map(Number),
    };
  });

layer(NodeServices.layer, { excludeTestServices: true })("Release matrix pacing", (it) => {
  const self: PushRun = { id: 10, created: 0, status: "in_progress" };

  it.effect("a push builds at once when no build started in the last two hours", () =>
    Effect.gen(function* () {
      const first = yield* pace(10, [self]);
      expect(first.exitCode, first.output).toBe(0);
      expect(first.output).toContain("No earlier push run on main built");
      const later = yield* pace(10, [self, { id: 9, created: 3, built: 2.9 }]);
      expect(later.exitCode, later.output).toBe(0);
      expect(later.output).toContain("so this run builds now");
      for (const result of [first, later]) {
        expect(result.sleeps).toEqual([]);
        expect(result.calls.some((call) => call.startsWith("run cancel"))).toBe(false);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("a push soon after a build waits for the two-hour mark, then builds", () =>
    Effect.gen(function* () {
      const result = yield* pace(10, [self, { id: 9, created: 0.6, built: 0.5 }]);
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain("No newer push is waiting, so this run builds.");
      expect(result.sleeps.length).toBe(1);
      expect(result.sleeps[0]).toBeGreaterThan(1.5 * 3600 - 60);
      expect(result.sleeps[0]).toBeLessThanOrEqual(1.5 * 3600);
    }).pipe(Effect.scoped),
  );

  it.effect("a waiting push gives way to a newer one by cancelling itself", () =>
    Effect.gen(function* () {
      const result = yield* pace(10, [
        { id: 11, created: -0.2, status: "pending" },
        self,
        { id: 9, created: 0.6, built: 0.5 },
      ]);
      expect(result.calls).toContain(`run cancel 10 --repo ${repository}`);
      // Still running after its cancellation, it fails rather than pass having tested nothing.
      expect(result.exitCode, result.output).toBe(1);
      expect(result.output).toContain(
        "::error::This run asked to be cancelled, yet is still running",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a cancelled run, or one whose pace did not pass, is not the last build", () =>
    Effect.gen(function* () {
      const result = yield* pace(10, [
        self,
        { id: 9, created: 0.3, conclusion: "cancelled", built: 0.2 },
        { id: 8, created: 0.5, conclusion: "failure" },
        { id: 7, created: 3, built: 2.9 },
      ]);
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain("The last build, run 7,");
      expect(result.sleeps).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

/**
 * A `gh` for `scripts/releases/matrix-issue.sh`. `gh api <path>` answers from
 * `$FAKE_GITHUB/<path with every character but letters and digits as _>`: `.json` through the
 * call's `--jq` filter, `.txt` as a job's log, and a 404 when neither exists, as for a deleted run.
 * The open issue is `open.json`; `issue view N` reads `issue-N.json`; `issue edit` and `issue
 * create` copy their body file to `edited-N.md` and `created.md`. Every call goes to `calls`.
 */
const stubIssueGh = `#!/bin/sh
dir="$FAKE_GITHUB"
echo "$*" >> "$dir/calls"
filter=""
case "$1 $2" in
  "api --paginate") path=$3; filter=$5 ;;
  "issue list") exec jq -r '.[0].number // empty' "$dir/open.json" ;;
  "issue view") exec jq -r .body "$dir/issue-$3.json" ;;
  "issue edit")
    number=$3
    while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$dir/edited-$number.md"; shift; done
    exit 0 ;;
  "issue create")
    while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$dir/created.md"; shift; done
    exit 0 ;;
  "issue close"|"label create") exit 0 ;;
  api*) path=$2; [ "$3" = --jq ] && filter=$4 ;;
  *) echo "stub gh: unsupported: $*" >&2; exit 2 ;;
esac
file="$dir/$(printf '%s' "$path" | tr -c 'A-Za-z0-9' _)"
if [ -f "$file.txt" ]; then exec cat "$file.txt"; fi
[ -f "$file.json" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
if [ -n "$filter" ]; then exec jq -r "$filter" "$file.json"; fi
exec cat "$file.json"
`;

/** A finished Executor releases run on main, as the runs list and its jobs report it. */
interface MainRun {
  readonly id: number;
  /** Hours before this run was created; negative when created after it. */
  readonly created: number;
  readonly event?: "push" | "workflow_dispatch";
  readonly sha: string;
  readonly conclusion?: "success" | "failure" | "cancelled";
  /** Its pace job, for a push run. */
  readonly pace?: "success" | "failure";
  /** A dispatch that published rather than built. */
  readonly publishing?: boolean;
  /** Its releases job; by default as the run concluded. */
  readonly releases?: "success" | "failure";
}

const issueWorld = (input: {
  /** Each job's result, as the report job's needs give it. */
  readonly needs: Readonly<Record<string, string>>;
  readonly runs?: ReadonlyArray<MainRun>;
  /** This run's failed jobs and their logs. */
  readonly failed?: ReadonlyArray<{
    readonly id: number;
    readonly name: string;
    readonly log: string;
  }>;
  readonly issue?: { readonly number: number; readonly body: string };
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-matrix-issue-" });
    const bin = path.join(root, "bin");
    const github = path.join(root, "github");
    yield* fs.makeDirectory(bin);
    yield* fs.makeDirectory(github);
    yield* fs.writeFileString(path.join(bin, "gh"), stubIssueGh);
    yield* fs.chmod(path.join(bin, "gh"), 0o755);
    const save = (api: string, value: unknown, extension = "json") =>
      fs.writeFileString(
        path.join(github, `${api.replace(/[^A-Za-z0-9]/g, "_")}.${extension}`),
        typeof value === "string" ? value : JSON.stringify(value),
      );
    const iso = (hours: number) =>
      new Date(Date.now() - hours * hour).toISOString().replace(/\.\d+/, "");
    const self = 50;
    const api = `repos/${repository}/actions`;
    yield* save(`${api}/runs/${self}`, { created_at: iso(0) });
    const runs = input.runs ?? [];
    yield* save(
      `${api}/workflows/release-artifacts.yml/runs?branch=main&status=completed&per_page=100`,
      {
        workflow_runs: runs.map((main) => ({
          id: main.id,
          created_at: iso(main.created),
          event: main.event ?? "push",
          head_sha: main.sha,
          conclusion: main.conclusion ?? "success",
          html_url: `https://github.com/${repository}/actions/runs/${main.id}`,
        })),
      },
    );
    for (const main of runs) {
      yield* save(`${api}/runs/${main.id}`, { created_at: iso(main.created) });
      yield* save(`${api}/runs/${main.id}/jobs?per_page=100`, {
        jobs: [
          { name: "pace", conclusion: main.pace ?? "success", steps: [] },
          {
            name: "metadata",
            conclusion: "success",
            steps: [
              {
                name: "Check the apps release is published unchanged",
                conclusion: main.publishing === true ? "success" : "skipped",
              },
            ],
          },
          {
            name: "releases",
            conclusion: main.releases ?? (main.conclusion === "failure" ? "failure" : "success"),
            steps: [],
          },
        ],
      });
    }
    const failed = input.failed ?? [];
    yield* save(`${api}/runs/${self}/attempts/1/jobs?per_page=100`, {
      jobs: failed.map((job) => ({
        id: job.id,
        name: job.name,
        conclusion: "failure",
        html_url: `https://github.com/${repository}/actions/runs/${self}/job/${job.id}`,
      })),
    });
    for (const job of failed) yield* save(`${api}/jobs/${job.id}/logs`, job.log, "txt");
    yield* fs.writeFileString(
      path.join(github, "open.json"),
      JSON.stringify(input.issue === undefined ? [] : [{ number: input.issue.number }]),
    );
    if (input.issue !== undefined)
      yield* fs.writeFileString(
        path.join(github, `issue-${input.issue.number}.json`),
        JSON.stringify({ body: input.issue.body }),
      );
    yield* fs.writeFileString(path.join(github, "calls"), "");
    const result = yield* run(root, path.resolve("scripts/releases/matrix-issue.sh"), [], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_GITHUB: github,
      NEEDS: JSON.stringify(
        Object.fromEntries(Object.entries(input.needs).map(([job, result]) => [job, { result }])),
      ),
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: String(self),
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: "c".repeat(40),
      RUNNER_TEMP: root,
    });
    const read = (name: string) =>
      fs
        .exists(path.join(github, name))
        .pipe(
          Effect.flatMap((exists) =>
            exists ? fs.readFileString(path.join(github, name)) : Effect.succeed(undefined),
          ),
        );
    return {
      ...result,
      calls: (yield* read("calls"))!.split("\n").filter((line) => line !== ""),
      created: yield* read("created.md"),
      edited:
        input.issue === undefined ? undefined : yield* read(`edited-${input.issue.number}.md`),
    };
  });

const passed = {
  pace: "success",
  metadata: "success",
  "git-sources": "success",
  "bun-runtime": "success",
  local: "success",
  cli: "success",
  archives: "success",
  docker: "success",
};
const runUrl = (id: number) => `https://github.com/${repository}/actions/runs/${id}`;

layer(NodeServices.layer, { excludeTestServices: true })("Red matrix issue", (it) => {
  it.effect("a first failure opens the issue with its jobs and scenarios, safe as text", () =>
    Effect.gen(function* () {
      const result = yield* issueWorld({
        needs: { ...passed, local: "failure", archives: "skipped" },
        runs: [{ id: 30, created: 3, sha: "a".repeat(40) }],
        failed: [
          {
            id: 7001,
            name: "local (linux, x64, true, `x`)",
            log: [
              "2026-11-12T10:00:00.0000000Z \u001b[31m FAIL \u001b[39m e2e/tests/desktop-release.spec.ts > desktop > keeps `keys` for @someone",
              "2026-11-12T10:00:00.0000000Z  FAIL  e2e/tests/installer.spec.ts > installs",
              "2026-11-12T10:00:00.0000000Z AssertionError: expected 1 to be 2",
            ].join("\n"),
          },
          {
            id: 7002,
            name: "docker (amd64)",
            log: "2026-11-12T10:00:00Z  × e2e/tests/docker-release.spec.ts > setup opens the account step 61000ms\n",
          },
        ],
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.calls.some((call) => call.startsWith("label create release-matrix-red"))).toBe(
        true,
      );
      const body = result.created!;
      expect(body).toContain(`- Latest failure: ${runUrl(50)} on ${"c".repeat(40)}`);
      expect(body).toContain(`- First failure: ${runUrl(50)} on ${"c".repeat(40)}`);
      expect(body).toContain(
        `- Last green run before it: ${runUrl(30)} on ${"a".repeat(40)}. The first failure came from a commit in https://github.com/${repository}/compare/${"a".repeat(40)}...${"c".repeat(40)}`,
      );
      expect(body).toContain(`- [local (linux, x64, true, x)](${runUrl(50)}/job/7001)`);
      expect(body).toContain(
        "  - `e2e/tests/desktop-release.spec.ts > desktop > keeps keys for someone`",
      );
      expect(body).toContain("  - `e2e/tests/installer.spec.ts > installs`");
      expect(body).toContain(
        "  - `e2e/tests/docker-release.spec.ts > setup opens the account step`",
      );
      // Each scenario is one code span: two backticks, and no @ to mention anyone.
      for (const line of body.split("\n").filter((entry) => entry.startsWith("  - `")))
        expect(line.match(/[`@]/g), line).toEqual(["`", "`"]);
      expect(body).toContain(`<!-- first-red: ${"c".repeat(40)} ${runUrl(50)} -->`);
    }).pipe(Effect.scoped),
  );

  it.effect("a later failure rewrites the open issue and keeps its first failure", () =>
    Effect.gen(function* () {
      const result = yield* issueWorld({
        needs: { ...passed, docker: "failure" },
        runs: [
          { id: 40, created: 1, sha: "b".repeat(40), conclusion: "failure" },
          { id: 30, created: 3, sha: "a".repeat(40) },
        ],
        failed: [{ id: 7003, name: "docker (arm64)", log: "no summary" }],
        issue: {
          number: 12,
          body: `Old body.\n\n<!-- first-red: ${"b".repeat(40)} ${runUrl(40)} -->`,
        },
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.created).toBeUndefined();
      expect(result.calls.some((call) => call.startsWith("issue create"))).toBe(false);
      const body = result.edited!;
      expect(body).toContain(`- Latest failure: ${runUrl(50)}`);
      expect(body).toContain(`- First failure: ${runUrl(40)} on ${"b".repeat(40)}`);
      expect(body).toContain(`- Last green run before it: ${runUrl(30)} on ${"a".repeat(40)}`);
      expect(body).toContain("  - No failed scenario in its log; see the job's failed step.");
      expect(body).toContain(`<!-- first-red: ${"b".repeat(40)} ${runUrl(40)} -->`);
    }).pipe(Effect.scoped),
  );

  it.effect("a first failure whose run was deleted still updates the issue", () =>
    Effect.gen(function* () {
      const result = yield* issueWorld({
        needs: { ...passed, cli: "failure" },
        runs: [{ id: 30, created: 3, sha: "a".repeat(40) }],
        failed: [{ id: 7004, name: "cli (linux)", log: "" }],
        issue: { number: 12, body: `<!-- first-red: ${"d".repeat(40)} ${runUrl(41)} -->` },
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.edited).toContain(`- First failure: ${runUrl(41)} on ${"d".repeat(40)}`);
      expect(result.edited).toContain(`<!-- first-red: ${"d".repeat(40)} ${runUrl(41)} -->`);
    }).pipe(Effect.scoped),
  );

  it.effect("a green run closes the open issue, and with none open does nothing", () =>
    Effect.gen(function* () {
      const closed = yield* issueWorld({
        needs: passed,
        issue: { number: 12, body: "Red." },
      });
      expect(closed.exitCode, closed.output).toBe(0);
      expect(closed.edited).toBe(`Red.\n\nPassed again in ${runUrl(50)} on ${"c".repeat(40)}.\n`);
      expect(closed.calls).toContain(`issue close 12 --repo ${repository} --reason completed`);
      const quiet = yield* issueWorld({ needs: passed });
      expect(quiet.exitCode, quiet.output).toBe(0);
      expect(
        quiet.calls.some((call) => call.startsWith("issue ") && !call.startsWith("issue list")),
      ).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("a newer finished matrix run decides; runs that tested nothing do not", () =>
    Effect.gen(function* () {
      for (const newer of [
        { id: 60, created: -0.5, sha: "e".repeat(40) },
        { id: 61, created: -0.5, sha: "e".repeat(40), event: "workflow_dispatch" as const },
      ]) {
        const result = yield* issueWorld({
          needs: { ...passed, local: "failure" },
          runs: [newer],
          failed: [{ id: 7005, name: "local", log: "" }],
        });
        expect(result.exitCode, result.output).toBe(0);
        expect(result.output).toContain(
          `Matrix run ${newer.id} on main, created after this one, has finished`,
        );
        expect(result.calls.some((call) => call.startsWith("issue"))).toBe(false);
      }
      const untested = yield* issueWorld({
        needs: { ...passed, local: "failure" },
        runs: [
          { id: 62, created: -0.5, sha: "e".repeat(40), pace: "failure" },
          {
            id: 63,
            created: -0.4,
            sha: "e".repeat(40),
            event: "workflow_dispatch",
            publishing: true,
          },
        ],
        failed: [{ id: 7006, name: "local", log: "" }],
      });
      expect(untested.exitCode, untested.output).toBe(0);
      expect(untested.created).toBeDefined();
    }).pipe(Effect.scoped),
  );

  it.effect("a run whose pace job did not pass leaves the issue alone", () =>
    Effect.gen(function* () {
      const result = yield* issueWorld({
        needs: { ...passed, pace: "failure", metadata: "skipped", local: "skipped" },
        issue: { number: 12, body: "Red." },
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain("The pace job ended failure");
      expect(result.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
