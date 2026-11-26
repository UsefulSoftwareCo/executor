import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const repository = "UsefulSoftwareCo/executor-next";
const version = "2.0.0-beta.5";
const apps = "0.0.1-beta.3";
const hour = 60 * 60 * 1000;

const apiReads = (calls: ReadonlyArray<string>) =>
  calls.filter((call) => call.startsWith("api ")).map((call) => call.split(" --jq ")[0]);
const runsPage = (page: number) =>
  `api repos/${repository}/actions/workflows/release-artifacts.yml/runs?event=workflow_dispatch&branch=main&per_page=100&page=${page}`;
const attemptRead = (run: number, attempt: number) =>
  `api repos/${repository}/actions/runs/${run}/attempts/${attempt}`;

const stubNpm = `#!/bin/sh
[ "$1" = view ] && [ "$3 $4 $5" = "time dist-tags --json" ] || { echo "stub npm: unsupported: $*" >&2; exit 2; }
cat "$FAKE_NPM/$2.json"
`;

const stubGh = `#!/bin/sh
echo "$*" >> "$FAKE_GITHUB/calls"
if [ "$1 $2" = "run list" ]; then
  [ -f "$FAKE_GITHUB/list-fails" ] && { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
  while [ $# -gt 0 ]; do
    case "$1" in -e) event=$2 ;; -L) limit=$2 ;; esac
    shift
  done
  exec jq --arg event "$event" --argjson limit "$limit" '[.[] | select(.event == $event)][:$limit] | map(del(.event))' "$FAKE_GITHUB/runs.json"
fi
case "$1 $2 $*" in
  "run view "*) cat "$FAKE_GITHUB/jobs-$3.json" ;;
  "api "*/attempts/*) exec cat "$FAKE_GITHUB/attempt-$(echo "$2" | sed 's|.*/runs/||; s|/attempts/|-|').json" ;;
  "api "*/workflows/release-artifacts.yml/runs\\?*)
    page=$(echo "$2" | sed 's/.*[?&]page=\\([0-9]*\\).*/\\1/')
    exec jq -c --argjson page "$page" '[.[] | select(.event == "workflow_dispatch")][($page - 1) * 100:$page * 100] | map(del(.event))' "$FAKE_GITHUB/runs.json" ;;
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
  readonly attemptsHoursAgo?: ReadonlyArray<number>;
  readonly publish?: "success" | "failure" | "cancelled" | "skipped";
  readonly channel?: "beta" | "build";
  readonly metadata?: "success" | "failure";
  readonly title?: string;
  readonly publishingStep?: string;
  readonly dockerPush?: "success" | "failure" | "skipped";
  readonly failedJobs?: ReadonlyArray<{ readonly name: string; readonly step: string }>;
  readonly publishSteps?: ReadonlyArray<{ readonly name: string; readonly conclusion: string }>;
  readonly startedHoursAgo?: number;
  readonly attemptsStartedHoursAgo?: ReadonlyArray<number>;
}

interface MatrixRun {
  readonly id: number;
  readonly status?: "queued" | "in_progress" | "completed";
  readonly conclusion?: "success" | "failure" | "cancelled";
  readonly hoursAgo: number;
  readonly headSha: string;
  readonly pace?: "success" | "failure" | "cancelled";
  readonly releases?: "success" | "failure" | "skipped" | "missing";
  readonly metadata?: "success" | "skipped";
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
  for (const workflow of ["release-artifacts.yml", "bun-runtime.yml"])
    yield* fs.copyFile(
      `.github/workflows/${workflow}`,
      path.join(main, `.github/workflows/${workflow}`),
    );
  yield* git("init", "--quiet");
  yield* git("add", "--all");
  yield* git("commit", "--quiet", "-m", "Start");
  const previous = yield* git("rev-parse", "HEAD");
  yield* git("commit", "--quiet", "--allow-empty", "-m", `Release ${version}`);
  const released = yield* git("rev-parse", "HEAD");

  const merge = Effect.gen(function* () {
    yield* git("commit", "--quiet", "--allow-empty", "-m", "Change the product (#1)");
    return yield* git("rev-parse", "HEAD");
  });
  const mergeAt = (hoursAgo: number) =>
    Effect.gen(function* () {
      const date = new Date(Date.now() - hoursAgo * hour).toISOString();
      const result = yield* run(
        main,
        "git",
        ["commit", "--quiet", "--allow-empty", "-m", "Change the product (#3)"],
        { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      );
      expect(result.exitCode, result.output).toBe(0);
      return yield* git("rev-parse", "HEAD");
    });
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

  const lockRefresh = Effect.gen(function* () {
    yield* git(
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Refresh bun.lock [skip ci]",
      "-m",
      '"packages/apps": "0.0.1-beta.1" -> "0.0.1-beta.2"',
    );
    return yield* git("rev-parse", "HEAD");
  });

  const clock = path.join(root, "clock.cjs");
  yield* fs.writeFileString(
    clock,
    "const now = Number(process.env.BETA_DUE_NOW);\nDate.now = () => now;\n",
  );
  const realGit = (yield* run(root, "sh", ["-c", "command -v git"], env)).output.trim();
  const gitBin = path.join(root, "git-bin");
  yield* fs.makeDirectory(gitBin);
  const stalled = path.join(root, "stalled");
  const timers = path.join(root, "timers.cjs");
  yield* fs.writeFileString(
    timers,
    [
      'const fs = require("node:fs");',
      "const later = setTimeout;",
      "globalThis.setTimeout = (callback, delay, ...args) =>",
      "  delay >= 10_000 && delay <= 60_000",
      "    ? later(function fire() {",
      "        if (fs.existsSync(process.env.BETA_DUE_STALLED)) callback(...args);",
      "        else later(fire, 5);",
      "      }, 0)",
      "    : later(callback, delay, ...args);",
      "",
    ].join("\n"),
  );
  const alive = (pid: string) =>
    run(root, "sh", ["-c", 'kill -0 "$1" 2>/dev/null', "sh", pid], env).pipe(
      Effect.map((result) => result.exitCode === 0),
    );
  const decide = (input: {
    readonly at?: string;
    readonly event?: "push" | "schedule" | "workflow_dispatch" | "workflow_run" | "pull_request";
    readonly published?: number;
    readonly npmTimes?: Readonly<Record<string, number>>;
    readonly betaTag?: string;
    readonly appsPublished?: boolean;
    readonly runs?: ReadonlyArray<ReleaseRun>;
    readonly matrix?: ReadonlyArray<MatrixRun>;
    readonly listFails?: boolean;
    readonly green?: ReadonlyArray<{ readonly headSha: string; readonly hoursAgo: number }>;
    readonly git?: string;
    readonly stall?: boolean;
  }) =>
    Effect.gen(function* () {
      const now = input.at === undefined ? Date.now() : Date.parse(input.at);
      const ago = (hours: number) => new Date(Math.round(now - hours * hour)).toISOString();
      const time: Record<string, string> = Object.fromEntries(
        Object.entries(input.npmTimes ?? { "2.0.0-beta.4": 30 }).map(([released, hours]) => [
          released,
          ago(hours),
        ]),
      );
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
      const checks = input.matrix ?? [
        { id: 900, conclusion: "success", hoursAgo: 0.05, headSha: previous },
      ];
      for (const check of checks)
        yield* fs.writeFileString(
          path.join(github, `jobs-${check.id}.json`),
          JSON.stringify({
            jobs: [
              { name: "pace", conclusion: check.pace ?? "success", steps: [] },
              { name: "metadata", conclusion: check.metadata ?? "success", steps: [] },
              ...(check.releases === "missing"
                ? []
                : [
                    {
                      name: "releases",
                      conclusion:
                        check.releases ?? (check.conclusion === "success" ? "success" : "failure"),
                      steps: [],
                    },
                  ]),
            ],
          }),
        );
      if (input.listFails === true) yield* fs.writeFileString(path.join(github, "list-fails"), "");
      else yield* fs.remove(path.join(github, "list-fails"), { force: true });
      const runs = input.runs ?? [];
      const listed = (run: {
        readonly id: number;
        readonly status?: string;
        readonly conclusion?: string;
        readonly headSha: string;
        readonly hoursAgo: number;
        readonly attempt?: number;
        readonly attemptsHoursAgo?: ReadonlyArray<number>;
        readonly startedHoursAgo?: number;
      }) => ({
        databaseId: run.id,
        status: run.status ?? "completed",
        conclusion:
          run.status === undefined || run.status === "completed"
            ? (run.conclusion ?? "failure")
            : "",
        headSha: run.headSha,
        createdAt: ago(run.hoursAgo),
        startedAt: ago(run.startedHoursAgo ?? run.attemptsHoursAgo?.at(-1) ?? run.hoursAgo),
        updatedAt: ago(run.attemptsHoursAgo?.at(-1) ?? run.hoursAgo),
        attempt: run.attempt ?? 1,
        url: `https://github.com/${repository}/actions/runs/${run.id}`,
      });
      const checkEvent = (yield* fs.readFileString(
        path.resolve(".github/workflows/release-check.yml"),
      )).includes("/dispatches")
        ? "repository_dispatch"
        : "workflow_dispatch";
      yield* fs.writeFileString(
        path.join(github, "runs.json"),
        JSON.stringify(
          [
            ...checks.map((check) => ({
              hoursAgo: check.hoursAgo,
              run: {
                ...listed(check),
                event: checkEvent,
                displayTitle: "Executor releases (check)",
              },
            })),
            ...(input.green ?? []).map((ci, index) => ({
              hoursAgo: ci.hoursAgo,
              run: {
                ...listed({ id: 5000 + index, conclusion: "success", ...ci }),
                event: "push",
                displayTitle: "Change the product",
              },
            })),
            ...runs.map((release) => ({
              hoursAgo: release.hoursAgo,
              run: {
                ...listed(release),
                event: "workflow_dispatch",
                displayTitle:
                  release.title ??
                  `Executor releases (${release.channel === "build" ? "build" : "beta"})`,
              },
            })),
          ]
            .sort((a, b) => a.hoursAgo - b.hoursAgo)
            .map(({ run }) => run),
        ),
      );
      for (const release of runs) {
        for (const [index, hoursAgo] of (release.attemptsHoursAgo ?? []).entries())
          yield* fs.writeFileString(
            path.join(github, `attempt-${release.id}-${index + 1}.json`),
            JSON.stringify({
              startedAt: ago(release.attemptsStartedHoursAgo?.[index] ?? hoursAgo),
              updatedAt: ago(hoursAgo),
            }),
          );
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
                conclusion:
                  release.dockerPush === "failure" || release.publish === undefined
                    ? "failure"
                    : "success",
                steps:
                  release.dockerPush === undefined
                    ? []
                    : [
                        {
                          name: "Verify setup, OAuth, execution, retained data and interrupted renewals",
                          conclusion: "success",
                        },
                        {
                          name: "Push the tested architecture without moving a channel",
                          conclusion: release.dockerPush,
                        },
                      ],
              },
              ...(release.failedJobs ?? []).map((job) => ({
                name: job.name,
                conclusion: "failure",
                steps: [
                  { name: "Set up job", conclusion: "success" },
                  { name: job.step, conclusion: "failure" },
                ],
              })),
              {
                name: "publish",
                conclusion: release.publish ?? "skipped",
                steps: release.publishSteps ?? [],
              },
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
      yield* fs.remove(stalled, { force: true });
      if (input.git !== undefined) {
        yield* fs.writeFileString(
          path.join(gitBin, "git"),
          `#!/bin/sh\n${input.git}\nexec "${realGit}" "$@"\n`,
        );
        yield* fs.chmod(path.join(gitBin, "git"), 0o755);
      }
      const result = yield* run(
        main,
        "node",
        [
          ...(input.at === undefined ? [] : ["--require", clock]),
          ...(input.stall === true ? ["--require", timers] : []),
          script,
        ],
        {
          ...env,
          ...(input.git === undefined ? {} : { PATH: `${gitBin}:${env.PATH}` }),
          GITHUB_OUTPUT: output,
          GITHUB_EVENT_NAME: input.event ?? "schedule",
          BETA_DUE_STALLED: stalled,
          ...(input.at === undefined ? {} : { BETA_DUE_NOW: String(now) }),
        },
      );
      const stalledPid = (yield* fs.exists(stalled))
        ? (yield* fs.readFileString(stalled)).trim()
        : undefined;
      const lookup =
        stalledPid === undefined
          ? undefined
          : { pid: stalledPid, running: yield* alive(stalledPid) };
      if (lookup?.running === true)
        yield* run(root, "sh", ["-c", 'kill -KILL "$1"', "sh", lookup.pid], env);
      const outputs = Object.fromEntries(
        (yield* fs.readFileString(output))
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      const calls = (yield* fs.readFileString(path.join(github, "calls")))
        .split("\n")
        .filter((line) => line !== "");
      return { ...result, outputs, calls, lookup };
    });

  yield* run(root, "git", ["init", "--quiet", "--bare", remote], env);
  yield* git("push", "--quiet", remote, "HEAD:main");
  const remoteMain = Effect.gen(function* () {
    const result = yield* run(root, "git", ["--git-dir", remote, "rev-parse", "main"], env);
    expect(result.exitCode, result.output).toBe(0);
    return result.output.trim();
  });
  const land = Effect.gen(function* () {
    const merged = yield* merge;
    yield* git("push", "--quiet", remote, "HEAD:main");
    return merged;
  });
  const mergeElsewhere = Effect.gen(function* () {
    const head = yield* git("rev-parse", "HEAD");
    const merged = yield* merge;
    yield* git("push", "--quiet", remote, "HEAD:main");
    yield* git("reset", "--quiet", "--hard", head);
    return merged;
  });
  const refusePushes = Effect.gen(function* () {
    const hook = path.join(remote, "hooks/pre-receive");
    yield* fs.writeFileString(hook, "#!/bin/sh\necho 'push declined by a ruleset' >&2\nexit 1\n");
    yield* fs.chmod(hook, 0o755);
  });
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
  const commitAt = (files: Readonly<Record<string, string>>, subject: string, date?: string) =>
    Effect.gen(function* () {
      for (const [name, text] of Object.entries(files))
        yield* fs.writeFileString(path.join(main, name), text);
      const result = yield* run(
        main,
        "git",
        ["commit", "--quiet", "--allow-empty", "-am", subject],
        date === undefined ? env : { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      );
      expect(result.exitCode, result.output).toBe(0);
      return yield* git("rev-parse", "HEAD");
    });
  const manifest = (other: string) =>
    `${JSON.stringify({ name: "executor", version: other }, null, 2)}\n`;
  const onVersion = (other: string, date?: string) =>
    commitAt({ "apps/cli/package.json": manifest(other) }, `Release ${other}`, date);
  const aside = (files: Readonly<Record<string, string>>, subject: string) =>
    Effect.gen(function* () {
      const head = yield* git("rev-parse", "HEAD");
      const commit = yield* commitAt(files, subject);
      yield* git("reset", "--quiet", "--hard", head);
      return commit;
    });
  const atVersion = (other: string) =>
    aside({ "apps/cli/package.json": manifest(other) }, `Release ${other}`);

  return {
    decide,
    merge,
    mergeAt,
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
    lockRefresh,
    onVersion,
    atVersion,
    aside,
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

  it.effect("a bun.lock refresh alone after the last beta makes no beta due", () =>
    Effect.gen(function* () {
      const { decide, lockRefresh, merge } = yield* world;
      yield* lockRefresh;
      const result = yield* decide({ published: 30 });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.outputs.decision).toBe("none");
      expect(result.outputs.reason).toBe(`No commits on main since ${version}.`);
      yield* merge;
      expect((yield* decide({ published: 30 })).outputs.decision).toBe("bump");
    }).pipe(Effect.scoped),
  );

  it.effect("a bun.lock refresh does not move main for the retry back-off", () =>
    Effect.gen(function* () {
      const { decide, lockRefresh, merge, released, previous } = yield* world;
      const failed = (hoursAgo: number, headSha: string): ReadonlyArray<ReleaseRun> => [
        { id: 3, hoursAgo, headSha },
        { id: 2, conclusion: "cancelled", hoursAgo: hoursAgo + 1, headSha },
        { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
      ];
      yield* lockRefresh;
      const after = yield* decide({ runs: failed(6.5, released) });
      expect(after.outputs.decision, after.output).toBe("none");
      expect(after.outputs.reason).toContain("after two or more failed attempts in a row");
      const refreshed = yield* lockRefresh;
      expect((yield* decide({ runs: failed(6.5, refreshed) })).outputs.decision).toBe("none");
      yield* lockRefresh;
      expect((yield* decide({ runs: failed(6.5, refreshed) })).outputs.decision).toBe("none");
      yield* merge;
      const moved = yield* decide({ runs: failed(6.5, refreshed) });
      expect(moved.outputs.decision, moved.output).toBe("dispatch");
      expect(moved.outputs.reason).toContain("main has moved");
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

  it.effect(
    "after two failed attempts, CI passing on a newer main commit retries at once, at most five a day",
    () =>
      Effect.gen(function* () {
        const { decide, merge, released, previous } = yield* world;
        const failed = (count: number): ReadonlyArray<ReleaseRun> => [
          ...Array.from({ length: count }, (_, index) => ({
            id: 10 + index,
            hoursAgo: 0.5 + index,
            headSha: released,
          })),
          { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
        ];

        const fix = yield* merge;
        const waiting = yield* decide({
          runs: failed(2),
          green: [{ headSha: released, hoursAgo: 2 }],
        });
        expect(waiting.outputs.decision, waiting.output).toBe("none");
        expect(waiting.outputs.reason).toContain("waits for CI to pass on a newer main commit");

        for (const event of ["schedule", "push", "workflow_run"] as const) {
          const green = yield* decide({
            event,
            runs: failed(2),
            green: [{ headSha: fix, hoursAgo: 0.1 }],
          });
          expect(green.exitCode, green.output).toBe(0);
          expect(green.outputs.decision, `${event}: ${green.output}`).toBe("dispatch");
          expect(green.outputs.reason).toContain(`CI passed on ${fix.slice(0, 9)} after it`);
          expect(green.outputs.reason).toContain("2 of 5 attempts today failed");
        }

        const many = yield* decide({ runs: failed(5), green: [{ headSha: fix, hoursAgo: 0.1 }] });
        expect(many.outputs.decision, many.output).toBe("none");
        expect(many.output).toContain("::warning::");

        const publishing = yield* decide({
          runs: [
            { id: 30, publish: "failure", attempt: 2, hoursAgo: 0.5, headSha: released },
            ...failed(1),
          ],
          green: [{ headSha: fix, hoursAgo: 0.1 }],
        });
        expect(publishing.outputs.decision, publishing.output).toBe("none");
        expect(publishing.outputs.reason).toContain("failed to publish");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "five failed attempts in a day hold every path, the six-hour one and a manual one",
    () =>
      Effect.gen(function* () {
        const { decide, merge, released, previous } = yield* world;
        const five: ReadonlyArray<ReleaseRun> = [
          ...[6.5, 9, 12, 15, 18].map((hoursAgo, index) => ({
            id: 40 + index,
            hoursAgo,
            headSha: released,
          })),
          { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
        ];
        const fix = yield* merge;
        for (const event of ["schedule", "push", "workflow_run", "workflow_dispatch"] as const) {
          const held = yield* decide({
            event,
            runs: five,
            green: [{ headSha: fix, hoursAgo: 0.1 }],
          });
          expect(held.exitCode, held.output).toBe(0);
          expect(held.outputs.decision, `${event}: ${held.output}`).toBe("none");
          expect(held.output).toContain("::warning::");
          expect(held.outputs.reason).toContain("5 publishing attempts failed in the last day");
        }
        const rerun = yield* decide({
          runs: [{ id: 50, publish: "failure", hoursAgo: 0.5, headSha: released }, ...five],
        });
        expect(rerun.outputs.decision, rerun.output).toBe("none");
        expect(rerun.outputs.reason).toContain("6 publishing attempts failed in the last day");
        const four = yield* decide({
          runs: [
            ...[6.5, 9, 12, 15, 25].map((hoursAgo, index) => ({
              id: 60 + index,
              hoursAgo,
              headSha: released,
            })),
            { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
          ],
        });
        expect(four.outputs.decision, four.output).toBe("dispatch");
        expect(four.outputs.reason).toContain("4 of 5 attempts today failed");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "failed attempts are counted from the runs of the last month, not the last 30 records",
    () =>
      Effect.gen(function* () {
        const { decide, merge, released, previous } = yield* world;
        const fix = yield* merge;
        for (const builds of [29, 120])
          for (const event of ["schedule", "workflow_dispatch"] as const) {
            const held = yield* decide({
              event,
              runs: [
                { id: 401, hoursAgo: 0.5, headSha: released },
                ...Array.from({ length: builds }, (_, index) => ({
                  id: 1000 + index,
                  hoursAgo: 30 + index * 0.3,
                  headSha: released,
                  channel: "build" as const,
                  conclusion: "success" as const,
                  publish: "skipped" as const,
                })),
                {
                  id: 440,
                  hoursAgo: 70,
                  attempt: 5,
                  attemptsHoursAgo: [70, 20, 15, 10, 2],
                  headSha: released,
                },
              ],
              green: [{ headSha: fix, hoursAgo: 0.1 }],
            });
            expect(held.outputs.decision, `${builds} builds, ${event}: ${held.output}`).toBe(
              "none",
            );
            expect(held.output).toContain("::warning::");
            expect(held.outputs.reason).toContain("5 publishing attempts failed in the last day");
            expect(apiReads(held.calls)).toEqual([
              ...(builds === 29 ? [runsPage(1)] : [runsPage(1), runsPage(2)]),
              attemptRead(440, 4),
              attemptRead(440, 3),
              attemptRead(440, 2),
            ]);
          }
        const mixed = yield* decide({
          runs: [
            { id: 301, hoursAgo: 0.5, headSha: released },
            { id: 302, hoursAgo: 1, headSha: released },
            {
              id: 303,
              hoursAgo: 50,
              attempt: 4,
              attemptsHoursAgo: [50, 10, 5, 2],
              headSha: released,
            },
            { id: 304, hoursAgo: 80, conclusion: "success", publish: "success", headSha: previous },
          ],
          green: [{ headSha: fix, hoursAgo: 0.1 }],
        });
        expect(mixed.outputs.decision, mixed.output).toBe("none");
        expect(mixed.outputs.reason).toContain("5 publishing attempts failed in the last day");
        expect(apiReads(mixed.calls)).toEqual([
          runsPage(1),
          attemptRead(303, 3),
          attemptRead(303, 2),
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("when counting takes more than ten requests, the count is unknown and holds", () =>
    Effect.gen(function* () {
      const { decide, released } = yield* world;
      const rerun: ReadonlyArray<ReleaseRun> = Array.from({ length: 10 }, (_, index) => ({
        id: 100 + index,
        attempt: 2,
        conclusion: "cancelled",
        hoursAgo: 30 + index,
        attemptsHoursAgo: [30 + index, 1 + index * 0.5],
        headSha: released,
      }));
      for (const event of ["schedule", "workflow_dispatch"] as const) {
        const held = yield* decide({
          event,
          runs: [{ id: 99, hoursAgo: 0.2, headSha: released }, ...rerun],
        });
        expect(held.exitCode, held.output).toBe(0);
        expect(held.outputs.decision, `${event}: ${held.output}`).toBe("none");
        expect(held.output).toContain("::warning::");
        expect(held.outputs.reason).toContain(
          "could not be counted within 10 requests, so it holds",
        );
        expect(apiReads(held.calls)).toEqual([
          runsPage(1),
          ...rerun.slice(0, 9).map((each) => attemptRead(each.id, 1)),
        ]);
      }
      const nine = yield* decide({
        event: "workflow_dispatch",
        runs: [{ id: 99, hoursAgo: 0.2, headSha: released }, ...rerun.slice(0, 9)],
      });
      expect(nine.outputs.decision, nine.output).toBe("dispatch");
      expect(nine.outputs.reason).toContain("1 of 5 attempts today failed");
      expect(apiReads(nine.calls)).toHaveLength(10);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a failed image tag push in the docker job is a publishing failure, never retried early",
    () =>
      Effect.gen(function* () {
        const { decide, merge, released, previous } = yield* world;
        const fix = yield* merge;
        const earlier: ReadonlyArray<ReleaseRun> = [
          { id: 70, hoursAgo: 2, headSha: released },
          { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
        ];
        const first = yield* decide({
          runs: [{ id: 71, dockerPush: "failure", hoursAgo: 0.5, headSha: released }, ...earlier],
          green: [{ headSha: fix, hoursAgo: 0.1 }],
        });
        expect(first.exitCode, first.output).toBe(0);
        expect(first.outputs).toMatchObject({ decision: "rerun", run: "71", version });
        expect(first.outputs.reason).toContain(
          "docker (blacksmith-16vcpu-ubuntu-2404-arm, arm64): Push the tested architecture without moving a channel",
        );
        const again = yield* decide({
          runs: [
            { id: 71, dockerPush: "failure", attempt: 2, hoursAgo: 0.5, headSha: released },
            ...earlier,
          ],
          green: [{ headSha: fix, hoursAgo: 0.1 }],
        });
        expect(again.outputs.decision, again.output).toBe("none");
        expect(again.outputs.reason).toContain("inspect it");
        const tested = yield* decide({
          runs: [
            {
              id: 72,
              dockerPush: "success",
              failedJobs: [
                {
                  name: "cli (win32, x64)",
                  step: "Exercise the installed CLI through HTTP and the browser",
                },
              ],
              hoursAgo: 0.5,
              headSha: released,
            },
            ...earlier,
          ],
          green: [{ headSha: fix, hoursAgo: 0.1 }],
        });
        expect(tested.outputs.decision, tested.output).toBe("dispatch");
        expect(tested.outputs.reason).toContain(`CI passed on ${fix.slice(0, 9)} after it`);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a failure in the Bun runtime's release, or in a job nothing lists, is not retried early",
    () =>
      Effect.gen(function* () {
        const { decide, merge, released, previous } = yield* world;
        const fix = yield* merge;
        for (const job of [
          { name: "bun-runtime / release", step: "Publish" },
          { name: "sign-everything (linux-x64)", step: "Run a step no table knows" },
        ]) {
          const result = yield* decide({
            runs: [
              { id: 80, failedJobs: [job], hoursAgo: 0.5, headSha: released },
              { id: 79, hoursAgo: 2, headSha: released },
              { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
            ],
            green: [{ headSha: fix, hoursAgo: 0.1 }],
          });
          expect(result.outputs.decision, `${job.name}: ${result.output}`).toBe("rerun");
          expect(result.outputs.reason).toContain(job.name);
        }
        for (const job of [
          { name: "bun-runtime / build linux-x64", step: "Build" },
          { name: "collector (darwin-arm64)", step: "Run ./.github/actions/collector" },
          { name: "metadata", step: "Write the release notes" },
          { name: "local (linux-x64)", step: "Verify packaged desktop startup and restart" },
        ]) {
          const result = yield* decide({
            runs: [
              { id: 81, failedJobs: [job], hoursAgo: 0.5, headSha: released },
              { id: 79, hoursAgo: 2, headSha: released },
              { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
            ],
            green: [{ headSha: fix, hoursAgo: 0.1 }],
          });
          expect(result.outputs.decision, `${job.name}: ${result.output}`).toBe("dispatch");
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a job whose name GitHub cut short is found by its id, so beta.61's failed CLI test retries early",
    () =>
      Effect.gen(function* () {
        const { decide, merge, released, previous } = yield* world;
        const fix = yield* merge;
        const truncated =
          "cli (win32, x64, true, blacksmith-16vcpu-windows-2025, win, exe, 8, .local/releases/2.0.0-beta.61...";
        const earlier: ReadonlyArray<ReleaseRun> = [
          { id: 89, hoursAgo: 2, headSha: released },
          { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
        ];
        const result = yield* decide({
          runs: [
            {
              id: 90,
              failedJobs: [
                {
                  name: truncated,
                  step: "Exercise the installed CLI through HTTP and the browser",
                },
              ],
              hoursAgo: 0.5,
              headSha: released,
            },
            ...earlier,
          ],
          green: [{ headSha: fix, hoursAgo: 0.1 }],
        });
        expect(result.exitCode, result.output).toBe(0);
        expect(result.outputs.decision, result.output).toBe("dispatch");
        expect(result.outputs.reason).toContain(`CI passed on ${fix.slice(0, 9)} after it`);
        for (const [name, step, decision] of [
          [
            "docker (blacksmith-16vcpu-ubuntu-2404-a...",
            "Push the tested architecture without moving a channel",
            "rerun",
          ],
          [
            "local-macos-arm64 (darwin, arm64, true, blacksmith-6vcpu-...",
            "Verify packaged desktop startup and restart",
            "dispatch",
          ],
          [
            "cli (win32, x64, true, blacksmith-16vcpu-windows-2025, win, exe, 8...",
            "A step cli does not have",
            "rerun",
          ],
        ] as const) {
          const each = yield* decide({
            runs: [
              { id: 91, failedJobs: [{ name, step }], hoursAgo: 0.5, headSha: released },
              ...earlier,
            ],
            green: [{ headSha: fix, hoursAgo: 0.1 }],
          });
          expect(each.outputs.decision, `${name}: ${each.output}`).toBe(decision);
        }
      }).pipe(Effect.scoped),
  );

  it.effect("every failed attempt counts toward the five a day, re-runs included", () =>
    Effect.gen(function* () {
      const { decide, merge, released, previous } = yield* world;
      const fix = yield* merge;
      const done = {
        id: 1,
        conclusion: "success",
        publish: "success",
        hoursAgo: 30,
        headSha: previous,
      } as const;
      const five: ReadonlyArray<ReleaseRun> = [
        { id: 20, attempt: 2, hoursAgo: 1, headSha: released },
        { id: 21, attempt: 2, hoursAgo: 3, headSha: released },
        { id: 22, hoursAgo: 7, headSha: released },
        done,
      ];
      for (const event of ["schedule", "workflow_run", "workflow_dispatch"] as const) {
        const held = yield* decide({ event, runs: five, green: [{ headSha: fix, hoursAgo: 0.1 }] });
        expect(held.outputs.decision, `${event}: ${held.output}`).toBe("none");
        expect(held.outputs.reason).toContain("5 publishing attempts failed in the last day");
      }
      const four = yield* decide({
        runs: [
          { id: 23, attempt: 2, hoursAgo: 1, headSha: released },
          { id: 24, attempt: 2, conclusion: "cancelled", hoursAgo: 3, headSha: released },
          { id: 25, hoursAgo: 5, headSha: released },
          done,
        ],
        green: [{ headSha: fix, hoursAgo: 0.1 }],
      });
      expect(four.outputs.decision, four.output).toBe("dispatch");
      expect(four.outputs.reason).toContain("4 of 5 attempts today failed");
    }).pipe(Effect.scoped),
  );

  it.effect("a failed attempt counts by when it ran, so re-runs today of an older run count", () =>
    Effect.gen(function* () {
      const { decide, merge, released, previous } = yield* world;
      const fix = yield* merge;
      const done = {
        id: 1,
        conclusion: "success",
        publish: "success",
        hoursAgo: 40,
        headSha: previous,
      } as const;
      const rerunToday = {
        id: 40,
        attempt: 5,
        hoursAgo: 25,
        attemptsHoursAgo: [25, 20, 15, 10, 2],
        headSha: released,
      } as const;
      const five: ReadonlyArray<ReleaseRun> = [
        { id: 41, hoursAgo: 0.5, headSha: released },
        rerunToday,
        done,
      ];
      for (const event of ["schedule", "workflow_run", "workflow_dispatch"] as const) {
        const held = yield* decide({ event, runs: five, green: [{ headSha: fix, hoursAgo: 0.1 }] });
        expect(held.outputs.decision, `${event}: ${held.output}`).toBe("none");
        expect(held.outputs.reason).toContain("5 publishing attempts failed in the last day");
        expect(apiReads(held.calls)).toEqual([
          runsPage(1),
          attemptRead(40, 4),
          attemptRead(40, 3),
          attemptRead(40, 2),
        ]);
      }
      const four = yield* decide({
        runs: [
          { id: 42, hoursAgo: 0.5, headSha: released },
          { ...rerunToday, id: 43, attemptsHoursAgo: [25, 24.5, 15, 10, 2] },
          { id: 44, attempt: 3, hoursAgo: 40, attemptsHoursAgo: [40, 35, 30], headSha: released },
          done,
        ],
        green: [{ headSha: fix, hoursAgo: 0.1 }],
      });
      expect(four.outputs.decision, four.output).toBe("dispatch");
      expect(four.outputs.reason).toContain("4 of 5 attempts today failed");
      const within = yield* decide({
        runs: [
          { id: 45, attempt: 3, hoursAgo: 6, attemptsHoursAgo: [6, 4, 2], headSha: released },
          done,
        ],
        green: [{ headSha: fix, hoursAgo: 0.1 }],
      });
      expect(within.outputs.reason, within.output).toContain("3 of 5 attempts today failed");
      expect(apiReads(within.calls)).toEqual([runsPage(1)]);
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

  it.effect("a check that gave way to a newer one tested nothing and never counts", () =>
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

  it.effect("a run whose title names no channel never counts, passed or not", () =>
    Effect.gen(function* () {
      const { decide, change, previous } = yield* world;
      const head = yield* change(["apps/cli/src/main.ts"]);
      const red: MatrixRun = { id: 901, hoursAgo: 2, headSha: previous };
      for (const conclusion of ["success", "failure"] as const) {
        const result = yield* decide({
          published: 7,
          matrix: [red],
          runs: [{ id: 5, title: "Executor releases", conclusion, hoursAgo: 1, headSha: head }],
        });
        expect(result.outputs.decision, result.output).toBe("none");
        expect(result.outputs.reason).toContain("runs/901, failed its releases job");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("a check whose pace job failed tested nothing and never counts", () =>
    Effect.gen(function* () {
      const { decide, change, previous } = yield* world;
      const head = yield* change(["apps/cli/src/main.ts"]);
      for (const pace of ["failure", "cancelled"] as const) {
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

  it.effect(
    "a hold shows in the red-main issue after six hours, or at once when five attempts failed",
    () =>
      Effect.gen(function* () {
        const { decide, mergeAt, released, previous } = yield* world;
        const redMatrix = [{ id: 901, hoursAgo: 1, headSha: previous }] as const;
        yield* mergeAt(2);
        const recent = yield* decide({ published: 30, matrix: redMatrix });
        expect(recent.outputs.decision, recent.output).toBe("none");
        expect(recent.output).toContain("::warning::");
        expect(recent.outputs.held).toBe("");
        const { decide: decideOld, mergeAt: mergeOld, git: gitOld } = yield* world;
        const first = yield* mergeOld(10);
        yield* mergeOld(1);
        const old = yield* decideOld({ published: 30, matrix: redMatrix });
        expect(old.outputs.decision, old.output).toBe("none");
        expect(old.outputs.held).toBe("held");
        expect(old.outputs.held_since).toBe(
          new Date(yield* gitOld("log", "-1", "--format=%cI", first)).toISOString(),
        );
        const { decide: decideFresh, mergeAt: mergeFresh } = yield* world;
        yield* mergeFresh(8);
        const fresh = yield* decideFresh({ published: 7, matrix: redMatrix });
        expect(fresh.outputs.decision, fresh.output).toBe("none");
        expect(fresh.outputs.held).toBe("");
        expect(Date.parse(fresh.outputs.held_since!)).toBeGreaterThan(Date.now() - 1.1 * hour);

        const five: ReadonlyArray<ReleaseRun> = [
          ...Array.from({ length: 5 }, (_, index) => ({
            id: 40 + index,
            hoursAgo: 0.5 + index,
            headSha: released,
          })),
          { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
        ];
        const exhausted = yield* decide({ runs: five });
        expect(exhausted.outputs.reason).toContain("5 publishing attempts failed in the last day");
        expect(exhausted.outputs.held).toBe("held");
        expect(Date.parse(exhausted.outputs.held_since!)).toBeGreaterThan(Date.now() - hour);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "the red-main issue is cleared only once npm lists the version, and left as it is between holds",
    () =>
      Effect.gen(function* () {
        const { decide, merge, released, previous } = yield* world;
        const out = yield* decide({ published: 5.5 });
        expect(out.outputs.decision).toBe("none");
        expect(out.outputs.held).toBe("clear");
        yield* merge;
        const bump = yield* decide({ published: 30 });
        expect(bump.outputs.decision).toBe("bump");
        expect(bump.outputs.held).toBe("clear");
        const failedOnce = yield* decide({
          runs: [
            { id: 2, hoursAgo: 0.2, headSha: released },
            { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
          ],
        });
        expect(failedOnce.outputs.decision).toBe("dispatch");
        expect(failedOnce.outputs.held).toBe("");
        const running = yield* decide({
          runs: [
            { id: 3, status: "in_progress", hoursAgo: 0.1, headSha: released },
            { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
          ],
        });
        expect(running.outputs.decision).toBe("none");
        expect(running.outputs.held).toBe("");
        const building = yield* decide({
          published: 30,
          matrix: [{ id: 901, hoursAgo: 1, headSha: previous }],
          runs: [
            {
              id: 5,
              status: "in_progress",
              title: "Executor releases (build)",
              hoursAgo: 0.1,
              headSha: released,
            },
          ],
        });
        expect(building.outputs.reason).toContain("A release run is in_progress");
        expect(building.outputs.held).toBe("");
        const backOff = yield* decide({
          runs: [
            { id: 4, hoursAgo: 1, headSha: released },
            { id: 3, hoursAgo: 2, headSha: released },
            { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
          ],
        });
        expect(backOff.outputs.reason).toContain("after two or more failed attempts in a row");
        expect(backOff.output).toContain("::warning::");
        expect(backOff.outputs.held).toBe("");
      }).pipe(Effect.scoped),
  );

  it.effect("the gate reads checks past a busy day of checks that gave way", () =>
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
        `run list -R ${repository} -w release-artifacts.yml -e repository_dispatch -b main -L 100 --json databaseId,status,conclusion,headSha,createdAt,attempt,url,displayTitle`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a GitHub failure, or a run without a releases job, stops the gate", () =>
    Effect.gen(function* () {
      const { decide, merge, previous } = yield* world;
      yield* merge;
      const failed = yield* decide({ published: 7, listFails: true });
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

  it.effect("a check pacing or building holds no tick, unlike a build or a publication", () =>
    Effect.gen(function* () {
      const { decide, merge, previous } = yield* world;
      const head = yield* merge;
      const pacing = yield* decide({
        published: 7,
        matrix: [
          { id: 908, status: "in_progress", hoursAgo: 0.1, headSha: head },
          { id: 900, conclusion: "success", hoursAgo: 1, headSha: previous },
        ],
      });
      expect(pacing.outputs.decision, pacing.output).toBe("bump");
      const building = yield* decide({
        published: 7,
        runs: [{ id: 9, channel: "build", status: "in_progress", hoursAgo: 0.1, headSha: head }],
      });
      expect(building.outputs.decision, building.output).toBe("none");
      expect(building.outputs.reason).toContain("A release run is in_progress");
    }).pipe(Effect.scoped),
  );

  it.effect("a busy day of checks never hides the last publishing attempts", () =>
    Effect.gen(function* () {
      const { decide, merge, released } = yield* world;
      const head = yield* merge;
      const checks = Array.from({ length: 120 }, (_, index): MatrixRun => ({
        id: 2000 + index,
        conclusion: index % 2 === 0 ? "success" : "cancelled",
        hoursAgo: 0.05 + index * 0.05,
        headSha: head,
      }));
      const held = yield* decide({
        matrix: checks,
        runs: [{ id: 7, publish: "failure", attempt: 2, hoursAgo: 9, headSha: released }],
      });
      expect(held.exitCode, held.output).toBe(0);
      expect(held.outputs.decision, held.output).toBe("none");
      expect(held.outputs.reason).toContain("runs/7 failed to publish");
      const backOff = yield* decide({
        matrix: checks,
        runs: [
          { id: 3, hoursAgo: 5, headSha: released },
          { id: 2, hoursAgo: 6, headSha: released },
        ],
      });
      expect(backOff.outputs.decision, backOff.output).toBe("none");
      expect(backOff.outputs.reason).toContain("after two or more failed attempts in a row");
    }).pipe(Effect.scoped),
  );

  it.effect("a bun.lock refresh at the head of main neither clears nor causes a hold", () =>
    Effect.gen(function* () {
      const { decide, merge, lockRefresh, previous } = yield* world;
      const merged = yield* merge;
      yield* lockRefresh;
      const green = yield* decide({
        published: 7,
        matrix: [{ id: 910, conclusion: "success", hoursAgo: 0.1, headSha: merged }],
      });
      expect(green.outputs.decision, green.output).toBe("bump");
      const red = yield* decide({
        published: 7,
        matrix: [{ id: 911, hoursAgo: 0.1, headSha: previous }],
      });
      expect(red.outputs.decision, red.output).toBe("none");
      expect(red.outputs.reason).toContain("runs/911, failed its releases job");
    }).pipe(Effect.scoped),
  );

  it.effect("a check whose matrix did not run tested nothing, though its pace passed", () =>
    Effect.gen(function* () {
      const { decide, merge, previous } = yield* world;
      const head = yield* merge;
      const result = yield* decide({
        published: 7,
        matrix: [
          { id: 912, conclusion: "success", metadata: "skipped", hoursAgo: 0.1, headSha: head },
          { id: 901, hoursAgo: 1, headSha: previous },
        ],
      });
      expect(result.outputs.decision, result.output).toBe("none");
      expect(result.outputs.reason).toContain("runs/901, failed its releases job");
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

const stubPaceGh = `#!/bin/sh
echo "$*" >> "$FAKE_GITHUB/calls"
if [ "$1 $2" = "run cancel" ]; then exit 0; fi
[ "$1" = api ] && [ "$3" = --jq ] || { echo "stub gh: unsupported: $*" >&2; exit 2; }
jq -r "$4" "$FAKE_GITHUB/$(printf '%s' "$2" | tr -c 'A-Za-z0-9' _).json"
`;
const stubSleep = `#!/bin/sh
echo "$1" >> "$FAKE_GITHUB/sleeps"
`;

interface PushRun {
  readonly id: number;
  readonly created: number;
  readonly status?: "completed" | "in_progress" | "pending";
  readonly conclusion?: "success" | "failure" | "cancelled";
  readonly built?: number;
  readonly title?: string;
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
    const listed = runs
      .filter((push) => push.title === undefined)
      .map((push) => ({
        id: push.id,
        created_at: iso(push.created),
        status: push.status ?? "completed",
        conclusion:
          (push.status ?? "completed") === "completed" ? (push.conclusion ?? "success") : null,
      }));
    const list = `repos/${repository}/actions/workflows/release-artifacts.yml/runs?branch=main&event=repository_dispatch`;
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

  it.effect("a check builds at once when no build started in the last two hours", () =>
    Effect.gen(function* () {
      const first = yield* pace(10, [self]);
      expect(first.exitCode, first.output).toBe(0);
      expect(first.output).toContain("No earlier check on main built");
      const later = yield* pace(10, [self, { id: 9, created: 3, built: 2.9 }]);
      expect(later.exitCode, later.output).toBe(0);
      expect(later.output).toContain("so this run builds now");
      for (const result of [first, later]) {
        expect(result.sleeps).toEqual([]);
        expect(result.calls.some((call) => call.startsWith("run cancel"))).toBe(false);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("a check soon after a build waits for the two-hour mark, then builds", () =>
    Effect.gen(function* () {
      const result = yield* pace(10, [self, { id: 9, created: 0.6, built: 0.5 }]);
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain("No newer check is waiting, so this check builds.");
      expect(result.sleeps.length).toBe(1);
      expect(result.sleeps[0]).toBeGreaterThan(1.5 * 3600 - 60);
      expect(result.sleeps[0]).toBeLessThanOrEqual(1.5 * 3600);
    }).pipe(Effect.scoped),
  );

  it.effect("a waiting check gives way to a newer one by cancelling itself", () =>
    Effect.gen(function* () {
      const result = yield* pace(10, [
        { id: 11, created: -0.2, status: "pending" },
        self,
        { id: 9, created: 0.6, built: 0.5 },
      ]);
      expect(result.calls).toContain(`run cancel 10 --repo ${repository}`);
      expect(result.exitCode, result.output).toBe(1);
      expect(result.output).toContain(
        "::error::This run asked to be cancelled, yet is still running",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a newer build or publication is not a newer check to give way to", () =>
    Effect.gen(function* () {
      const result = yield* pace(10, [
        { id: 11, created: -0.2, status: "pending", title: "Executor releases (build)" },
        self,
        { id: 9, created: 0.6, built: 0.5 },
      ]);
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain("No newer check is waiting, so this check builds.");
      expect(result.calls.some((call) => call.startsWith("run cancel"))).toBe(false);
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

const stubIssueGh = `#!/bin/sh
dir="$FAKE_GITHUB"
echo "$*" >> "$dir/calls"
filter=""
allow=""
jqarg() { while [ $# -gt 0 ]; do [ "$1" = --jq ] && { printf '%s' "$2"; return; }; shift; done; }
case "$1 $2" in
  "api --paginate") path=$3; filter=$5 ;;
  "api --allow-escape-sequences") allow=1; path=$3 ;;
  "issue list") exec jq -r "$(jqarg "$@")" "$dir/open.json" ;;
  "issue view") exec jq -r "$(jqarg "$@")" "$dir/issue-$3.json" ;;
  "issue edit")
    number=$3
    while [ $# -gt 0 ]; do
      [ "$1" = --body-file ] && cp "$2" "$dir/edited-$number.md"
      [ "$1" = --title ] && printf '%s' "$2" > "$dir/title-$number"
      shift
    done
    exit 0 ;;
  "issue create")
    while [ $# -gt 0 ]; do
      [ "$1" = --body-file ] && cp "$2" "$dir/created.md"
      [ "$1" = --title ] && printf '%s' "$2" > "$dir/created-title"
      shift
    done
    exit 0 ;;
  "issue close") echo "$3" >> "$dir/closed"; exit 0 ;;
  "label create") exit 0 ;;
  api*) path=$2; [ "$3" = --jq ] && filter=$4 ;;
  *) echo "stub gh: unsupported: $*" >&2; exit 2 ;;
esac
file="$dir/$(printf '%s' "$path" | tr -c 'A-Za-z0-9' _)"
if [ -f "$file.txt" ]; then
  if [ -z "$allow" ] && grep -q "$(printf '\\033')" "$file.txt"; then
    echo "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway" >&2
    exit 1
  fi
  exec cat "$file.txt"
fi
[ -f "$file.json" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
if [ -n "$filter" ]; then exec jq -r "$filter" "$file.json"; fi
exec cat "$file.json"
`;

interface MainRun {
  readonly id: number;
  readonly created: number;
  readonly kind?: "check" | "build" | "beta";
  readonly sha: string;
  readonly conclusion?: "success" | "failure" | "cancelled";
  readonly pace?: "success" | "failure";
  readonly releases?: "success" | "failure";
}

const issueWorld = (input: {
  readonly needs: Readonly<Record<string, string>>;
  readonly runs?: ReadonlyArray<MainRun>;
  readonly failed?: ReadonlyArray<{
    readonly id: number;
    readonly name: string;
    readonly log: string;
  }>;
  readonly issue?: { readonly number: number; readonly body: string };
  readonly compare?: {
    readonly base: string;
    readonly head: string;
    readonly commits: ReadonlyArray<{ readonly sha: string; readonly message: string }>;
  };
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
          event: (main.kind ?? "check") === "check" ? "repository_dispatch" : "workflow_dispatch",
          display_title: `Executor releases (${main.kind ?? "check"})`,
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
                conclusion: main.kind === "beta" ? "success" : "skipped",
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
    if (input.compare !== undefined)
      yield* save(`repos/${repository}/compare/${input.compare.base}...${input.compare.head}`, {
        commits: input.compare.commits.map((commit) => ({
          sha: commit.sha,
          commit: { message: commit.message },
        })),
      });
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
      GITHUB_STEP_SUMMARY: path.join(github, "summary.md"),
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
      summary: yield* read("summary.md"),
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
const controlsIn = (text: string) =>
  [...text]
    .map((character) => character.codePointAt(0)!)
    .filter(
      (point) =>
        (point < 0x20 && point !== 0x09 && point !== 0x0a) || (point >= 0x7f && point <= 0x9f),
    );

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
      for (const line of body.split("\n").filter((entry) => entry.startsWith("  - `")))
        expect(line.match(/[`@]/g), line).toEqual(["`", "`"]);
      expect(body).toContain(`<!-- first-red: ${"c".repeat(40)} ${runUrl(50)} -->`);
    }).pipe(Effect.scoped),
  );

  it.effect("a log's links, titles and other terminal controls are gone, not only colors", () =>
    Effect.gen(function* () {
      const esc = "\u001b";
      const result = yield* issueWorld({
        needs: { ...passed, local: "failure" },
        runs: [{ id: 30, created: 3, sha: "a".repeat(40) }],
        failed: [
          {
            id: 7003,
            name: "local (linux, x64)",
            log: [
              `2026-11-12T10:00:00.0000000Z ${esc}[41m FAIL ${esc}[49m ${esc}]8;;https://example.com/a${esc}\\e2e/tests/osc.spec.ts${esc}]8;;${esc}\\ > OSC > a link around the file\r`,
              `2026-11-12T10:00:00.0000000Z  \u009b31m×\u009b39m ${esc}]0;tab title\u0007e2e/tests/osc.spec.ts > OSC > a title set by the log${esc}(B 120ms`,
            ].join("\n"),
          },
        ],
      });
      expect(result.exitCode, result.output).toBe(0);
      const body = result.created!;
      expect(body).toContain("  - `e2e/tests/osc.spec.ts > OSC > a link around the file`");
      expect(controlsIn(body)).toEqual([]);
      expect(body).not.toContain("example.com");
    }).pipe(Effect.scoped),
  );

  it.effect("an OSC whose opening and ending forms differ keeps the text after it", () =>
    Effect.gen(function* () {
      const esc = "\u001b";
      const result = yield* issueWorld({
        needs: { ...passed, local: "failure" },
        runs: [{ id: 30, created: 3, sha: "a".repeat(40) }],
        failed: [
          {
            id: 7004,
            name: "local (linux, x64)",
            log: [
              `2026-11-12T10:00:00.0000000Z  FAIL  e2e/tests/osc.spec.ts > OSC > before ${esc}]0;title\u009c ordinary after`,
              `2026-11-12T10:00:00.0000000Z  FAIL  e2e/tests/osc.spec.ts > OSC > first \u009d0;title${esc}\\ kept after`,
            ].join("\n"),
          },
        ],
      });
      expect(result.exitCode, result.output).toBe(0);
      const body = result.created!;
      expect(body).toContain("  - `e2e/tests/osc.spec.ts > OSC > before  ordinary after`");
      expect(body).toContain("  - `e2e/tests/osc.spec.ts > OSC > first  kept after`");
      expect(controlsIn(body)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a failure names the commits since the last green run, in the issue and the run's summary",
    () =>
      Effect.gen(function* () {
        const result = yield* issueWorld({
          needs: { ...passed, docker: "failure" },
          runs: [{ id: 30, created: 3, sha: "a".repeat(40) }],
          failed: [{ id: 7002, name: "docker (amd64)", log: "" }],
          compare: {
            base: "a".repeat(40),
            head: "c".repeat(40),
            commits: [
              { sha: "1".repeat(40), message: "Pin the `engine` for @someone\n\nBody text" },
              { sha: "2".repeat(40), message: "Package the engine's runtime" },
            ],
          },
        });
        expect(result.exitCode, result.output).toBe(0);
        for (const text of [result.created!, result.summary!]) {
          expect(text).toContain("Commits since the last green run, oldest first:");
          expect(text).toContain(`- ${"1".repeat(9)} Pin the engine for someone`);
          expect(text).toContain(`- ${"2".repeat(9)} Package the engine's runtime`);
          expect(text).not.toContain("Body text");
        }
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
        { id: 61, created: -0.5, sha: "e".repeat(40), kind: "build" as const },
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
            kind: "beta",
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

  it.effect(
    "every step of the release workflows says whether it publishes, and a new one without it fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "executor-publishing-steps-",
        });
        const cli = path.resolve("scripts/releases/publishing-steps-check.ts");
        const artifacts = yield* fs.readFileString(".github/workflows/release-artifacts.yml");
        const problems = (text: string) =>
          Effect.gen(function* () {
            const file = path.join(directory, `release-artifacts-${text.length}.yml`);
            yield* fs.writeFileString(file, text);
            const result = yield* run(".", "node", [cli, "check", file], {});
            return result.output.split("\n").filter((line) => line !== "");
          });
        const current = yield* run(".", "node", [cli, "check"], {});
        expect(current.exitCode, current.output).toBe(0);
        expect(current.output).toBe("");
        const anchor = "      - name: Check the tested and published archives are the same bytes\n";
        expect(artifacts).toContain(anchor);
        for (const step of [
          '      - name: Push a preview image\n        run: docker buildx build --push --tag "$IMAGE:preview" .\n',
          "      - uses: docker/build-push-action@v6\n        with:\n          push: true\n          tags: preview\n",
          "      - name: Build something\n        run: true\n        env:\n          PUBLISHES: maybe\n",
        ])
          expect(yield* problems(artifacts.replace(anchor, step + anchor))).toEqual([
            expect.stringMatching(
              /^release-artifacts\.yml: job archives's step \d+ \(.+\) does not say whether it publishes: give it env PUBLISHES "yes" or "no"$/,
            ),
          ]);
        expect(
          yield* problems(
            artifacts.replace(
              anchor,
              '      - name: Push a preview image\n        run: docker buildx build --push --tag "$IMAGE:preview" .\n        env:\n          PUBLISHES: "yes"\n' +
                anchor,
            ),
          ),
        ).toEqual([]);
        const renamed = artifacts.replace(
          "\n  archives:\n",
          "\n  archives:\n    name: Compare archives\n",
        );
        expect(renamed).not.toBe(artifacts);
        expect(yield* problems(renamed)).toEqual([
          `release-artifacts.yml: job archives is named "Compare archives", which does not start with its id; a run's job is found by its id at the start of its name`,
        ]);
        const classify = (jobs: ReadonlyArray<{ name: string; step?: string }>) =>
          Effect.gen(function* () {
            const input = path.join(directory, "jobs.json");
            yield* fs.writeFileString(
              input,
              JSON.stringify(
                jobs.map(({ name, step }) => ({
                  name,
                  conclusion: "failure",
                  steps: [
                    { name: "Set up runner", conclusion: "success" },
                    ...(step === undefined ? [] : [{ name: step, conclusion: "failure" }]),
                    { name: "Complete runner", conclusion: "success" },
                  ],
                })),
              ),
            );
            const result = yield* run(
              ".",
              "sh",
              ["-c", 'node "$0" classify < "$1"', cli, input],
              {},
            );
            expect(result.exitCode, result.output).toBe(0);
            return JSON.parse(result.output) as ReadonlyArray<string>;
          });
        expect(
          yield* classify([
            { name: "docker (blacksmith-16vcpu-ubuntu-2404-arm, arm64)" },
            { name: "collector (linux-x64)", step: "Post Run ./.github/actions/setup" },
            {
              name: "cli (win32, x64, true, blacksmith-16vcpu-windows-2025, win, exe, 8, .local/releases/2.0.0-beta.61...",
            },
            { name: "bun-runtime / build linux-x64", step: "Build" },
            { name: "bun-runtime / smoke darwin-arm64" },
            { name: "releases", step: "Require every job the run needed to pass" },
          ]),
        ).toEqual([]);
        expect(
          yield* classify([
            {
              name: "publish",
              step: "Run actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
            },
          ]),
        ).toEqual(["publish: Run actions/checkout@11d5960a326750d5838078e36cf38b85af677262"]);
        expect(
          yield* classify([
            { name: "bun-runtime / release", step: "Publish" },
            {
              name: "docker (blacksmith-8vcpu-ubuntu-2404, amd64)",
              step: "Post Push the tested architecture without moving a channel",
            },
            { name: "sign (linux-x64)" },
          ]),
        ).toEqual([
          "bun-runtime / release: Publish",
          "docker (blacksmith-8vcpu-ubuntu-2404, amd64): Post Push the tested architecture without moving a channel",
          "sign (linux-x64) (a job of no release workflow: what it publishes is unknown)",
        ]);
      }).pipe(Effect.scoped),
  );
});

const fakeGitHub = String.raw`#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const dir = process.env.FAKE_GITHUB;
const args = process.argv.slice(2);
const bot = "github-actions[bot]";
fs.appendFileSync(path.join(dir, "calls"), args.join(" ") + "\n");
const world = JSON.parse(fs.readFileSync(path.join(dir, "world.json"), "utf8"));
const statePath = path.join(dir, "state.json");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const mutate = (what, number) => fs.appendFileSync(path.join(dir, "mutations"), what + " " + number + "\n");
let printed = "";
const fail = (message) => { process.stdout.write(printed); process.stderr.write(message + "\n"); process.exit(1); };
const faults = JSON.parse(fs.readFileSync(path.join(dir, "faults.json"), "utf8"));
// The number of the request being answered.
let current = 0;
// The fault on this request: "outage", "short", "shift" or undefined.
const request = (method, target) => {
  const countPath = path.join(dir, "count");
  const count = (fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0) + 1;
  current = count;
  fs.writeFileSync(countPath, String(count));
  fs.appendFileSync(path.join(dir, "requests"), method + " " + target + "\n");
  if (faults.includes(count)) fail("gh: Service Unavailable (HTTP 503)");
  for (const kind of ["short", "shift"]) if (faults.some((each) => each !== null && each[kind] === count)) return kind;
  return undefined;
};
// One page of ITEMS from OFFSET, PER long, as a fault makes it.
const pageOf = (items, offset, per, fault) =>
  fault === "short" ? items.slice(offset, offset + per).slice(0, -1)
  : fault === "shift" ? items.slice(Math.max(offset - 1, 0), Math.max(offset - 1, 0) + per)
  : items.slice(offset, offset + per);
// A JSON answer as served, after the edits a fault {"edit": n, "ops": [...]} makes to request n's
// answer: each op sets the value at its path, or deletes it. Each answer is kept in answers/<n>.json.
const edit = (value) => {
  if (value === null || typeof value !== "object" || Buffer.isBuffer(value)) return value;
  const answers = path.join(dir, "answers");
  fs.mkdirSync(answers, { recursive: true });
  fs.writeFileSync(path.join(answers, current + ".json"), JSON.stringify(value));
  const edited = JSON.parse(JSON.stringify(value));
  for (const fault of faults.filter((each) => each !== null && each.edit === current))
    for (const op of fault.ops) {
      const parent = op.path.slice(0, -1).reduce((at, key) => at[key], edited);
      const key = op.path[op.path.length - 1];
      if (op.delete && Array.isArray(parent)) parent.splice(key, 1);
      else if (op.delete) delete parent[key];
      else parent[key] = op.value;
    }
  return edited;
};
const jq = (filter, value) => {
  const result = cp.spawnSync("jq", ["-r", filter], { input: JSON.stringify(value), encoding: "utf8" });
  if (result.status !== 0) fail(result.stderr);
  return result.stdout;
};
const valued = new Set(["-X", "--input", "--jq", "-f", "-F", "--repo", "-R", "--color", "--description", "-H", "--label", "--state", "--json"]);
const options = {};
const fields = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (valued.has(arg)) {
    const value = args[++i];
    if (arg === "-f" || arg === "-F") fields[value.split("=")[0]] = value.slice(value.indexOf("=") + 1);
    else options[arg] = value;
  } else if (arg.startsWith("-")) options[arg] = true;
  else positional.push(arg);
}
if (positional[0] === "label") process.exit(0);
// The lookup Main health's script before main-health.yml took the main-health label made:
// gh issue list --label LABEL --state open --json number --jq EXPR.
if (positional[0] === "issue" && positional[1] === "list") {
  request("GET", "issues?labels=" + options["--label"] + "&state=" + options["--state"]);
  const found = state.issues
    .filter((each) => !each.pullRequest && each.state === options["--state"] && each.labels.includes(options["--label"]))
    .sort((a, b) => b.number - a.number)
    .map((each) => ({ number: each.number }));
  process.stdout.write(options["--jq"] === undefined ? JSON.stringify(found) : jq(options["--jq"], found));
  process.exit(0);
}
if (positional[0] !== "api") fail("fake gh: unsupported: " + args.join(" "));
// The open issues with a label, as GraphQL serves them, 100 a page after a cursor.
if (positional[1] === "graphql") {
  const text = fields.query || "";
  if (/\bmutation\b/.test(text) || !/\bissues\(/.test(text)) fail("fake gh: unsupported GraphQL: " + text);
  const fault = request("QUERY", "graphql issues" + (fields.after ? " after=" + fields.after : ""));
  const matching = state.issues
    .filter((each) => !each.pullRequest && each.state === "open" && each.labels.includes(fields.label))
    .sort((a, b) => a.number - b.number);
  const offset = fields.after ? Number(fields.after) : 0;
  const nodes = pageOf(matching, offset, 100, fault).map((each) => ({
    number: each.number, title: each.title, body: each.body,
    author: each.user === bot ? { __typename: "Bot", login: "github-actions" } : { __typename: "User", login: each.user },
    labels: { totalCount: each.labels.length, nodes: each.labels.map((name) => ({ name })) },
  }));
  const end = offset + 100;
  const value = { data: { repository: { issues: {
    totalCount: matching.length,
    pageInfo: { hasNextPage: end < matching.length, endCursor: String(end) },
    nodes,
  } } } };
  const served = edit(value);
  process.stdout.write(options["--jq"] === undefined ? JSON.stringify(served) : jq(options["--jq"], served));
  process.exit(0);
}
const method = options["-X"] || "GET";
const input = options["--input"] === undefined ? {} : JSON.parse(fs.readFileSync(options["--input"], "utf8"));
const target = positional[1].replace(/^repos\/[^/]+\/[^/]+\//, "");
const url = new URL("http://github.test/" + target);
const query = url.searchParams;
const parts = url.pathname.slice(1).split("/");
const iso = (hours) => new Date(world.now - hours * 3600000).toISOString().replace(/\.\d+/, "");
// A run world.completeAfter names is in its first attempt, in progress, until it has been read by
// id (GET actions/runs/ID) that many times, as a run whose last job is running is.
const pollsPath = (id) => path.join(dir, "polls-" + id);
const polls = (id) => (fs.existsSync(pollsPath(id)) ? Number(fs.readFileSync(pollsPath(id), "utf8")) : 0);
const live = (run) => ((world.completeAfter || {})[run.id] > polls(run.id) ? { ...run, status: "in_progress" } : run);
// A run being re-run is in progress with no conclusion. Its earlier attempts ended as run.attempts
// lists them, oldest first, or each as run.previous.
const earlier = (run, attempt) => (run.attempts || [])[attempt - 1] || run.previous;
const runOf = (given, attempt) => { const run = live(given); return {
  id: run.id, display_title: run.title, path: ".github/workflows/" + run.workflow,
  event: run.event, head_branch: run.branch,
  status: attempt === undefined ? run.status || "completed" : "completed",
  conclusion: attempt === undefined ? (run.status === undefined ? run.conclusion : null) : earlier(run, attempt),
  created_at: iso(run.created), head_sha: run.sha, run_attempt: attempt || run.attempt || 1,
  html_url: "https://github.com/" + process.env.GITHUB_REPOSITORY + "/actions/runs/" + run.id,
}; };
const issueOf = (issue) => ({
  number: issue.number, title: issue.title, body: issue.body, state: issue.state,
  labels: issue.labels.map((name) => ({ name })), user: { login: issue.user },
  ...(issue.pullRequest ? { pull_request: {} } : {}),
});
const issue = (number) => state.issues.find((each) => each.number === Number(number)) || fail("gh: Not Found (HTTP 404)");
const comment = (id) => {
  for (const each of state.issues) {
    const found = each.comments.find((entry) => entry.id === Number(id));
    if (found) return { issue: each, comment: found };
  }
  fail("gh: Not Found (HTTP 404)");
};
// A list GitHub pages: every item, and how one page is wrapped.
const list = () => {
  if (method !== "GET") return undefined;
  if (parts[0] === "issues" && parts.length === 1)
    return {
      items: state.issues
        .filter((each) => each.state === (query.get("state") || "open"))
        .filter((each) => !query.get("labels") || each.labels.includes(query.get("labels")))
        .filter((each) => !query.get("creator") || each.user === query.get("creator"))
        .sort((a, b) => b.number - a.number)
        .map(issueOf),
      wrap: (page) => page,
    };
  if (parts[0] === "issues" && parts[2] === "comments")
    return { items: issue(parts[1]).comments.map((each) => ({ id: each.id, body: each.body, user: { login: each.user } })), wrap: (page) => page };
  if (parts[0] === "actions" && parts[1] === "workflows" && parts[3] === "runs")
    return {
      items: world.runs
        .filter((run) => run.workflow === parts[2])
        .filter((run) => !query.get("branch") || run.branch === query.get("branch"))
        .filter((run) => !query.get("event") || run.event === query.get("event"))
        .filter((run) => !query.get("status") || (run.status || "completed") === query.get("status"))
        // Runs created at the same time: higher id first, or lower first when world.tieOrder says
        // "ascending", since GitHub promises no order among them.
        .sort((a, b) => a.created - b.created || (world.tieOrder === "ascending" ? a.id - b.id : b.id - a.id))
        .map((run) => runOf(run)),
      wrap: (page, total) => ({ total_count: total, workflow_runs: page }),
    };
  if (parts[0] === "actions" && parts[1] === "runs" && parts[3] === "attempts" && parts[5] === "jobs")
    return {
      items: (world.jobs[parts[2] + ":" + parts[4]] || world.jobs[parts[2]] || []).map((job) => ({
        id: job.id, name: job.name, status: "completed", conclusion: job.conclusion,
        html_url: "https://github.com/" + process.env.GITHUB_REPOSITORY + "/actions/runs/" + parts[2] + "/job/" + job.id,
      })),
      wrap: (page, total) => ({ total_count: total, jobs: page }),
    };
  // Served oldest first, so a reader that stops early misses the newest.
  if (parts[0] === "actions" && parts[1] === "artifacts" && parts.length === 2)
    return {
      items: world.artifacts
        .filter((each) => !query.get("name") || each.name === query.get("name"))
        .sort((a, b) => a.id - b.id)
        .map((each) => ({
          id: each.id, name: each.name, expired: each.expired, created_at: iso(each.created),
          workflow_run: { id: each.run, repository_id: 1, head_repository_id: each.fork ? 2 : 1, head_branch: each.branch },
        })),
      wrap: (page, total) => ({ total_count: total, artifacts: page }),
    };
  return undefined;
};
// Anything else: a value, bytes, or an error.
const single = (fault) => {
  if (parts[0] === "issues") {
    if (parts.length === 1 && method === "POST") {
      const number = state.next++;
      state.issues.push({ number, title: input.title, body: input.body, labels: input.labels, state: "open", user: bot, comments: [] });
      save();
      mutate("create", number);
      return { number };
    }
    if (parts[1] === "comments") {
      const found = comment(parts[2]);
      if (method === "PATCH") { found.comment.body = input.body; save(); mutate("edit-comment", found.issue.number); return { id: found.comment.id }; }
      if (method === "DELETE") { found.issue.comments = found.issue.comments.filter((each) => each !== found.comment); save(); mutate("delete-comment", found.issue.number); return ""; }
    }
    const found = issue(parts[1]);
    if (parts.length === 2 && method === "GET") return issueOf(found);
    if (parts.length === 2 && method === "PATCH") {
      const change = { ...input, ...fields };
      if ((change.title !== undefined && change.title !== found.title) || (change.body !== undefined && change.body !== found.body)) mutate("edit", found.number);
      if (change.state !== undefined && change.state !== found.state) mutate(change.state === "closed" ? "close" : "reopen", found.number);
      Object.assign(found, change.title === undefined ? {} : { title: change.title }, change.body === undefined ? {} : { body: change.body }, change.state === undefined ? {} : { state: change.state }, change.state_reason === undefined ? {} : { reason: change.state_reason });
      save();
      return issueOf(found);
    }
    if (parts[2] === "comments" && method === "POST") {
      const id = state.nextComment++;
      found.comments.push({ id, body: input.body, user: bot });
      save();
      mutate("comment", found.number);
      return { id };
    }
  }
  if (parts[0] === "labels" && parts.length === 1 && method === "POST") {
    state.labels.push(fields.name);
    save();
    mutate("label", fields.name);
    return { name: fields.name };
  }
  if (method !== "GET") fail("fake gh: unsupported: " + args.join(" "));
  if (parts[0] === "labels" && parts.length === 2) {
    if (!state.labels.includes(decodeURIComponent(parts[1]))) fail("gh: Not Found (HTTP 404)");
    return { name: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === "actions" && parts[1] === "runs" && parts.length === 3) {
    const run = world.runs.find((each) => each.id === Number(parts[2]));
    if (run === undefined) fail("gh: Not Found (HTTP 404)");
    const { id, path: file, event, head_branch, status } = runOf(run);
    fs.writeFileSync(pollsPath(run.id), String(polls(run.id) + 1));
    return { id, path: file, event, head_branch, status };
  }
  if (parts[0] === "actions" && parts[1] === "runs" && parts[3] === "attempts" && parts.length === 5) {
    const run = world.runs.find((each) => each.id === Number(parts[2]));
    if (run === undefined || Number(parts[4]) >= (run.attempt || 1)) fail("gh: Not Found (HTTP 404)");
    const { id, run_attempt, status, conclusion } = runOf(run, Number(parts[4]));
    return { id, run_attempt, status, conclusion };
  }
  if (parts[0] === "actions" && parts[1] === "jobs" && parts[3] === "logs") {
    const log = world.logs[parts[2]];
    if (log === undefined || log.status === 404) fail("gh: Not Found (HTTP 404)");
    if (log.status === 410) fail("gh: Gone (HTTP 410)");
    // As bytes, so a log that is not valid UTF-8 reaches the script as it is.
    const text = fs.readFileSync(path.join(dir, log.file));
    if (!options["--allow-escape-sequences"] && text.includes(0x1b))
      fail("the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway");
    return text;
  }
  if (parts[0] === "actions" && parts[1] === "artifacts" && parts[3] === "zip") {
    const artifact = world.artifacts.find((each) => each.id === Number(parts[2]));
    if (artifact === undefined) fail("gh: Not Found (HTTP 404)");
    if (artifact.expired || artifact.gone) fail("gh: Gone (HTTP 410)");
    const bytes = fs.readFileSync(path.join(dir, artifact.file));
    if (!options["--allow-escape-sequences"] && bytes.includes(0x1b))
      fail("the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway");
    return bytes;
  }
  if (parts[0] === "compare") {
    const commits = world.compare[parts[1]];
    if (commits === undefined) fail("gh: Not Found (HTTP 404)");
    const per = Number(query.get("per_page") || commits.length || 1);
    const page = Number(query.get("page") || 1);
    return { total_commits: commits.length, commits: pageOf(commits, (page - 1) * per, per, fault).map((each) => ({ sha: each.sha, commit: { message: each.message } })) };
  }
  fail("gh: Not Found (HTTP 404)");
};
const render = (given) => {
  if (Buffer.isBuffer(given) || typeof given === "string") return given;
  const value = edit(given);
  return options["--jq"] === undefined ? JSON.stringify(value) : jq(options["--jq"], value);
};
const paged = list();
if (paged === undefined) {
  const value = single(request(method, target));
  process.stdout.write(render(value));
  process.exit(0);
}
const per = Math.min(Number(query.get("per_page") || 30), 100);
let page = Number(query.get("page") || 1);
for (;;) {
  query.set("page", String(page));
  const fault = request("GET", url.pathname.slice(1) + "?" + query.toString());
  const items = pageOf(paged.items, (page - 1) * per, per, fault);
  printed += render(paged.wrap(items, paged.items.length));
  if (!options["--paginate"] || items.length < per) break;
  page++;
}
process.stdout.write(printed);
`;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const zipOf = (name: string, text: string) => {
  const data = new TextEncoder().encode(text);
  const file = new TextEncoder().encode(name);
  const crc = crc32(data);
  const date = (1 << 5) | 1;
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(12, date, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, data.length, true);
  local.setUint32(22, data.length, true);
  local.setUint16(26, file.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, 20, true);
  central.setUint16(6, 20, true);
  central.setUint16(14, date, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, data.length, true);
  central.setUint32(24, data.length, true);
  central.setUint16(28, file.length, true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + file.length, true);
  end.setUint32(16, 30 + file.length + data.length, true);
  const comment = new Uint8Array([0x1b, 0x5b, 0x30, 0x6d]);
  end.setUint16(20, comment.length, true);
  const pieces = [local, file, data, central, file, end, comment].map((piece) =>
    piece instanceof DataView ? new Uint8Array(piece.buffer) : piece,
  );
  const out = new Uint8Array(pieces.reduce((size, piece) => size + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
};

interface FakeRun {
  readonly id: number;
  readonly workflow: string;
  readonly branch: string;
  readonly event: string;
  readonly title: string;
  readonly created: number;
  readonly sha: string;
  readonly conclusion: string;
  readonly attempt?: number;
  readonly status?: "in_progress" | "queued";
  readonly previous?: string;
  readonly attempts?: ReadonlyArray<string>;
}
type Conclusion = "success" | "failure" | "cancelled" | "skipped" | "timed_out";
const ciRun = (id: number, created: number, sha: string, conclusion: Conclusion): FakeRun => ({
  id,
  workflow: "ci.yml",
  branch: "main",
  event: "push",
  title: "CI",
  created,
  sha,
  conclusion,
});
const windowsTitle = "Executor releases (build, cli on win32-x64)";
const windowsRun = (id: number, created: number, sha: string, conclusion: Conclusion): FakeRun => ({
  id,
  workflow: "release-artifacts.yml",
  branch: "ci/windows-check",
  event: "workflow_dispatch",
  title: windowsTitle,
  created,
  sha,
  conclusion,
});

interface Decision {
  readonly state: "held" | "clear";
  readonly reason: string;
  readonly since: string;
  readonly run: string;
}
interface FakeArtifact {
  readonly id: number;
  readonly created: number;
  readonly decision: Decision | string;
  readonly name?: string;
  readonly expired?: boolean;
  readonly branch?: string;
  readonly fork?: boolean;
  readonly workflow?: string;
  readonly gone?: boolean;
}

interface FakeJob {
  readonly id: number;
  readonly name: string;
  readonly conclusion?: string;
  readonly log?: string | Uint8Array | 404 | 410;
}

interface Facts {
  readonly runs?: ReadonlyArray<FakeRun>;
  readonly jobs?: Readonly<Record<number | string, ReadonlyArray<FakeJob>>>;
  readonly artifacts?: ReadonlyArray<FakeArtifact>;
  readonly compare?: Readonly<
    Record<string, ReadonlyArray<{ readonly sha: string; readonly message: string }>>
  >;
  readonly completeAfter?: Readonly<Record<number, number>>;
  readonly windows?: "none";
  readonly tieOrder?: "ascending";
}

interface FakeIssue {
  readonly number: number;
  readonly title?: string;
  readonly body?: string;
  readonly user?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly state?: "open" | "closed";
  readonly pullRequest?: boolean;
  readonly comments?: ReadonlyArray<string | { readonly body: string; readonly user: string }>;
}
interface KeptIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly user: string;
  readonly labels: ReadonlyArray<string>;
  readonly state: "open" | "closed";
  readonly reason?: string;
  readonly comments: ReadonlyArray<{
    readonly id: number;
    readonly body: string;
    readonly user: string;
  }>;
}

const mainTitle = "Main is red or a beta release is held";
const bot = "github-actions[bot]";
const mainLabel = "main-health";
const marker = "<!-- main-issue: main-health -->";
const oldLabels = ["main-red", "windows-check-red"];
const passedWindows: FakeRun = windowsRun(57, 48, "9".repeat(40), "success");
const mainHealthEnv = {
  LABEL: mainLabel,
  TITLE: mainTitle,
  CI_WORKFLOW: "ci.yml",
  CI_BRANCH: "main",
  CI_EVENT: "push",
  WINDOWS_WORKFLOW: "release-artifacts.yml",
  WINDOWS_BRANCH: "ci/windows-check",
  WINDOWS_EVENT: "workflow_dispatch",
  WINDOWS_TITLE: windowsTitle,
  BETA_WORKFLOW: "beta.yml",
  BETA_BRANCH: "main",
  BETA_EVENTS: "push schedule workflow_dispatch workflow_run",
  BETA_ARTIFACT: "beta-hold",
  WORKFLOW: "ci.yml",
  BRANCH: "main",
  EVENT: "push",
};

type ContextValue = string | number | boolean | null | { readonly [key: string]: ContextValue };

const evaluate = (
  expression: string,
  context: Readonly<Record<string, ContextValue>>,
  status: { readonly cancelled: boolean; readonly failed: boolean } = {
    cancelled: false,
    failed: false,
  },
): ContextValue => {
  const tokens = [
    ...expression.matchAll(
      /\s*(\|\||&&|==|!=|!|\(|\)|'(?:[^']|'')*'|[A-Za-z_][\w.-]*\(\)|[A-Za-z_][\w.-]*)/gy,
    ),
  ].map((match) => match[1]!);
  expect(tokens.join("").replace(/\s/g, "")).toBe(expression.replace(/\s/g, ""));
  let at = 0;
  const number = (value: ContextValue) =>
    value === null
      ? 0
      : typeof value === "boolean"
        ? Number(value)
        : typeof value === "string"
          ? Number(value.trim() === "" ? 0 : value)
          : typeof value === "number"
            ? value
            : Number.NaN;
  const equal = (a: ContextValue, b: ContextValue) =>
    typeof a === "string" && typeof b === "string"
      ? a.toLowerCase() === b.toLowerCase()
      : typeof a === typeof b && typeof a !== "object"
        ? a === b
        : a === null && b === null
          ? true
          : number(a) === number(b);
  const truthy = (value: ContextValue) =>
    !(value === false || value === null || value === "" || value === 0 || Number.isNaN(value));
  const primary = (): ContextValue => {
    const token = tokens[at++]!;
    if (token === "(") {
      const value = or();
      expect(tokens[at++]).toBe(")");
      return value;
    }
    if (token === "!") return !truthy(primary());
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token === "always()") return true;
    if (token === "success()") return !status.cancelled && !status.failed;
    if (token === "cancelled()") return status.cancelled;
    if (token === "true" || token === "false") return token === "true";
    if (token === "null") return null;
    expect(token).toMatch(/^[A-Za-z_][\w.-]*$/);
    return token
      .split(".")
      .reduce<ContextValue>(
        (value, key) => (value !== null && typeof value === "object" ? (value[key] ?? null) : null),
        context as ContextValue,
      );
  };
  const comparison = (): ContextValue => {
    const left = primary();
    if (tokens[at] === "==" || tokens[at] === "!=") {
      const operator = tokens[at++];
      const same = equal(left, primary());
      return operator === "==" ? same : !same;
    }
    return left;
  };
  const and = (): ContextValue => {
    let value = comparison();
    while (tokens[at] === "&&") {
      at++;
      const right = comparison();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const or = (): ContextValue => {
    let value = and();
    while (tokens[at] === "||") {
      at++;
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  expect(at).toBe(tokens.length);
  return value;
};

const admits = (
  condition: string | undefined,
  context: Readonly<Record<string, ContextValue>>,
  status?: { readonly cancelled: boolean; readonly failed: boolean },
) => {
  const bare = (condition ?? "success()").trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  const whole = /\b(always|success|failure|cancelled)\(\)/.test(bare)
    ? bare
    : `success() && (${bare})`;
  const value = evaluate(whole, context, status);
  return !(value === false || value === null || value === "" || value === 0);
};

interface WorkflowStep {
  readonly name?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
}
interface WorkflowJob {
  readonly if?: string;
  readonly needs?: string | ReadonlyArray<string>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly concurrency?: Readonly<Record<string, unknown>>;
  readonly "continue-on-error"?: boolean;
  readonly "timeout-minutes"?: number;
  readonly steps: ReadonlyArray<WorkflowStep>;
}
interface Workflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly permissions?: unknown;
  readonly concurrency?: unknown;
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}
const workflowYaml = (files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = yield* run(".", "node", ["scripts/ci/workflow-yaml.ts", ...files], {});
    return result.exitCode === 0
      ? { ok: true as const, workflows: JSON.parse(result.output) as Record<string, Workflow> }
      : { ok: false as const, problems: result.output };
  });
const workflowFile = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(`.github/workflows/${file}`);
    const parsed = yield* workflowYaml([`.github/workflows/${file}`]);
    if (!parsed.ok) expect.fail(parsed.problems);
    return { text, workflow: parsed.workflows[`.github/workflows/${file}`]! };
  });

type Trigger =
  | {
      readonly event: "workflow_run";
      readonly workflow: "CI" | "Beta";
      readonly runEvent?: string;
      readonly conclusion?: string;
      readonly fork?: boolean;
    }
  | { readonly event: "schedule" }
  | { readonly event: "workflow_dispatch"; readonly inputs?: Readonly<Record<string, string>> };

const mainHealthContext = (trigger: Trigger): Readonly<Record<string, ContextValue>> => ({
  github: {
    event_name: trigger.event,
    repository,
    ref: "refs/heads/main",
    token: "fake-token",
    event:
      trigger.event === "workflow_run"
        ? {
            workflow_run: {
              name: trigger.workflow,
              event: trigger.runEvent ?? "push",
              conclusion: trigger.conclusion ?? "success",
              head_repository: {
                full_name: trigger.fork === true ? "someone/executor-next" : repository,
              },
            },
          }
        : {},
  },
  inputs: trigger.event === "workflow_dispatch" ? { windows_run: "", ...trigger.inputs } : {},
});

const stepEnv = (step: WorkflowStep, context: Readonly<Record<string, ContextValue>>) =>
  Object.fromEntries(
    Object.entries(step.env ?? {}).map(([key, value]) => [
      key,
      String(value).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression: string) => {
        const result = evaluate(expression, context);
        return result === null ? "" : String(result);
      }),
    ]),
  );

const mainHealthJob = (trigger: Trigger, runner: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const { workflow } = yield* workflowFile("main-health.yml");
    const job = workflow.jobs["issue"]!;
    const context = mainHealthContext(trigger);
    if (!admits(job.if, context)) return { output: "", exitCode: 0, ran: false };
    let output = "";
    for (const step of job.steps) {
      if (step.uses !== undefined) {
        expect(step.uses).toMatch(
          /^actions\/checkout@[0-9a-f]{40}$|^\.\/\.github\/actions\/setup$/,
        );
        continue;
      }
      if (!admits(step.if, context)) continue;
      const result = yield* run(".", "bash", ["-e", "-c", step.run!], {
        ...runner,
        GITHUB_EVENT_NAME: trigger.event,
        ...stepEnv(step, context),
      });
      output += result.output;
      if (result.exitCode !== 0) return { output, exitCode: result.exitCode, ran: true };
    }
    return { output, exitCode: 0, ran: true };
  });

type Edit =
  | { readonly path: ReadonlyArray<string | number>; readonly value: unknown }
  | { readonly path: ReadonlyArray<string | number>; readonly delete: true };
type Fault =
  | number
  | { readonly short: number }
  | { readonly shift: number }
  | { readonly edit: number; readonly ops: ReadonlyArray<Edit> };

const issueRepository = (
  facts: Facts,
  issues: ReadonlyArray<FakeIssue> = [],
  labels: ReadonlyArray<string> = [mainLabel, ...oldLabels],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-main-issue-" });
    const bin = path.join(root, "bin");
    const github = path.join(root, "github");
    yield* fs.makeDirectory(bin);
    yield* fs.makeDirectory(github);
    yield* fs.writeFileString(path.join(bin, "gh"), fakeGitHub);
    yield* fs.chmod(path.join(bin, "gh"), 0o755);
    yield* fs.writeFileString(
      path.join(bin, "sleep"),
      '#!/bin/sh\necho "sleep $*" >> "$FAKE_GITHUB/sleeps"\n',
    );
    yield* fs.chmod(path.join(bin, "sleep"), 0o755);

    const logs: Record<number, { readonly file?: string; readonly status?: number }> = {};
    const jobs: Record<
      string,
      ReadonlyArray<{ id: number; name: string; conclusion: string }>
    > = {};
    for (const [run, list] of Object.entries(facts.jobs ?? {})) {
      jobs[run] = list.map((job) => ({
        id: job.id,
        name: job.name,
        conclusion: job.conclusion ?? "failure",
      }));
      for (const job of list) {
        if (job.log === 404 || job.log === 410) logs[job.id] = { status: job.log };
        else if (job.log !== undefined) {
          yield* fs.writeFile(
            path.join(github, `log-${job.id}`),
            typeof job.log === "string" ? new TextEncoder().encode(job.log) : job.log,
          );
          logs[job.id] = { file: `log-${job.id}` };
        }
      }
    }
    const runs = [...(facts.runs ?? [])];
    if (facts.windows !== "none" && !runs.some((run) => run.workflow === "release-artifacts.yml"))
      runs.push(passedWindows);
    const artifacts = [];
    for (const artifact of facts.artifacts ?? [currentClear]) {
      const text =
        typeof artifact.decision === "string"
          ? artifact.decision
          : JSON.stringify(artifact.decision);
      yield* fs.writeFile(
        path.join(github, `artifact-${artifact.id}.zip`),
        zipOf("beta-hold.json", text),
      );
      const run = 900000 + artifact.id;
      runs.push({
        id: run,
        workflow: artifact.workflow ?? "beta.yml",
        branch: artifact.branch ?? "main",
        event: "push",
        title: "Beta",
        created: artifact.created,
        sha: "e".repeat(40),
        conclusion: "success",
      });
      artifacts.push({
        id: artifact.id,
        name: artifact.name ?? "beta-hold",
        created: artifact.created,
        expired: artifact.expired ?? false,
        branch: artifact.branch ?? "main",
        fork: artifact.fork ?? false,
        gone: artifact.gone ?? false,
        run,
        file: `artifact-${artifact.id}.zip`,
      });
    }
    yield* fs.writeFileString(
      path.join(github, "world.json"),
      JSON.stringify({
        now: Date.now(),
        runs,
        jobs,
        logs,
        artifacts,
        compare: facts.compare ?? {},
        completeAfter: facts.completeAfter ?? {},
        tieOrder: facts.tieOrder ?? "descending",
      }),
    );
    let comment = 1000;
    const initial: ReadonlyArray<KeptIssue> = issues.map((issue) => ({
      number: issue.number,
      title: issue.title ?? mainTitle,
      body: issue.body ?? "",
      user: issue.user ?? bot,
      labels: issue.labels ?? [mainLabel],
      state: issue.state ?? "open",
      ...(issue.pullRequest === true ? { pullRequest: true } : {}),
      comments: (issue.comments ?? []).map((each) => ({
        id: comment++,
        ...(typeof each === "string" ? { body: each, user: bot } : each),
      })),
    }));
    yield* fs.writeFileString(
      path.join(github, "state.json"),
      JSON.stringify({
        next: Math.max(0, ...issues.map((issue) => issue.number)) + 1,
        nextComment: comment,
        issues: initial,
        labels,
      }),
    );
    const read = (name: string) =>
      fs
        .exists(path.join(github, name))
        .pipe(
          Effect.flatMap((exists) =>
            exists ? fs.readFileString(path.join(github, name)) : Effect.succeed(""),
          ),
        );
    const lines = (text: string) => text.split("\n").filter((line) => line !== "");
    const script = path.resolve("scripts/ci/main-health.ts");
    let calls = 0;

    const call = (faults: ReadonlyArray<Fault> = [], trigger?: Trigger) =>
      Effect.gen(function* () {
        const temp = path.join(root, `runner-temp-${calls++}`);
        yield* fs.makeDirectory(temp);
        for (const name of ["calls", "requests", "mutations", "count", "sleeps", "answers"])
          yield* fs.remove(path.join(github, name), { force: true, recursive: true });
        yield* fs.writeFileString(path.join(github, "faults.json"), JSON.stringify(faults));
        const runner = {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: process.env.HOME ?? root,
          FAKE_GITHUB: github,
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: repository,
          GITHUB_STEP_SUMMARY: path.join(temp, "summary.md"),
          RUNNER_TEMP: temp,
        };
        const result =
          trigger === undefined
            ? { ...(yield* run(root, "bun", [script], { ...mainHealthEnv, ...runner })), ran: true }
            : yield* mainHealthJob(trigger, runner);
        const state = JSON.parse(yield* read("state.json")) as {
          readonly issues: ReadonlyArray<KeptIssue>;
          readonly labels: ReadonlyArray<string>;
        };
        const issues = state.issues;
        const open = issues.filter((issue) => issue.state === "open");
        return {
          ...result,
          calls: lines(yield* read("calls")),
          requests: lines(yield* read("requests")),
          mutations: lines(yield* read("mutations")),
          sleeps: lines(yield* read("sleeps")),
          summary: yield* read(path.join(`../${path.basename(temp)}`, "summary.md")),
          issues,
          open,
          owned: open
            .filter(
              (issue) =>
                issue.user === bot &&
                issue.labels.includes(mainLabel) &&
                issue.body.includes(marker),
            )
            .sort((a, b) => a.number - b.number),
          body: (number: number) => issues.find((each) => each.number === number)?.body,
          labels: state.labels,
          answer: (number: number) =>
            read(`answers/${number}.json`).pipe(
              Effect.map((text) => (text === "" ? undefined : (JSON.parse(text) as unknown))),
            ),
        };
      });
    const gh = (args: ReadonlyArray<string>) =>
      run(root, path.join(bin, "gh"), args, {
        FAKE_GITHUB: github,
        GITHUB_REPOSITORY: repository,
      });
    return { call, initial, gh };
  });

const reconcile = (facts: Facts, issues: ReadonlyArray<FakeIssue> = []) =>
  Effect.gen(function* () {
    const repository = yield* issueRepository(facts, issues);
    return yield* repository.call();
  });

const reads = (request: string) => request.startsWith("GET ") || request.startsWith("QUERY ");
const writes = (requests: ReadonlyArray<string>) => requests.filter((request) => !reads(request));

const esc = "\u001b";
const cloudProductLog = [
  `2026-11-18T13:40:46.6008956Z ${esc}[90mstdout${esc}[2m | e2e/tests/workflow-engine-calls.spec.ts${esc}[2m > ${esc}[22m${esc}[2mWorkflow engine calls${esc}[2m > ${esc}[22m${esc}[2ma run's sleep whose engine call failed is called again, a run whose sleep keeps failing records why for its owner, and neither an app's own failure nor a step whose answer was lost is repeated${esc}[22m${esc}[39m`,
  `2026-11-18T13:40:49.9745110Z  ${esc}[31m×${esc}[39m ${esc}[30m${esc}[46m cloud ${esc}[49m${esc}[39m e2e/tests/workflow-engine-calls.spec.ts${esc}[2m > ${esc}[22mWorkflow engine calls${esc}[2m > ${esc}[22ma run's sleep whose engine call failed is called again, a run whose sleep keeps failing records why for its owner, and neither an app's own failure nor a step whose answer was lost is repeated${esc}[33m 38902${esc}[2mms${esc}[22m${esc}[39m`,
  `2026-11-18T13:41:27.0565796Z ${esc}[41m${esc}[1m FAIL ${esc}[22m${esc}[49m ${esc}[30m${esc}[46m cloud ${esc}[49m${esc}[39m e2e/tests/workflow-engine-calls.spec.ts${esc}[2m > ${esc}[22mWorkflow engine calls${esc}[2m > ${esc}[22ma run's sleep whose engine call failed is called again, a run whose sleep keeps failing records why for its owner, and neither an app's own failure nor a step whose answer was lost is repeated`,
  `2026-11-18T13:41:27.0596047Z ${esc}[31m${esc}[1mAssertionError${esc}[22m: terminatedUntil: {"status":"complete","output":{"slept":true}}${esc}[39m`,
].join("\n");
const cloudProductScenario =
  "cloud  e2e/tests/workflow-engine-calls.spec.ts > Workflow engine calls > a run's sleep whose engine call failed is called again, a run whose sleep keeps failing records why for its owner, and neither an app's own failure nor a step whose answer was lost is repeated";

const sha = (character: string) => character.repeat(40);
const heldReason =
  "executor@2.0.0-beta.5 is not on npm, and at least 5 publishing attempts failed in the last day; see `RELEASING.md` @someone";
const held = (reason = heldReason, run = 700): Decision => ({
  state: "held",
  reason,
  since: "2026-11-18T06:00:00.000Z",
  run: runUrl(run),
});
const clear = (run = 701): Decision => ({
  state: "clear",
  reason: "Nothing to publish.",
  since: "",
  run: runUrl(run),
});
const currentClear: FakeArtifact = { id: 9000, created: 1, decision: clear(709) };
const redCi = {
  runs: [ciRun(60, 0, sha("c"), "failure"), ciRun(59, 1, sha("a"), "success")],
  jobs: { 60: [{ id: 95, name: "checks / e2e-local (1/2)", log: cloudProductLog }] },
  compare: { [`${sha("a")}...${sha("c")}`]: [{ sha: sha("1"), message: "Break main" }] },
} satisfies Facts;
const greenCi = { runs: [ciRun(61, 0, sha("d"), "success")] } satisfies Facts;
const ownedIssue = (number: number, extra: Omit<FakeIssue, "number"> = {}): FakeIssue => ({
  number,
  body: `${marker}\nAn earlier run wrote this.`,
  ...extra,
});
const sourceComment = (source: string, text: string) =>
  `<!-- main-issue-source: ${source} -->\n${text}`;

type Health = "bad" | "good" | "unknown";
const ciFor: Readonly<Record<Health, Facts>> = { bad: redCi, good: greenCi, unknown: {} };
const windowsFor: Readonly<Record<Health, Facts>> = {
  bad: {
    runs: [windowsRun(62, 1, sha("c"), "failure")],
    jobs: { 62: [{ id: 91, name: "cli (win32, x64)", log: "" }] },
  },
  good: { runs: [windowsRun(58, 5, sha("a"), "success")] },
  unknown: { windows: "none" },
};
const betaFor: Readonly<Record<Health, ReadonlyArray<FakeArtifact>>> = {
  bad: [{ id: 2, created: 2, decision: held() }],
  good: [{ id: 7, created: 0, decision: clear() }],
  unknown: [],
};

const healthTable = (ci: Health) =>
  Effect.gen(function* () {
    const healths = ["bad", "good", "unknown"] as const;
    const rows = healths.flatMap((w) =>
      healths.flatMap((b) => [false, true].map((open) => ({ c: ci, w, b, open }))),
    );
    expect(rows).toHaveLength(18);
    const results = yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const facts: Facts = {
            ...ciFor[row.c],
            ...windowsFor[row.w],
            runs: [...(ciFor[row.c].runs ?? []), ...(windowsFor[row.w].runs ?? [])],
            jobs: { ...ciFor[row.c].jobs, ...windowsFor[row.w].jobs },
            artifacts: betaFor[row.b],
          };
          return { ...row, result: yield* reconcile(facts, row.open ? [ownedIssue(1)] : []) };
        }),
      { concurrency: 6 },
    );
    for (const { c, w, b, open, result } of results) {
      const row = `CI ${c}, Windows ${w}, beta ${b}, ${open ? "an issue open" : "none open"}\n${result.output}`;
      expect(result.exitCode, row).toBe(0);
      const bad = [c, w, b].includes("bad");
      const good = [c, w, b].every((each) => each === "good");
      expect(result.mutations, row).toEqual(
        bad
          ? open
            ? ["edit 1"]
            : ["create 1"]
          : good
            ? open
              ? ["edit 1", "close 1"]
              : []
            : open
              ? ["edit 1"]
              : [],
      );
      expect(
        result.owned.map((issue) => issue.number),
        row,
      ).toEqual(bad || (open && !good) ? [1] : []);
      const text = result.body(1) ?? result.summary;
      const said = { bad: "red", good: "green", unknown: "unknown, no finished run that counts" };
      expect(text, row).toContain(`- CI on main: ${said[c]}\n`);
      expect(text, row).toContain(`- The Windows check: ${said[w]}\n`);
      expect(text, row).toContain(
        `- The beta release: ${{ bad: "held", good: "not held", unknown: "unknown, no Beta decision in the last six days could be read" }[b]}\n`,
      );
      if (!bad && !good)
        expect(text, row).toMatch(
          /\nNothing is known to be red or held\. .* cannot be read \(below\), so this issue stays as it was/,
        );
      else expect(text, row).not.toContain("Nothing is known to be red or held.");
    }
  }).pipe(Effect.scoped);

const applyEdits = (value: unknown, edits: ReadonlyArray<Edit>) => {
  const edited = JSON.parse(JSON.stringify(value)) as Record<string | number, unknown>;
  for (const edit of edits) {
    const parent = edit.path
      .slice(0, -1)
      .reduce<Record<string | number, unknown>>(
        (at, key) => at[key] as Record<string | number, unknown>,
        edited,
      );
    const key = edit.path.at(-1)!;
    if ("delete" in edit && Array.isArray(parent)) parent.splice(Number(key), 1);
    else if ("delete" in edit) delete parent[key];
    else parent[key] = edit.value;
  }
  return edited;
};

type AnswerKind =
  | "runs"
  | "attempt"
  | "jobs"
  | "compare"
  | "artifacts"
  | "producer"
  | "issues"
  | "label";
const kindOf = (request: string): AnswerKind | undefined =>
  /^GET actions\/workflows\/[^/]+\/runs\?/.test(request)
    ? "runs"
    : /^GET actions\/runs\/\d+\/attempts\/\d+$/.test(request)
      ? "attempt"
      : /^GET actions\/runs\/\d+\/attempts\/\d+\/jobs\?/.test(request)
        ? "jobs"
        : request.startsWith("GET compare/")
          ? "compare"
          : request.startsWith("GET actions/artifacts?")
            ? "artifacts"
            : /^GET actions\/runs\/\d+$/.test(request)
              ? "producer"
              : request.startsWith("QUERY graphql issues")
                ? "issues"
                : request.startsWith("GET labels/")
                  ? "label"
                  : undefined;
const freeText: Readonly<Record<AnswerKind, ReadonlyArray<string>>> = {
  runs: ["display_title"],
  attempt: [],
  jobs: ["name"],
  compare: ["message"],
  artifacts: ["head_branch"],
  producer: [],
  issues: ["title", "body", "login", "name", "endCursor"],
  label: [],
};

interface Spoiling {
  readonly what: string;
  readonly ops: ReadonlyArray<Edit>;
  readonly expect: "fail" | "same";
}

const spoilings = (answer: unknown, kind: AnswerKind): ReadonlyArray<Spoiling> => {
  const out: Array<Spoiling> = [];
  const other = (value: unknown) =>
    typeof value === "string"
      ? 7
      : typeof value === "number"
        ? String(value)
        : typeof value === "boolean"
          ? String(value)
          : value === null
            ? 7
            : "x";
  const visit = (value: unknown, at: ReadonlyArray<string | number>) => {
    const where = at.join(".") || "the answer";
    if (Array.isArray(value)) {
      out.push({
        what: `${where} empty, its count unchanged`,
        ops: [{ path: at, value: [] }],
        expect: "fail",
      });
      if (value.length > 0)
        out.push({
          what: `${where} without its last item`,
          ops: [{ path: [...at, value.length - 1], delete: true }],
          expect: "fail",
        });
      out.push({
        what: `${where} holding its first item twice`,
        ops: [
          { path: [...at, value.length > 1 ? value.length - 1 : value.length], value: value[0] },
        ],
        expect: "fail",
      });
      if (value.length > 1 && at.at(-1) !== "commits")
        out.push({
          what: `${where} with its first two items swapped`,
          ops: [
            { path: [...at, 0], value: value[1] },
            { path: [...at, 1], value: value[0] },
          ],
          expect: at.at(-1) === "workflow_runs" ? "fail" : "same",
        });
      for (const index of new Set([0, value.length - 1]))
        if (index >= 0 && index < value.length) visit(value[index], [...at, index]);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const path = [...at, key];
      const name = path.join(".");
      out.push({ what: `${name} missing`, ops: [{ path, delete: true }], expect: "fail" });
      out.push({
        what: `${name} of another type`,
        ops: [{ path, value: other(child) }],
        expect: "fail",
      });
      if (typeof child === "string" && !freeText[kind].includes(key))
        out.push({
          what: `${name} an unknown value`,
          ops: [{ path, value: "nonsense" }],
          expect: "fail",
        });
      if (typeof child === "number" && /^(total_count|total_commits|totalCount)$/.test(key))
        out.push({ what: `${name} one more`, ops: [{ path, value: child + 1 }], expect: "fail" });
      visit(child, path);
    }
  };
  visit(answer, []);
  if (kind === "issues")
    for (const errors of [[], [{ message: "Something went wrong", type: "INTERNAL" }]])
      out.push({
        what: `errors ${JSON.stringify(errors)} beside the data`,
        ops: [{ path: ["errors"], value: errors }],
        expect: "fail",
      });
  return out;
};

const everyAnswer: Facts = {
  runs: [
    {
      ...ciRun(60, 0, sha("c"), "failure"),
      attempt: 2,
      status: "in_progress",
      previous: "failure",
    },
    ciRun(59, 1, sha("a"), "success"),
    windowsRun(62, 1, sha("c"), "failure"),
    windowsRun(58, 5, sha("a"), "success"),
  ],
  jobs: {
    "60:1": [
      { id: 95, name: "checks / e2e-local (1/2)", log: cloudProductLog },
      { id: 96, name: "checks / check", conclusion: "success", log: "" },
    ],
    62: [
      { id: 91, name: "cli (win32, x64)", log: "" },
      { id: 92, name: "metadata", conclusion: "success", log: "" },
    ],
  },
  compare: {
    [`${sha("a")}...${sha("c")}`]: [
      { sha: sha("1"), message: "Break main" },
      { sha: sha("2"), message: "Break it more" },
    ],
  },
  artifacts: [
    { id: 1, created: 3, decision: clear() },
    { id: 2, created: 2, decision: held() },
  ],
};
const everyIssue: ReadonlyArray<FakeIssue> = [
  ownedIssue(1, { labels: [mainLabel, "ci"] }),
  { number: 2, body: "Not this script's.", labels: [mainLabel, "other"] },
];

const spoilEach = (
  kind: AnswerKind,
  world: Facts = everyAnswer,
  issues: ReadonlyArray<FakeIssue> = everyIssue,
) =>
  Effect.gen(function* () {
    const first = yield* issueRepository(world, issues);
    const clean = yield* first.call();
    expect(clean.exitCode, clean.output).toBe(0);
    const targets = clean.requests.flatMap((request, index) =>
      kindOf(request) === kind ? [{ request, at: index + 1 }] : [],
    );
    expect(targets.length, kind).toBeGreaterThan(0);
    const cases: Array<{
      readonly request: string;
      readonly at: number;
      readonly spoiling: Spoiling;
    }> = [];
    for (const { request, at } of targets) {
      const answer = yield* clean.answer(at);
      expect(answer, request).toBeDefined();
      for (const spoiling of spoilings(answer, kind)) cases.push({ request, at, spoiling });
    }
    const results = yield* Effect.forEach(
      cases,
      ({ request, at, spoiling }) =>
        Effect.gen(function* () {
          const repository = yield* issueRepository(world, issues);
          const result = yield* repository.call([{ edit: at, ops: spoiling.ops }]);
          return { request, spoiling, result, initial: repository.initial };
        }),
      { concurrency: 8 },
    );
    for (const { request, spoiling, result, initial } of results) {
      const what = `${request}: ${spoiling.what}\n${result.output}`;
      if (spoiling.expect === "same") {
        expect(result.exitCode, what).toBe(0);
        expect(result.mutations, what).toEqual(clean.mutations);
        expect(result.issues, what).toEqual(clean.issues);
      } else {
        expect(result.exitCode, what).not.toBe(0);
        expect(result.output, what).toContain("::error::");
        expect(writes(result.requests), what).toEqual([]);
        expect(result.issues, what).toEqual(initial);
      }
    }
    return results.length;
  }).pipe(Effect.scoped);

layer(NodeServices.layer, { excludeTestServices: true })("Red main issue", (it) => {
  it.effect("a red CI run names the failed scenario its colored log lists, as on 18 Nov", () =>
    Effect.gen(function* () {
      const result = yield* reconcile({
        runs: [ciRun(60, 0, sha("c"), "failure"), ciRun(59, 1, sha("a"), "success")],
        jobs: {
          60: [
            {
              id: 134840250954,
              name: "checks / e2e-cloud (cloud-product 2/2)",
              log: cloudProductLog,
            },
            {
              id: 134844880127,
              name: "checks / e2e",
              log: `2026-11-18T13:42:00.0000000Z ${esc}[31mcloud-product: failure${esc}[39m`,
            },
            { id: 134844880128, name: "checks / check", conclusion: "success", log: "" },
          ],
        },
        artifacts: [],
        windows: "none",
        compare: {
          [`${sha("a")}...${sha("c")}`]: [
            { sha: sha("1"), message: "Pin the `engine` for @someone\n\nBody text" },
            { sha: sha("2"), message: "Package the engine's runtime" },
          ],
        },
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(
        result.calls
          .filter((call) => call.includes("/logs"))
          .every((call) => call.startsWith("api --allow-escape-sequences ")),
      ).toBe(true);
      expect(result.open.map((issue) => [issue.title, issue.user, issue.labels])).toEqual([
        [mainTitle, bot, [mainLabel]],
      ]);
      const body = result.body(result.open[0]!.number)!;
      expect(body.startsWith(`${marker}\n`)).toBe(true);
      expect(body).toContain(
        [
          "## CI on main",
          "",
          "Red. Fix the cause: do not re-run or revert to get it green.",
          "",
          `- Latest failure: ${runUrl(60)} on ${sha("c")}`,
          `- First failure: ${runUrl(60)} on ${sha("c")}`,
          `- Last green run before it: ${runUrl(59)} on ${sha("a")}. The first failure came from a commit in https://github.com/${repository}/compare/${sha("a")}...${sha("c")}`,
          "",
          "Commits since the last green run, oldest first:",
          "",
          `- ${"1".repeat(9)} Pin the engine for someone`,
          `- ${"2".repeat(9)} Package the engine's runtime`,
          "",
          "Failed jobs in the latest failure:",
          "",
          `- [checks / e2e-cloud (cloud-product 2/2)](${runUrl(60)}/job/134840250954)`,
          `  - \`${cloudProductScenario}\``,
          `- [checks / e2e](${runUrl(60)}/job/134844880127)`,
          "  - No failed scenario in its log; see the job's failed step.",
        ].join("\n"),
      );
      expect(body).not.toContain("checks / check");
      expect(body).not.toContain("Body text");
      expect(body).toContain(
        "- CI on main: red\n- The Windows check: unknown, no finished run that counts\n",
      );
      expect(body).not.toContain("Nothing is known to be red or held.");
      expect(body).toContain(
        `## The Windows check\n\nUnknown: no finished run of the Windows check (${windowsTitle} on ci/windows-check) counts yet, so whether it is red cannot be read. Unknown neither opens nor closes this issue.`,
      );
      expect(body).toContain(
        "## The beta release\n\nUnknown: no Beta tick in the last six days left a decision (the beta-hold artifact beta.yml uploads when it decides held or clear, kept for seven days), and none is kept at all. So whether a beta is held cannot be read, and unknown neither opens nor closes this issue.",
      );
      expect(result.summary).toBe(`${body}\n`);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "the first failure is the oldest red run since the last green one, read across pages",
    () =>
      Effect.gen(function* () {
        const runs = [
          ...Array.from({ length: 230 }, (_, n) => ciRun(1000 - n, n, sha("c"), "failure")),
          ciRun(700, 230, sha("f"), "cancelled"),
          ciRun(699, 231, sha("b"), "failure"),
          ciRun(698, 232, sha("a"), "success"),
          ciRun(697, 233, sha("9"), "failure"),
        ];
        const result = yield* reconcile({
          runs: [ciRun(1001, 0, sha("d"), "skipped"), ...runs],
          jobs: { 1000: [{ id: 95, name: "checks / e2e", log: cloudProductLog }] },
          compare: { [`${sha("a")}...${sha("b")}`]: [] },
        });
        expect(result.exitCode, result.output).toBe(0);
        const body = result.body(result.owned[0]!.number)!;
        expect(body).toContain(`- Latest failure: ${runUrl(1000)} on ${sha("c")}`);
        expect(body).toContain(`- First failure: ${runUrl(699)} on ${sha("b")}`);
        expect(body).toContain(`- Last green run before it: ${runUrl(698)} on ${sha("a")}.`);
        expect(
          result.requests.filter((request) => request.includes("/workflows/ci.yml/runs")),
        ).toEqual(
          [1, 2, 3].map((page) => expect.stringContaining(`event=push&per_page=100&page=${page}`)),
        );
        const never = yield* reconcile({
          runs: Array.from({ length: 600 }, (_, n) => ciRun(2000 - n, n, sha("c"), "failure")),
          jobs: { 2000: [] },
        });
        expect(never.exitCode, never.output).toBe(0);
        const text = never.body(never.owned[0]!.number)!;
        expect(text).toContain(`- First failure: ${runUrl(1501)} on ${sha("c")}`);
        expect(text).toContain("- No earlier green run: 500 finished runs read, none passed.");
        expect(text).toContain("- No failed job listed; see the run.");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a red run being re-run stays red from its previous attempt, and a first attempt still running counts for nothing",
    () =>
      Effect.gen(function* () {
        const rerun: FakeRun = {
          ...ciRun(60, 0, sha("c"), "failure"),
          attempt: 2,
          status: "in_progress",
          previous: "failure",
        };
        const facts: Facts = {
          runs: [
            { ...ciRun(62, 0, sha("d"), "failure"), status: "in_progress" },
            rerun,
            ciRun(59, 1, sha("a"), "success"),
          ],
          jobs: {
            "60:1": [{ id: 95, name: "checks / e2e-local (1/2)", log: cloudProductLog }],
            "60:2": [{ id: 96, name: "checks / e2e-local (2/2)", log: "" }],
          },
          compare: redCi.compare,
        };
        const result = yield* reconcile(facts, [ownedIssue(1)]);
        expect(result.exitCode, result.output).toBe(0);
        expect(result.owned.map((issue) => issue.number)).toEqual([1]);
        const body = result.body(1)!;
        expect(body).toContain(`- Latest failure: ${runUrl(60)} on ${sha("c")}`);
        expect(body).toContain(`- [checks / e2e-local (1/2)](${runUrl(60)}/job/95)`);
        expect(body).toContain(cloudProductScenario);
        expect(body).not.toContain("e2e-local (2/2)");
        expect(result.requests).toContain("GET actions/runs/60/attempts/1");
        const green = yield* reconcile(
          { runs: [{ ...rerun, previous: "success" }, ciRun(59, 1, sha("a"), "failure")] },
          [ownedIssue(1)],
        );
        expect(green.exitCode, green.output).toBe(0);
        expect(green.owned).toEqual([]);
        expect(green.body(1)).toContain(`## CI on main\n\nGreen: ${runUrl(60)} on ${sha("c")}.`);
      }).pipe(Effect.scoped),
  );

  it.effect("a log GitHub no longer has says so, and so do commits it cannot compare", () =>
    Effect.gen(function* () {
      const gone = yield* reconcile({
        ...redCi,
        compare: {},
        jobs: {
          60: [
            { id: 81, name: "checks / e2e-local (1/2)", log: 404 },
            { id: 82, name: "checks / e2e-local (2/2)", log: 410 },
          ],
        },
      });
      expect(gone.exitCode, gone.output).toBe(0);
      const body = gone.body(gone.owned[0]!.number)!;
      expect(body).toContain(
        `- [checks / e2e-local (1/2)](${runUrl(60)}/job/81)\n  - GitHub no longer has its log; see the job.`,
      );
      expect(body).toContain(
        `- [checks / e2e-local (2/2)](${runUrl(60)}/job/82)\n  - GitHub no longer has its log; see the job.`,
      );
      expect(body).not.toContain("No failed scenario");
      expect(body).toContain(
        "GitHub cannot compare those two commits (HTTP 404), so they are not listed.",
      );
      expect(
        gone.requests.some((request) => request.startsWith(`GET compare/${sha("a")}...`)),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a log's links, titles and other terminal controls are gone from the issue, not only colors",
    () =>
      Effect.gen(function* () {
        const result = yield* reconcile({
          runs: [ciRun(60, 0, sha("c"), "failure")],
          jobs: {
            60: [
              {
                id: 82,
                name: `checks / e2e ${esc}]0;a title\u0007(1/2)\u0008`,
                log: [
                  `2026-11-18T13:41:27.0565796Z ${esc}[41m FAIL ${esc}[49m ${esc}]8;;https://example.com/a${esc}\\e2e/tests/osc.spec.ts${esc}]8;;${esc}\\ > OSC > a link around the file\r`,
                  `2026-11-18T13:41:27.0565796Z ${esc}P1$r0m${esc}\\${esc}(B${esc}=AssertionError: expected 1 to be 2`,
                ].join("\n"),
              },
              {
                id: 83,
                name: "checks / e2e (2/2)",
                log: `2026-11-18T13:41:27.0565796Z  \u009b31m×\u009b39m ${esc}]0;tab title\u0007e2e/tests/osc.spec.ts > OSC > a title set by the log${esc}(B\u0007 120ms`,
              },
              {
                id: 84,
                name: "checks / e2e (3/3)",
                log: new Uint8Array([
                  ...new TextEncoder().encode(
                    `2026-11-18T13:41:27.0565796Z ${esc}[31m FAIL ${esc}[39m e2e/tests/osc.spec.ts > OSC > a byte that is not text `,
                  ),
                  0xff,
                  0x0a,
                ]),
              },
              {
                id: 85,
                name: "checks / e2e (4/4)",
                log: [
                  `2026-11-18T13:41:27.0565796Z  FAIL  e2e/tests/osc.spec.ts > OSC > before ${esc}]0;title\u009c ordinary after`,
                  `2026-11-18T13:41:27.0565796Z  FAIL  e2e/tests/osc.spec.ts > OSC > first \u009d0;title${esc}\\ kept after`,
                ].join("\n"),
              },
            ],
          },
        });
        expect(result.exitCode, result.output).toBe(0);
        expect(result.open.length).toBe(1);
        const body = result.body(result.open[0]!.number)!;
        expect(body).toContain(
          `- [checks / e2e (1/2)](${runUrl(60)}/job/82)\n  - \`e2e/tests/osc.spec.ts > OSC > a link around the file\``,
        );
        expect(body).toContain(
          `- [checks / e2e (2/2)](${runUrl(60)}/job/83)\n  - \`e2e/tests/osc.spec.ts > OSC > a title set by the log\``,
        );
        expect(body).toContain(
          `- [checks / e2e (3/3)](${runUrl(60)}/job/84)\n  - \`e2e/tests/osc.spec.ts > OSC > a byte that is not text �\``,
        );
        expect(body).toContain(
          `- [checks / e2e (4/4)](${runUrl(60)}/job/85)\n  - \`e2e/tests/osc.spec.ts > OSC > before  ordinary after\`\n  - \`e2e/tests/osc.spec.ts > OSC > first  kept after\``,
        );
        expect(controlsIn(body)).toEqual([]);
        expect(body).not.toContain("example.com");
      }).pipe(Effect.scoped),
  );

  it.effect("a red Windows check opens the same issue, from its own runs only", () =>
    Effect.gen(function* () {
      const result = yield* reconcile({
        runs: [
          ...greenCi.runs,
          windowsRun(62, 1, sha("c"), "failure"),
          windowsRun(58, 5, sha("a"), "success"),
          {
            ...windowsRun(63, 0, sha("d"), "success"),
            title: "Executor releases (build, cli on linux-x64)",
          },
          windowsRun(64, 0, sha("d"), "cancelled"),
          { ...windowsRun(65, 0, sha("d"), "success"), branch: "win-runtime-restart-limits" },
        ],
        jobs: {
          62: [
            {
              id: 91,
              name: "cli (win32, x64)",
              log: "2026-11-18T14:15:54.1493548Z  FAIL   local  e2e/tests/local-app-runtime-restart.spec.ts > Local app runtime restart > a scenario",
            },
          ],
        },
        compare: { [`${sha("a")}...${sha("c")}`]: [] },
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.open.map((issue) => [issue.number, issue.title, issue.labels])).toEqual([
        [1, mainTitle, [mainLabel]],
      ]);
      const body = result.body(1)!;
      expect(body).toContain(`## CI on main\n\nGreen: ${runUrl(61)} on ${sha("d")}.`);
      expect(body).toContain(
        [
          "## The Windows check",
          "",
          "Red. Fix the cause: do not re-run or revert to get it green.",
          "",
          `- Latest failure: ${runUrl(62)} on ${sha("c")}`,
          `- First failure: ${runUrl(62)} on ${sha("c")}`,
          `- Last green run before it: ${runUrl(58)} on ${sha("a")}.`,
        ].join("\n"),
      );
      expect(body).toContain(
        `- [cli (win32, x64)](${runUrl(62)}/job/91)\n  - \`local  e2e/tests/local-app-runtime-restart.spec.ts > Local app runtime restart > a scenario\``,
      );
      const passed = yield* reconcile(
        {
          runs: [
            ...greenCi.runs,
            windowsRun(66, 0, sha("d"), "success"),
            windowsRun(62, 1, sha("c"), "failure"),
          ],
        },
        [ownedIssue(1, { body })],
      );
      expect(passed.exitCode, passed.output).toBe(0);
      expect(passed.open).toEqual([]);
      expect(passed.mutations).toEqual(["edit 1", "close 1"]);
      expect(passed.issues[0]!.reason).toBe("completed");
      expect(passed.body(1)).toContain(
        `## The Windows check\n\nGreen: ${runUrl(66)} on ${sha("d")}.`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "the newest held-beta decision Beta uploaded decides; a clear one closes the issue",
    () =>
      Effect.gen(function* () {
        const heldIssue = yield* reconcile({
          ...greenCi,
          artifacts: [
            { id: 1, created: 30, decision: clear(690) },
            { id: 2, created: 2, decision: held() },
            { id: 4, created: 1, decision: clear(703), branch: "beta-fix" },
            { id: 5, created: 1, decision: clear(704), fork: true },
            { id: 6, created: 1, decision: clear(705), name: "beta-hold-copy" },
          ],
        });
        expect(heldIssue.exitCode, heldIssue.output).toBe(0);
        const body = heldIssue.body(heldIssue.owned[0]!.number)!;
        expect(body).toContain(
          [
            "## The beta release",
            "",
            `Held. A beta has been due since 2026-11-18T06:00:00.000Z and is not out. The latest Beta tick that decided, ${runUrl(700)}, held it:`,
            "",
            "> `executor@2.0.0-beta.5 is not on npm, and at least 5 publishing attempts failed in the last day; see RELEASING.md @someone`",
          ].join("\n"),
        );
        expect(heldIssue.body(heldIssue.owned[0]!.number)).toContain(`Green: ${runUrl(61)}`);
        const cleared = yield* reconcile(
          {
            ...greenCi,
            artifacts: [
              { id: 2, created: 2, decision: held() },
              { id: 7, created: 0, decision: clear() },
            ],
          },
          [ownedIssue(1, { body })],
        );
        expect(cleared.exitCode, cleared.output).toBe(0);
        expect(cleared.open).toEqual([]);
        expect(cleared.body(1)).toContain(
          `## The beta release\n\nNot held: the latest Beta tick that decided, ${runUrl(701)}, found it on npm with nothing holding the next.`,
        );
        const unknown = yield* reconcile({
          ...greenCi,
          artifacts: [{ id: 2, created: 2, decision: { ...held(), since: "" } }],
        });
        expect(unknown.body(unknown.owned[0]!.number)).toContain(
          `Held. A beta is due and is not out; when it became due could not be read. The latest Beta tick that decided, ${runUrl(700)}, held it:`,
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a held-beta artifact another workflow uploaded, or one not as Beta writes it, writes nothing",
    () =>
      Effect.gen(function* () {
        for (const artifact of [
          { id: 2, created: 0, decision: held(), workflow: "ci.yml" },
          { id: 2, created: 0, decision: "not json" },
          {
            id: 2,
            created: 0,
            decision: JSON.stringify({ state: "maybe", reason: "", since: "", run: "" }),
          },
        ]) {
          const repository = yield* issueRepository({ ...redCi, artifacts: [artifact] }, [
            ownedIssue(1),
          ]);
          const result = yield* repository.call();
          expect(result.exitCode, result.output).not.toBe(0);
          expect(writes(result.requests)).toEqual([]);
          expect(result.issues).toEqual(repository.initial);
        }
      }).pipe(Effect.scoped),
  );

  it.effect("CI, the Windows check and a held beta share one issue, and each shows its part", () =>
    Effect.gen(function* () {
      const result = yield* reconcile({
        runs: [...redCi.runs, windowsRun(62, 1, sha("c"), "failure")],
        jobs: { ...redCi.jobs, 62: [{ id: 91, name: "cli (win32, x64)", log: "" }] },
        compare: redCi.compare,
        artifacts: [{ id: 2, created: 2, decision: held() }],
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.open.map((issue) => issue.number)).toEqual([1]);
      const body = result.body(1)!;
      expect(body).toContain("## CI on main\n\nRed.");
      expect(body).toContain("## The Windows check\n\nRed.");
      expect(body).toContain("- No earlier green run: 1 finished runs read, none passed.");
      expect(body).toContain("## The beta release\n\nHeld.");
      expect(body).toContain(cloudProductScenario);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a labelled issue someone else opened, or one without the marker, is never touched",
    () =>
      Effect.gen(function* () {
        const others: ReadonlyArray<FakeIssue> = [
          { number: 40, user: "someone", body: `${marker}\nCopied.` },
          { number: 41, body: "ci.yml is red on main." },
          { number: 42, body: `${marker}\nA pull request.`, pullRequest: true },
          { number: 43, body: `${marker}\nAnother label.`, labels: ["main-red-old"] },
        ];
        const green = yield* reconcile(greenCi, others);
        expect(green.exitCode, green.output).toBe(0);
        expect(green.mutations).toEqual([]);
        expect(green.open.map((issue) => issue.number)).toEqual([40, 41, 42, 43]);
        const red = yield* reconcile(redCi, others);
        expect(red.exitCode, red.output).toBe(0);
        expect(red.mutations).toEqual(["create 44"]);
        expect(red.issues.filter((issue) => issue.number !== 44)).toEqual(green.issues);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a read that fails, each in turn, writes nothing, closes nothing and fails the run (review 1)",
    () =>
      Effect.gen(function* () {
        const worlds: ReadonlyArray<readonly [Facts, ReadonlyArray<FakeIssue>]> = [
          [
            { ...greenCi, artifacts: [{ id: 2, created: 2, decision: held() }] },
            [
              ownedIssue(1, {
                comments: [
                  sourceComment("ci.yml", "ci.yml is red on main."),
                  sourceComment("beta-held", "## The beta release is held"),
                ],
              }),
            ],
          ],
          [
            {
              runs: [
                {
                  ...ciRun(500, 0, sha("c"), "failure"),
                  attempt: 2,
                  status: "in_progress",
                  previous: "failure",
                },
                ...Array.from({ length: 149 }, (_, n) =>
                  ciRun(499 - n, n + 1, sha("c"), "failure"),
                ),
                ciRun(300, 150, sha("a"), "success"),
                windowsRun(62, 1, sha("c"), "failure"),
              ],
              jobs: {
                "500:1": Array.from({ length: 120 }, (_, n) => ({
                  id: 5000 + n,
                  name: `job ${n}`,
                  conclusion: n % 40 === 0 ? "failure" : "success",
                  log: cloudProductLog,
                })),
                62: [{ id: 91, name: "cli (win32, x64)", log: "" }],
              },
              compare: {
                [`${sha("a")}...${sha("c")}`]: [{ sha: sha("1"), message: "Break main" }],
              },
              artifacts: Array.from({ length: 120 }, (_, n) => ({
                id: n + 1,
                created: 200 - n,
                decision: n === 119 ? held() : clear(),
              })),
            },
            [ownedIssue(3), ownedIssue(1, { state: "closed" }), ownedIssue(5)],
          ],
        ];
        for (const [facts, issues] of worlds) {
          const clean = yield* (yield* issueRepository(facts, issues)).call();
          expect(clean.exitCode, clean.output).toBe(0);
          expect(writes(clean.requests).length).toBeGreaterThan(0);
          const firstWrite = clean.requests.findIndex((request) => !reads(request));
          expect(clean.requests.slice(firstWrite).filter(reads)).toEqual([]);
          const readAt = clean.requests.flatMap((request, index) =>
            reads(request) ? [index + 1] : [],
          );
          if (facts.runs?.some((run) => run.status !== undefined))
            expect(clean.requests).toContain("GET actions/runs/500/attempts/1");
          expect(readAt.length).toBeGreaterThan(5);
          for (const fault of readAt) {
            const repository = yield* issueRepository(facts, issues);
            const failed = yield* repository.call([fault]);
            const what = `${clean.requests[fault - 1]}\n${failed.output}`;
            expect(failed.exitCode, what).not.toBe(0);
            expect(writes(failed.requests), what).toEqual([]);
            expect(failed.issues, what).toEqual(repository.initial);
          }
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "two open issues with stale reports leave nothing open once every source is fine (review 2)",
    () =>
      Effect.gen(function* () {
        const result = yield* reconcile(
          { ...greenCi, artifacts: [{ id: 7, created: 0, decision: clear() }] },
          [
            ownedIssue(1, { comments: [sourceComment("ci.yml", "ci.yml is red on main.")] }),
            ownedIssue(2, {
              comments: [sourceComment("beta-held", "## The beta release is held\n\nold held")],
            }),
          ],
        );
        expect(result.exitCode, result.output).toBe(0);
        expect(result.owned).toEqual([]);
        expect(result.requests.filter((request) => request.includes("/comments"))).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("a newer duplicate's report does not lose to an older kept one (review 2)", () =>
    Effect.gen(function* () {
      const result = yield* reconcile(
        { ...redCi, artifacts: [{ id: 2, created: 1, decision: held("the newer hold") }] },
        [
          ownedIssue(1, { comments: [sourceComment("beta-held", "> `the older hold`")] }),
          ownedIssue(2, { comments: [sourceComment("beta-held", "> `the newer hold`")] }),
        ],
      );
      expect(result.exitCode, result.output).toBe(0);
      expect(result.owned.map((issue) => issue.number)).toEqual([1]);
      expect(result.body(1)).toContain("> `the newer hold`");
      expect(result.body(1)).not.toContain("the older hold");
      expect(result.issues.find((issue) => issue.number === 2)!.reason).toBe("not_planned");
    }).pipe(Effect.scoped),
  );

  it.effect("a clear the issue did not see still removes the hold it shows (review 3)", () =>
    Effect.gen(function* () {
      const shown = [
        marker,
        "## CI on main",
        "",
        "Red.",
        "",
        "## The beta release",
        "",
        `Held. A beta has been due since 2026-11-18T06:00:00.000Z and is not out. The latest Beta tick that decided, ${runUrl(700)}, held it:`,
      ].join("\n");
      const result = yield* reconcile(
        {
          ...redCi,
          artifacts: [
            { id: 2, created: 3, decision: held() },
            { id: 7, created: 2, decision: clear() },
          ],
        },
        [ownedIssue(1, { body: shown })],
      );
      expect(result.exitCode, result.output).toBe(0);
      expect(result.owned.map((issue) => issue.number)).toEqual([1]);
      expect(result.body(1)).not.toContain("Held.");
      expect(result.body(1)).toContain("## CI on main\n\nRed.");
      expect(result.body(1)).toContain("## The beta release\n\nNot held:");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a red Windows check and a held beta leave one issue, labelled main-health (review 4)",
    () =>
      Effect.gen(function* () {
        const result = yield* reconcile({
          runs: [...greenCi.runs, windowsRun(62, 1, sha("c"), "failure")],
          jobs: { 62: [{ id: 91, name: "cli (win32, x64)", log: "" }] },
          artifacts: [{ id: 2, created: 0, decision: held() }],
        });
        expect(result.exitCode, result.output).toBe(0);
        expect(result.open.map((issue) => [issue.number, issue.labels])).toEqual([
          [1, [mainLabel]],
        ]);
        expect(result.body(1)).toContain("## The Windows check\n\nRed.");
        expect(result.body(1)).toContain("## The beta release\n\nHeld.");
      }).pipe(Effect.scoped),
  );

  it.effect("lists of 250 issues, jobs and artifacts are read to their ends (review 5)", () =>
    Effect.gen(function* () {
      const unmarked = Array.from({ length: 249 }, (_, n) => ({
        number: n + 2,
        body: "Not this script's.",
      }));
      const result = yield* reconcile(
        {
          runs: redCi.runs,
          compare: redCi.compare,
          jobs: {
            60: Array.from({ length: 250 }, (_, n) => ({
              id: 7000 + n,
              name: `job ${n}`,
              conclusion: n >= 240 ? "failure" : "success",
              log: n >= 240 ? cloudProductLog : "",
            })),
          },
          artifacts: Array.from({ length: 250 }, (_, n) => ({
            id: n + 1,
            created: 250 - n,
            decision: n === 249 ? held("the newest hold") : clear(),
          })),
        },
        [ownedIssue(1), ...unmarked],
      );
      expect(result.exitCode, result.output).toBe(0);
      expect(result.mutations).toEqual(["edit 1"]);
      expect(result.owned.map((issue) => issue.number)).toEqual([1]);
      const body = result.body(1)!;
      for (let n = 240; n < 250; n++)
        expect(body).toContain(`- [job ${n}](${runUrl(60)}/job/${7000 + n})`);
      expect(body).not.toContain("[job 239]");
      expect(body).toContain("> `the newest hold`");
      for (const list of ["/jobs?", "artifacts?"])
        expect(
          result.requests
            .filter((request) => request.includes(list))
            .map((request) => request.replace(/.*&page=/, "")),
          list,
        ).toEqual(["1", "2", "3"]);
      expect(result.requests.filter((request) => request.startsWith("QUERY graphql"))).toEqual([
        "QUERY graphql issues",
        "QUERY graphql issues after=100",
        "QUERY graphql issues after=200",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "the issue depends only on the facts: any earlier state ends the same, and a second run writes nothing",
    () =>
      Effect.gen(function* () {
        const facts: Facts = {
          ...redCi,
          runs: [
            ...redCi.runs,
            windowsRun(62, 1, sha("c"), "failure"),
            windowsRun(58, 5, sha("a"), "success"),
          ],
          jobs: { ...redCi.jobs, 62: [{ id: 91, name: "cli (win32, x64)", log: cloudProductLog }] },
          artifacts: [
            { id: 2, created: 2, decision: held() },
            { id: 1, created: 9, decision: clear() },
          ],
        };
        const stale = Array.from({ length: 250 }, (_, n) =>
          sourceComment(n % 2 === 0 ? "ci.yml" : "beta-held", `stale ${n}`),
        );
        const earlier: ReadonlyArray<ReadonlyArray<FakeIssue>> = [
          [],
          [ownedIssue(4, { title: "Something else", body: `${marker}\nWrong.`, comments: stale })],
          [
            ownedIssue(9),
            ownedIssue(3, { body: `${marker}\nOther.` }),
            ownedIssue(5, { comments: stale }),
          ],
          [
            ownedIssue(2, { state: "closed" }),
            { number: 6, user: "someone", body: `${marker}\nCopied.` },
          ],
        ];
        const results = [];
        for (const issues of earlier) {
          const repository = yield* issueRepository(facts, issues);
          const first = yield* repository.call();
          expect(first.exitCode, first.output).toBe(0);
          expect(first.owned.length, first.output).toBe(1);
          expect(first.requests.filter((request) => request.includes("/comments"))).toEqual([]);
          const second = yield* repository.call();
          expect(second.exitCode, second.output).toBe(0);
          expect(second.mutations).toEqual([]);
          expect(second.owned).toEqual(first.owned);
          results.push(first.owned.map((issue) => [issue.title, issue.body, issue.labels]));
        }
        for (const each of results) expect(each).toEqual(results[0]);
        for (const issues of earlier) {
          const result = yield* reconcile(
            { ...greenCi, artifacts: [{ id: 7, created: 0, decision: clear() }] },
            issues,
          );
          expect(result.exitCode, result.output).toBe(0);
          expect(result.owned).toEqual([]);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a run is green only if its latest completed attempt passed, and a cancelled attempt never hides an earlier failure (review 3, 1)",
    () =>
      Effect.gen(function* () {
        const cells: ReadonlyArray<
          readonly [ReadonlyArray<string>, "running" | string | undefined, string]
        > = [
          [["success"], "running", "green 1"],
          [["success"], "success", "green 2"],
          [["success"], "failure", "red 2"],
          [["success"], "cancelled", "nothing"],
          [["failure"], "running", "red 1"],
          [["failure"], "success", "green 2"],
          [["failure"], "failure", "red 2"],
          [["failure"], "cancelled", "red 1"],
          [["failure"], "skipped", "red 1"],
          [["cancelled"], "running", "nothing"],
          [["cancelled"], "success", "green 2"],
          [["cancelled"], "failure", "red 2"],
          [["cancelled"], "cancelled", "nothing"],
          [[], "running", "nothing"],
          [[], "cancelled", "nothing"],
          [["failure", "cancelled"], "cancelled", "red 1"],
          [["failure", "cancelled"], "running", "red 1"],
          [["success", "failure"], "cancelled", "red 2"],
          [["failure", "success"], "cancelled", "nothing"],
        ];
        for (const [before, last, expected] of cells) {
          const attempt = before.length + 1;
          const newest: FakeRun = {
            ...ciRun(60, 0, sha("c"), last === "running" ? "failure" : (last as Conclusion)),
            attempt,
            attempts: before,
            ...(last === "running" ? { status: "in_progress" as const } : {}),
          };
          const result = yield* reconcile(
            {
              runs: [newest, ciRun(59, 1, sha("a"), "success")],
              jobs: Object.fromEntries(
                Array.from({ length: attempt }, (_, n) => [
                  `60:${n + 1}`,
                  [{ id: 950 + n, name: `attempt ${n + 1} job`, log: "" }],
                ]),
              ),
              compare: redCi.compare,
            },
            [ownedIssue(1)],
          );
          const cell = `${[...before, last].join(", ")}: ${expected}\n${result.output}`;
          expect(result.exitCode, cell).toBe(0);
          const [state, number] = expected.split(" ");
          if (state === "red") {
            expect(
              result.owned.map((issue) => issue.number),
              cell,
            ).toEqual([1]);
            const body = result.body(1)!;
            expect(body, cell).toContain(`- Latest failure: ${runUrl(60)} on ${sha("c")}`);
            for (let n = 1; n <= attempt; n++)
              if (String(n) === number) expect(body, cell).toContain(`[attempt ${n} job]`);
              else expect(body, cell).not.toContain(`[attempt ${n} job]`);
          } else {
            expect(result.owned, cell).toEqual([]);
            expect(result.body(1), cell).toContain(
              `## CI on main\n\nGreen: ${runUrl(state === "green" ? 60 : 59)} on ${sha(state === "green" ? "c" : "a")}.`,
            );
          }
          const attemptReads = result.requests.filter(
            (request) => request.includes("/attempts/") && !request.includes("/jobs"),
          );
          for (const read of attemptReads)
            expect(read, cell).toMatch(/^GET actions\/runs\/60\/attempts\/[0-9]+$/);
        }
        const cancelled = (count: number) =>
          Array.from({ length: count }, (_, n) => ciRun(3000 - n, n, sha("c"), "cancelled"));
        const unknown = yield* issueRepository({ runs: cancelled(600) }, [ownedIssue(1)]);
        const unread = yield* unknown.call();
        expect(unread.exitCode, unread.output).not.toBe(0);
        expect(unread.output).toContain("None of the newest 500 runs");
        expect(writes(unread.requests)).toEqual([]);
        expect(unread.issues).toEqual(unknown.initial);
        const none = yield* reconcile({ runs: cancelled(150) }, [ownedIssue(1)]);
        expect(none.exitCode, none.output).toBe(0);
        expect(none.owned.map((issue) => issue.number)).toEqual([1]);
        expect(none.mutations).toEqual(["edit 1"]);
        expect(none.body(1)).toContain(
          "## CI on main\n\nUnknown: no finished run of ci.yml on main counts yet, so whether it is red cannot be read.",
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a page that holds less than its list's count says, or moved between two reads, fails the run with nothing written (review 3, 2)",
    () =>
      Effect.gen(function* () {
        const reviewedWorld = () =>
          issueRepository({ ...greenCi, artifacts: [{ id: 1, created: 0, decision: held() }] }, [
            ownedIssue(1, { body: `${marker}\nHeld.` }),
          ]);
        const artifactPage = (yield* (yield* reviewedWorld()).call()).requests.findIndex(
          (request) => request.startsWith("GET actions/artifacts?"),
        );
        const reviewed = yield* reviewedWorld();
        const emptied = yield* reviewed.call([{ short: artifactPage + 1 }]);
        expect(emptied.exitCode, emptied.output).not.toBe(0);
        expect(emptied.output).toContain("Page 1 of repos/");
        expect(writes(emptied.requests)).toEqual([]);
        expect(emptied.issues).toEqual(reviewed.initial);

        const facts: Facts = {
          runs: [
            ...Array.from({ length: 120 }, (_, n) => ciRun(500 - n, n, sha("c"), "failure")),
            ciRun(300, 120, sha("a"), "success"),
            windowsRun(62, 1, sha("c"), "failure"),
          ],
          jobs: {
            500: Array.from({ length: 110 }, (_, n) => ({
              id: 5000 + n,
              name: `job ${n}`,
              conclusion: n === 105 ? "failure" : "success",
              log: "",
            })),
            62: [{ id: 91, name: "cli (win32, x64)", log: "" }],
          },
          compare: {
            [`${sha("a")}...${sha("c")}`]: [
              { sha: sha("1"), message: "Break main" },
              { sha: sha("2"), message: "Break it more" },
            ],
          },
          artifacts: Array.from({ length: 110 }, (_, n) => ({
            id: n + 1,
            created: 110 - n,
            decision: n === 109 ? held() : clear(),
          })),
        };
        const issues = [
          ownedIssue(1),
          ...Array.from({ length: 100 }, (_, n) => ({ number: n + 2, body: "Not this script's." })),
        ];
        const clean = yield* (yield* issueRepository(facts, issues)).call();
        expect(clean.exitCode, clean.output).toBe(0);
        const listed = (request: string) =>
          /^GET (actions\/workflows\/.*\/runs\?|actions\/runs\/.*\/jobs\?|actions\/artifacts\?|compare\/)/.test(
            request,
          ) || request.startsWith("QUERY graphql issues");
        const pages = clean.requests.flatMap((request, index) =>
          listed(request) ? [{ request, at: index + 1 }] : [],
        );
        expect(pages.map(({ request }) => request.replace(/&page=.*|\?.*| after=.*/, ""))).toEqual([
          "GET actions/workflows/ci.yml/runs",
          "GET actions/workflows/ci.yml/runs",
          "GET actions/runs/500/attempts/1/jobs",
          "GET actions/runs/500/attempts/1/jobs",
          `GET compare/${sha("a")}...${sha("c")}`,
          "GET actions/workflows/release-artifacts.yml/runs",
          "GET actions/runs/62/attempts/1/jobs",
          "GET actions/artifacts",
          "GET actions/artifacts",
          "QUERY graphql issues",
          "QUERY graphql issues",
        ]);
        const faults: ReadonlyArray<Fault> = [
          ...pages.map(({ at }) => ({ short: at })),
          ...pages
            .filter(({ request }, index) => {
              const base = (each: string) => each.replace(/\?.*| after=.*/, "");
              return index > 0 && base(pages[index - 1]!.request) === base(request);
            })
            .map(({ at }) => ({ shift: at })),
        ];
        expect(faults.length).toBe(pages.length + 4);
        const counted: Array<Fault> = [];
        for (const [index, { request, at }] of pages.entries()) {
          const base = (each: string) => each.replace(/\?.*| after=.*/, "");
          if (index === 0 || base(pages[index - 1]!.request) !== base(request)) continue;
          const answer = (yield* clean.answer(at)) as Record<string, unknown>;
          const path = request.startsWith("QUERY")
            ? ["data", "repository", "issues", "totalCount"]
            : ["total_count"];
          const count = path.reduce<unknown>(
            (value, key) => (value as Record<string, unknown>)[key],
            answer,
          );
          counted.push({ edit: at, ops: [{ path, value: (count as number) + 1 }] });
        }
        expect(counted.length).toBe(4);
        for (const fault of [...faults, ...counted]) {
          const repository = yield* issueRepository(facts, issues);
          const failed = yield* repository.call([fault]);
          const what = `${JSON.stringify(fault)} ${clean.requests[Object.values(fault)[0]! - 1]}\n${failed.output}`;
          expect(failed.exitCode, what).not.toBe(0);
          expect(failed.output, what).toContain("::error::");
          expect(writes(failed.requests), what).toEqual([]);
          expect(failed.issues, what).toEqual(repository.initial);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "Beta's newest decision expired, gone, or not exactly one decision is a failed read, and no older one stands in for it (review 3, 3)",
    () =>
      Effect.gen(function* () {
        const shown = ownedIssue(1, { body: `${marker}\n## The beta release\n\nHeld.` });
        const broken: ReadonlyArray<readonly [string, ReadonlyArray<FakeArtifact>]> = [
          ["expired, alone", [{ id: 1, created: 0, decision: held(), expired: true }]],
          [
            "expired, newer than a clear one",
            [
              { id: 2, created: 5, decision: clear() },
              { id: 1, created: 0, decision: held(), expired: true },
            ],
          ],
          [
            "listed, its zip gone (HTTP 410)",
            [{ id: 1, created: 0, decision: held(), gone: true }],
          ],
          [
            "a held and a clear object, one after the other",
            [{ id: 1, created: 0, decision: JSON.stringify(held()) + JSON.stringify(clear()) }],
          ],
          [
            "text after the object",
            [{ id: 1, created: 0, decision: `${JSON.stringify(clear())} x` }],
          ],
          [
            "a list holding the decision",
            [{ id: 1, created: 0, decision: JSON.stringify([clear()]) }],
          ],
          ["empty", [{ id: 1, created: 0, decision: "" }]],
          [
            "a field more",
            [{ id: 1, created: 0, decision: JSON.stringify({ ...clear(), extra: true }) }],
          ],
          [
            "a field missing",
            [
              {
                id: 1,
                created: 0,
                decision: JSON.stringify({ state: "clear", reason: "", run: runUrl(1) }),
              },
            ],
          ],
          [
            "since not a time",
            [{ id: 1, created: 0, decision: JSON.stringify({ ...held(), since: 5 }) }],
          ],
          [
            "run not a run of this repository",
            [
              {
                id: 1,
                created: 0,
                decision: JSON.stringify({ ...clear(), run: "https://example.com/1" }),
              },
            ],
          ],
        ];
        for (const [what, artifacts] of broken) {
          const repository = yield* issueRepository({ ...greenCi, artifacts }, [shown]);
          const result = yield* repository.call();
          expect(result.exitCode, `${what}\n${result.output}`).not.toBe(0);
          expect(writes(result.requests), what).toEqual([]);
          expect(result.issues, what).toEqual(repository.initial);
        }
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { workflow: beta } = yield* workflowFile("beta.yml");
        const record = Object.values(beta.jobs)
          .flatMap((job) => job.steps)
          .find((step) => step.name === "Record the held beta decision")!;
        expect(record.run).toBeDefined();
        const written = (env: Readonly<Record<string, string>>) =>
          Effect.gen(function* () {
            const temp = yield* fs.makeTempDirectoryScoped({ prefix: "executor-beta-hold-" });
            const result = yield* run(".", "bash", ["-e", "-c", record.run!], {
              ...env,
              RUNNER_TEMP: temp,
            });
            expect(result.exitCode, result.output).toBe(0);
            return yield* fs.readFileString(path.join(temp, "beta-hold", "beta-hold.json"));
          });
        const heldText = yield* written({
          HELD: "held",
          HELD_SINCE: "2026-11-18T06:00:00.000Z",
          HELD_REASON: 'a "quoted" reason\nover two lines, for @someone',
          HELD_RUN: runUrl(712),
        });
        const fromBeta = yield* reconcile({
          ...greenCi,
          artifacts: [{ id: 1, created: 0, decision: heldText }],
        });
        expect(fromBeta.exitCode, fromBeta.output).toBe(0);
        expect(fromBeta.body(1)).toContain(
          `Held. A beta has been due since 2026-11-18T06:00:00.000Z and is not out. The latest Beta tick that decided, ${runUrl(712)}, held it:`,
        );
        const clearText = yield* written({
          HELD: "clear",
          HELD_SINCE: "",
          HELD_REASON: "Nothing to publish.",
          HELD_RUN: runUrl(713),
        });
        const clearedByBeta = yield* reconcile(
          { ...greenCi, artifacts: [{ id: 1, created: 0, decision: clearText }] },
          [shown],
        );
        expect(clearedByBeta.exitCode, clearedByBeta.output).toBe(0);
        expect(clearedByBeta.owned).toEqual([]);
        const newer = yield* reconcile(
          {
            ...greenCi,
            artifacts: [
              { id: 1, created: 5, decision: held(), expired: true },
              { id: 2, created: 0, decision: clear() },
            ],
          },
          [shown],
        );
        expect(newer.exitCode, newer.output).toBe(0);
        expect(newer.owned).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "with no Beta decision in six days the Beta state is unknown: an open issue says so and stays open, and none opens for it (review 3, 4; review 4)",
    () =>
      Effect.gen(function* () {
        const unknownLine =
          "- The beta release: unknown, no Beta decision in the last six days could be read";
        const unknownSection =
          "## The beta release\n\nUnknown: no Beta tick in the last six days left a decision";
        for (const artifacts of [
          [],
          [{ id: 1, created: 192, decision: clear() }],
          [{ id: 1, created: 145, decision: held() }],
        ] satisfies ReadonlyArray<ReadonlyArray<FakeArtifact>>) {
          const result = yield* reconcile({ ...greenCi, artifacts }, [
            ownedIssue(1, { body: `${marker}\n## The beta release\n\nHeld.` }),
          ]);
          const what = `${JSON.stringify(artifacts)}\n${result.output}`;
          expect(result.exitCode, what).toBe(0);
          expect(
            result.owned.map((issue) => issue.number),
            what,
          ).toEqual([1]);
          expect(result.body(1), what).toContain(unknownLine);
          expect(result.body(1), what).toContain(unknownSection);
          expect(result.body(1), what).not.toContain("Not held");
        }
        const quiet = yield* reconcile({ ...greenCi, artifacts: [] });
        expect(quiet.exitCode, quiet.output).toBe(0);
        expect(writes(quiet.requests)).toEqual([]);
        expect(quiet.issues).toEqual([]);
        expect(quiet.summary).toContain(unknownLine);
        const recent = yield* reconcile(
          { ...greenCi, artifacts: [{ id: 1, created: 120, decision: clear() }] },
          [ownedIssue(1)],
        );
        expect(recent.exitCode, recent.output).toBe(0);
        expect(recent.owned).toEqual([]);
        expect(recent.body(1)).toContain("- The beta release: not held");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "Main health's issue carries a label no earlier Main health finds, and an issue an older one opened is left alone (review 3, 6)",
    () =>
      Effect.gen(function* () {
        const first = yield* issueRepository(redCi, [], oldLabels);
        const opened = yield* first.call([], { event: "schedule" });
        expect(opened.exitCode, opened.output).toBe(0);
        for (const label of oldLabels) {
          const lookup = yield* first.gh([
            "issue",
            "list",
            "--repo",
            repository,
            "--label",
            label,
            "--state",
            "open",
            "--json",
            "number",
            "--jq",
            ".[0].number // empty",
          ]);
          expect(lookup.exitCode, lookup.output).toBe(0);
          expect(lookup.output, label).toBe("");
        }
        expect(opened.mutations).toEqual([`label ${mainLabel}`, "create 1"]);
        const labelRead = opened.requests.indexOf(`GET labels/${mainLabel}`);
        expect(labelRead).toBeGreaterThan(-1);
        const unlabelled = yield* issueRepository(redCi, [], oldLabels);
        const refused = yield* unlabelled.call([labelRead + 1], { event: "schedule" });
        expect(refused.exitCode, refused.output).not.toBe(0);
        expect(writes(refused.requests)).toEqual([]);
        expect(refused.issues).toEqual([]);
        expect(opened.labels).toContain(mainLabel);
        expect(opened.open.map((issue) => issue.labels)).toEqual([[mainLabel]]);
        expect(marker).not.toContain("main-red");
        const old: FakeIssue = {
          number: 7,
          title: "CI is failing on main",
          labels: ["main-red"],
          body: `ci.yml is red on main. Fix the cause: do not re-run or revert to get it green. This issue closes when a later run passes.\n<!-- first-red: ${sha("c")} ${runUrl(60)} -->`,
        };
        const red = yield* reconcile(redCi, [old]);
        expect(red.exitCode, red.output).toBe(0);
        expect(red.mutations).toEqual(["create 8"]);
        const green = yield* reconcile(greenCi, [old]);
        expect(green.exitCode, green.output).toBe(0);
        expect(green.mutations).toEqual([]);
        expect(green.open.map((issue) => issue.number)).toEqual([7]);
      }).pipe(Effect.scoped),
  );

  it.effect("logs of the first 20 failed jobs are read, and the first 50 commits listed", () =>
    Effect.gen(function* () {
      const result = yield* reconcile({
        runs: redCi.runs,
        jobs: {
          60: Array.from({ length: 25 }, (_, n) => ({
            id: 300 + n,
            name: `job ${n}`,
            log: ` FAIL  e2e/tests/a.spec.ts > scenario ${n}`,
          })),
        },
        compare: {
          [`${sha("a")}...${sha("c")}`]: Array.from({ length: 60 }, (_, n) => ({
            sha: String(n).padStart(2, "0").repeat(20),
            message: `Commit ${n}`,
          })),
        },
      });
      expect(result.exitCode, result.output).toBe(0);
      const body = result.body(1)!;
      expect(body).toContain(
        `- [job 19](${runUrl(60)}/job/319)\n  - \`e2e/tests/a.spec.ts > scenario 19\``,
      );
      expect(body).toContain(
        `- [job 20](${runUrl(60)}/job/320)\n  - More than 20 jobs failed, so its log was not read; see the job.`,
      );
      expect(result.requests.filter((request) => request.endsWith("/logs")).length).toBe(20);
      expect(body).toContain("The first 50 of 60 commits since the last green run, oldest first:");
      expect(body).toContain("- 494949494 Commit 49");
      expect(body).not.toContain("Commit 50");
    }).pipe(Effect.scoped),
  );

  it.effect("a body past GitHub's limit is cut at a line, the same way each time", () =>
    Effect.gen(function* () {
      const long = "x".repeat(900);
      const facts: Facts = {
        runs: [ciRun(60, 0, sha("c"), "failure")],
        jobs: {
          60: Array.from({ length: 20 }, (_, n) => ({
            id: 100 + n,
            name: `job ${n}`,
            log: Array.from(
              { length: 20 },
              (_, k) => ` FAIL  e2e/tests/a.spec.ts > ${n} ${k} ${long}`,
            ).join("\n"),
          })),
        },
      };
      const first = yield* reconcile(facts);
      const again = yield* reconcile(facts, [ownedIssue(1, { body: `${marker}\nx` })]);
      expect(first.exitCode, first.output).toBe(0);
      const body = first.body(1)!;
      expect(new TextEncoder().encode(body).length).toBeLessThan(61000);
      expect(
        body.endsWith("(Cut here: GitHub keeps at most 65,536 characters. See the runs above.)"),
      ).toBe(true);
      expect(
        body
          .split("\n")
          .filter((line) => line.startsWith("  - `"))
          .every((line) => line.endsWith("`")),
      ).toBe(true);
      expect(again.body(1)).toBe(body);
    }).pipe(Effect.scoped),
  );

  for (const ci of ["bad", "good", "unknown"] as const)
    it.effect(
      `with CI ${ci}: something bad opens the issue, everything good closes it, and anything else leaves it as it was (review 4, 18 of the 54 cases)`,
      () => healthTable(ci),
    );

  it.effect("with a source unknown and nothing bad, no duplicate is closed either (review 4)", () =>
    Effect.gen(function* () {
      const result = yield* reconcile({ artifacts: [{ id: 7, created: 0, decision: clear() }] }, [
        ownedIssue(1),
        ownedIssue(2),
      ]);
      expect(result.exitCode, result.output).toBe(0);
      expect(result.mutations).toEqual(["edit 1", "edit 2"]);
      expect(result.owned.map((issue) => issue.number)).toEqual([1, 2]);
      expect(result.body(1)).toBe(result.body(2));
      expect(result.body(1)).toContain(
        "Nothing is known to be red or held. CI on main cannot be read (below), so this issue stays as it was",
      );
      const again = yield* (yield* issueRepository(
        { artifacts: [{ id: 7, created: 0, decision: clear() }] },
        result.issues.map((issue) => ({ ...issue, comments: [] })),
      )).call();
      expect(again.mutations).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "no finished CI run, a decision older than six days or none at all opens nothing and closes nothing (review 4)",
    () =>
      Effect.gen(function* () {
        const never = yield* reconcile({ artifacts: [{ id: 7, created: 0, decision: clear() }] }, [
          ownedIssue(1, { body: `${marker}\n## CI on main\n\nRed.` }),
        ]);
        expect(never.exitCode, never.output).toBe(0);
        expect(never.mutations).toEqual(["edit 1"]);
        expect(never.owned.map((issue) => issue.number)).toEqual([1]);
        expect(never.body(1)).toContain("- CI on main: unknown, no finished run that counts\n");
        expect(never.body(1)).not.toContain("Red.");
        for (const artifacts of [[], [{ id: 1, created: 144.01, decision: clear() }]]) {
          const quiet = yield* reconcile({ ...greenCi, artifacts });
          const what = `${JSON.stringify(artifacts)}\n${quiet.output}`;
          expect(quiet.exitCode, what).toBe(0);
          expect(writes(quiet.requests), what).toEqual([]);
          expect(quiet.issues, what).toEqual([]);
        }
        const aged = yield* reconcile({
          ...greenCi,
          artifacts: [{ id: 1, created: 144.01, decision: held() }],
        });
        expect(writes(aged.requests)).toEqual([]);
        expect(aged.summary).toContain(
          `/actions/runs/900001, is older than that. So whether a beta is held cannot be read`,
        );
        const inside = yield* reconcile({
          ...greenCi,
          artifacts: [{ id: 1, created: 143.99, decision: held() }],
        });
        expect(inside.mutations).toEqual(["create 1"]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a Beta producer whose event is missing, a number or not Beta's, or a CI run of an unknown status, is a failed read (review 4)",
    () =>
      Effect.gen(function* () {
        const shown = ownedIssue(1, { body: `${marker}\n## The beta release\n\nHeld.` });
        const facts: Facts = {
          ...greenCi,
          artifacts: [
            { id: 2, created: 2, decision: held() },
            { id: 7, created: 0, decision: clear() },
          ],
        };
        const clean = yield* (yield* issueRepository(facts, [shown])).call();
        expect(clean.exitCode, clean.output).toBe(0);
        expect(clean.owned).toEqual([]);
        const producer = clean.requests.indexOf("GET actions/runs/900007") + 1;
        expect(producer).toBeGreaterThan(0);
        for (const [what, ops] of [
          ["event missing", [{ path: ["event"], delete: true }]],
          ["event a number", [{ path: ["event"], value: 7 }]],
          ["a pull request's run", [{ path: ["event"], value: "pull_request" }]],
          ["a run of another branch", [{ path: ["head_branch"], value: "beta-fix" }]],
          ["a run of another workflow", [{ path: ["path"], value: ".github/workflows/ci.yml" }]],
        ] as const) {
          const repository = yield* issueRepository(facts, [shown]);
          const result = yield* repository.call([{ edit: producer, ops }]);
          expect(result.exitCode, `${what}\n${result.output}`).not.toBe(0);
          expect(result.output, what).toContain("::error::");
          expect(writes(result.requests), what).toEqual([]);
          expect(result.issues, what).toEqual(repository.initial);
        }
        const ciFacts: Facts = {
          ...redCi,
          artifacts: [{ id: 7, created: 0, decision: clear() }],
        };
        const repository = yield* issueRepository(ciFacts, [ownedIssue(1)]);
        for (const value of ["nonsense", 7, null]) {
          const result = yield* repository.call([
            { edit: 1, ops: [{ path: ["workflow_runs", 0, "status"], value }] },
          ]);
          expect(result.exitCode, `${value}\n${result.output}`).not.toBe(0);
          expect(writes(result.requests)).toEqual([]);
          expect(result.issues).toEqual(repository.initial);
        }
        for (const ops of [
          [{ path: ["workflow_runs", 0, "conclusion"], value: null }],
          [{ path: ["workflow_runs", 0, "status"], value: "in_progress" }],
        ]) {
          const result = yield* repository.call([{ edit: 1, ops }]);
          expect(result.exitCode, result.output).not.toBe(0);
          expect(writes(result.requests)).toEqual([]);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a decision or a run stamped in the future is a failed read; a clock a minute ahead is not (review 4)",
    () =>
      Effect.gen(function* () {
        const shown = ownedIssue(1, { body: `${marker}\n## The beta release\n\nHeld.` });
        for (const facts of [
          {
            ...greenCi,
            artifacts: [
              { id: 2, created: 2, decision: held() },
              { id: 7, created: -720, decision: clear() },
            ],
          },
          { runs: [ciRun(61, -2, sha("d"), "success")] },
        ] satisfies ReadonlyArray<Facts>) {
          const repository = yield* issueRepository(facts, [shown]);
          const result = yield* repository.call();
          expect(result.exitCode, result.output).not.toBe(0);
          expect(result.output).toContain("is in the future");
          expect(writes(result.requests)).toEqual([]);
          expect(result.issues).toEqual(repository.initial);
        }
        const ahead = yield* reconcile(
          {
            ...greenCi,
            artifacts: [
              { id: 2, created: 2, decision: held() },
              { id: 7, created: -1 / 60, decision: clear() },
            ],
          },
          [shown],
        );
        expect(ahead.exitCode, ahead.output).toBe(0);
        expect(ahead.owned).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "runs created at the same time are all read before one of them decides, whatever order a page boundary splits them in (review 5)",
    () =>
      Effect.gen(function* () {
        const shown = ownedIssue(1);
        const cancelled = (count: number, from: number, hours: number) =>
          Array.from({ length: count }, (_, n) =>
            ciRun(from - n, hours + n / 100, sha("0"), "cancelled"),
          );
        const ciPages = (requests: ReadonlyArray<string>) =>
          requests
            .filter((request) => request.includes("/workflows/ci.yml/runs"))
            .map((request) => Number(/&page=(\d+)$/u.exec(request)![1]));
        const bothOrders = (facts: Facts) =>
          Effect.forEach(["descending", "ascending"] as const, (order) =>
            reconcile(order === "ascending" ? { ...facts, tieOrder: order } : facts, [shown]).pipe(
              Effect.map((result) => ({ order, ...result })),
            ),
          );

        for (const result of yield* bothOrders({
          runs: [
            ...cancelled(99, 1000, 0),
            ciRun(200, 1, sha("a"), "success"),
            ciRun(201, 1, sha("b"), "failure"),
          ],
        })) {
          expect(result.exitCode, `${result.order}: ${result.output}`).toBe(0);
          expect(result.output, result.order).toContain(
            "CI bad, Windows check good, beta good: keep.",
          );
          expect(result.mutations, result.order).not.toContain("close 1");
          expect(
            result.owned.map((issue) => issue.number),
            result.order,
          ).toEqual([1]);
          const body = result.body(1)!;
          expect(body, result.order).toContain(`- Latest failure: ${runUrl(201)} on ${sha("b")}`);
          expect(body, result.order).toContain(
            `- Last green run before it: ${runUrl(200)} on ${sha("a")}.`,
          );
          expect(ciPages(result.requests), result.order).toEqual([1, 2]);
        }

        for (const result of yield* bothOrders({
          runs: [
            ...cancelled(99, 1000, 0),
            ciRun(200, 1, sha("b"), "failure"),
            ciRun(201, 1, sha("a"), "success"),
          ],
        })) {
          expect(result.exitCode, `${result.order}: ${result.output}`).toBe(0);
          expect(result.output, result.order).toContain(
            "CI good, Windows check good, beta good: close.",
          );
          expect(result.mutations, result.order).toContain("close 1");
          expect(result.owned, result.order).toEqual([]);
          expect(ciPages(result.requests), result.order).toEqual([1, 2]);
        }

        for (const result of yield* bothOrders({
          runs: [
            ...cancelled(99, 1000, 0),
            ...Array.from({ length: 100 }, (_, n) => ciRun(n + 1, 1, sha("0"), "cancelled")),
            ciRun(300, 1, sha("a"), "success"),
            ciRun(301, 1, sha("b"), "failure"),
            ...Array.from({ length: 100 }, (_, n) =>
              ciRun(5000 - n, 2 + n / 100, sha("e"), "success"),
            ),
          ],
        })) {
          expect(result.exitCode, `${result.order}: ${result.output}`).toBe(0);
          expect(result.output, result.order).toContain(
            "CI bad, Windows check good, beta good: keep.",
          );
          expect(
            result.owned.map((issue) => issue.number),
            result.order,
          ).toEqual([1]);
          const body = result.body(1)!;
          expect(body, result.order).toContain(`- Latest failure: ${runUrl(301)} on ${sha("b")}`);
          expect(body, result.order).toContain(
            `- Last green run before it: ${runUrl(300)} on ${sha("a")}.`,
          );
          expect(ciPages(result.requests), result.order).toEqual([1, 2, 3]);
        }

        for (const result of yield* bothOrders({
          runs: [
            ...cancelled(198, 1000, 0),
            ciRun(200, 3, sha("a"), "success"),
            ciRun(201, 3, sha("b"), "failure"),
          ],
        })) {
          expect(result.exitCode, `${result.order}: ${result.output}`).toBe(0);
          expect(result.output, result.order).toContain(
            "CI bad, Windows check good, beta good: keep.",
          );
          expect(result.body(1)!, result.order).toContain(
            `- Latest failure: ${runUrl(201)} on ${sha("b")}`,
          );
          expect(ciPages(result.requests), result.order).toEqual([1, 2]);
        }

        const tie = [
          ...cancelled(99, 1000, 0),
          ciRun(200, 1, sha("0"), "cancelled"),
          ciRun(201, 1, sha("0"), "cancelled"),
        ];
        for (const result of yield* bothOrders({
          runs: [...tie, ciRun(50, 2, sha("a"), "success")],
        })) {
          expect(result.exitCode, `${result.order}: ${result.output}`).toBe(0);
          expect(result.output, result.order).toContain(
            "CI good, Windows check good, beta good: close.",
          );
          expect(result.output, result.order).not.toContain("CI bad");
          expect(ciPages(result.requests), result.order).toEqual([1, 2]);
        }
        for (const result of yield* bothOrders({ runs: tie })) {
          expect(result.exitCode, `${result.order}: ${result.output}`).toBe(0);
          expect(result.output, result.order).toContain(
            "CI unknown, Windows check good, beta good:",
          );
          expect(result.mutations, result.order).not.toContain("close 1");
          expect(
            result.owned.map((issue) => issue.number),
            result.order,
          ).toEqual([1]);
        }

        for (const order of ["descending", "ascending"] as const) {
          const repository = yield* issueRepository(
            {
              runs: [
                ...cancelled(499, 10000, 0),
                ciRun(600, 6, sha("a"), "success"),
                ciRun(601, 6, sha("b"), "failure"),
              ],
              ...(order === "ascending" ? { tieOrder: order } : {}),
            },
            [shown],
          );
          const result = yield* repository.call();
          expect(result.exitCode, `${order}: ${result.output}`).not.toBe(0);
          expect(result.output, order).toContain("continue past the 500 runs read");
          expect(writes(result.requests), order).toEqual([]);
          expect(result.issues, order).toEqual(repository.initial);
          expect(ciPages(result.requests), order).toEqual([1, 2, 3, 4, 5]);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a held beta's since may be up to a minute ahead, for the two runners' clocks, and no further (review 5)",
    () =>
      Effect.gen(function* () {
        const shown = ownedIssue(1, { body: `${marker}\n## The beta release\n\nHeld.` });
        const second = 1000;
        for (const [ahead, accepted] of [
          [45 * second, true],
          [2 * 60 * second, false],
          [4 * 60 * second, false],
        ] as const) {
          const repository = yield* issueRepository(
            {
              ...greenCi,
              artifacts: [
                {
                  id: 7,
                  created: 0,
                  decision: { ...held(), since: new Date(Date.now() + ahead).toISOString() },
                },
              ],
            },
            [shown],
          );
          const result = yield* repository.call();
          if (accepted) {
            expect(result.exitCode, `${ahead}: ${result.output}`).toBe(0);
            expect(result.output).toContain("CI good, Windows check good, beta bad: keep.");
            expect(result.owned.map((issue) => issue.number)).toEqual([1]);
          } else {
            expect(result.exitCode, `${ahead}: ${result.output}`).not.toBe(0);
            expect(result.output).toContain("is in the future");
            expect(writes(result.requests)).toEqual([]);
            expect(result.issues).toEqual(repository.initial);
          }
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a hold opens the issue, a release run that decides neither leaves it, and the clear after the release closes it, from Beta's own decisions and upload step (review 4)",
    () =>
      Effect.gen(function* () {
        const { decide: tick, released, previous } = yield* world;
        const { workflow: beta } = yield* workflowFile("beta.yml");
        const steps = Object.values(beta.jobs).flatMap((job) => job.steps);
        const record = steps.find((step) => step.name === "Record the held beta decision")!;
        const upload = steps[steps.indexOf(record) + 1]!;
        expect(upload.uses).toMatch(/^actions\/upload-artifact@/);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const decisions: Array<FakeArtifact> = [];
        const run_ = (script: string, env: Readonly<Record<string, string>>) =>
          run(".", "bash", ["-e", "-c", script], env);
        const betaTick = (input: Parameters<typeof tick>[0], hoursAgo: number, run: number) =>
          Effect.gen(function* () {
            const decided = yield* tick(input);
            expect(decided.exitCode, decided.output).toBe(0);
            const context = {
              github: { server_url: "https://github.com", repository, run_id: run },
              steps: { due: { outputs: decided.outputs } },
            };
            if (!admits(record.if, context)) return { held: decided.outputs.held, uploaded: false };
            const temp = yield* fs.makeTempDirectoryScoped({ prefix: "executor-beta-hold-" });
            const recorded = yield* run_(record.run!, {
              ...stepEnv(record, context),
              RUNNER_TEMP: temp,
            });
            expect(recorded.exitCode, recorded.output).toBe(0);
            expect(
              admits(upload.if, {
                ...context,
                steps: { ...context.steps, hold: { outcome: "success" } },
              }),
            ).toBe(true);
            decisions.push({
              id: decisions.length + 1,
              created: hoursAgo,
              decision: yield* fs.readFileString(path.join(temp, "beta-hold", "beta-hold.json")),
            });
            return { held: decided.outputs.held, uploaded: true };
          });
        let issues: ReadonlyArray<FakeIssue> = [];
        const health = Effect.gen(function* () {
          const result = yield* reconcile({ ...greenCi, artifacts: [...decisions] }, issues);
          expect(result.exitCode, result.output).toBe(0);
          issues = result.issues.map(({ comments: _comments, reason: _reason, ...issue }) => issue);
          return result;
        });

        const five: ReadonlyArray<ReleaseRun> = [
          ...Array.from({ length: 5 }, (_, index) => ({
            id: 40 + index,
            hoursAgo: 0.5 + index,
            headSha: released,
          })),
          { id: 1, conclusion: "success", publish: "success", hoursAgo: 30, headSha: previous },
        ];
        expect(yield* betaTick({ runs: five }, 3, 801)).toEqual({ held: "held", uploaded: true });
        const opened = yield* health;
        expect(opened.mutations).toEqual(["create 1"]);
        expect(opened.body(1)).toContain(`## The beta release\n\nHeld. A beta has been due since `);
        const running: ReadonlyArray<ReleaseRun> = [
          { id: 50, status: "in_progress", hoursAgo: 0.1, headSha: released },
          ...five,
        ];
        expect(yield* betaTick({ runs: running }, 2, 802)).toEqual({ held: "", uploaded: false });
        const waiting = yield* health;
        expect(waiting.mutations).toEqual([]);
        expect(waiting.owned.map((issue) => issue.number)).toEqual([1]);
        expect(yield* betaTick({ published: 0.5 }, 1, 803)).toEqual({
          held: "clear",
          uploaded: true,
        });
        const closed = yield* health;
        expect(closed.mutations).toEqual(["edit 1", "close 1"]);
        expect(closed.body(1)).toContain(
          `Not held: the latest Beta tick that decided, ${runUrl(803)}`,
        );
        expect(yield* betaTick({ published: 2 }, 0.5, 804)).toEqual({
          held: "clear",
          uploaded: true,
        });
        expect(decisions.map((each) => JSON.parse(each.decision as string).state)).toEqual([
          "held",
          "clear",
          "clear",
        ]);
        expect((yield* health).mutations).toEqual([]);
      }).pipe(Effect.scoped),
  );

  for (const kind of [
    "runs",
    "attempt",
    "jobs",
    "compare",
    "artifacts",
    "producer",
    "issues",
  ] as const)
    it.effect(
      `every way the generator spoils an answer of kind ${kind} is a failed read that writes nothing (review 4)`,
      () => spoilEach(kind).pipe(Effect.map((spoilt) => expect(spoilt).toBeGreaterThan(5))),
    );

  it.effect(
    "every way the generator spoils the label's answer, read before the first issue opens, writes nothing (review 4)",
    () =>
      spoilEach("label", everyAnswer, []).pipe(
        Effect.map((spoilt) => expect(spoilt).toBeGreaterThan(2)),
      ),
  );

  it.effect(
    "every way the generator spoils Beta's decision is a failed read that writes nothing (review 4)",
    () =>
      Effect.gen(function* () {
        const shown = ownedIssue(1, { body: `${marker}\n## The beta release\n\nHeld.` });
        const decision = clear();
        const spoilt = [
          ...spoilings(decision, "attempt").filter(
            (each) => each.what !== "reason an unknown value",
          ),
          {
            what: "a field more",
            ops: [{ path: ["extra"], value: true }],
            expect: "fail" as const,
          },
          {
            what: "since an hour in the future",
            ops: [{ path: ["since"], value: new Date(Date.now() + hour).toISOString() }],
            expect: "fail" as const,
          },
        ];
        expect(spoilt.length).toBeGreaterThan(10);
        const results = yield* Effect.forEach(
          spoilt,
          (spoiling) =>
            Effect.gen(function* () {
              const repository = yield* issueRepository(
                {
                  ...greenCi,
                  artifacts: [
                    { id: 2, created: 2, decision: held() },
                    {
                      id: 7,
                      created: 0,
                      decision: JSON.stringify(applyEdits(decision, spoiling.ops)),
                    },
                  ],
                },
                [shown],
              );
              return { spoiling, result: yield* repository.call(), initial: repository.initial };
            }),
          { concurrency: 8 },
        );
        for (const { spoiling, result, initial } of results) {
          const what = `${spoiling.what}\n${result.output}`;
          expect(result.exitCode, what).not.toBe(0);
          expect(writes(result.requests), what).toEqual([]);
          expect(result.issues, what).toEqual(initial);
        }
      }).pipe(Effect.scoped),
  );
});

layer(NodeServices.layer, { excludeTestServices: true })("Main health triggers", (it) => {
  const windowsRed = (completeAfter?: Readonly<Record<number, number>>): Facts => ({
    runs: [
      ...greenCi.runs,
      windowsRun(70, 0, sha("c"), "failure"),
      windowsRun(58, 5, sha("a"), "success"),
    ],
    jobs: {
      70: [
        {
          id: 91,
          name: "cli (win32, x64)",
          log: "2026-11-18T15:20:11.0000000Z  FAIL   local  e2e/tests/local-app-runtime-restart.spec.ts > Local app runtime restart > a scenario",
        },
      ],
    },
    compare: { [`${sha("a")}...${sha("c")}`]: [{ sha: sha("b"), message: "Change Windows" }] },
    ...(completeAfter === undefined ? {} : { completeAfter }),
  });
  const pollOf = (id: number) => `GET actions/runs/${id}`;

  it.effect(
    "CI, Beta, the schedule, a person and the Windows check's dispatch all write the same issue",
    () =>
      Effect.gen(function* () {
        const once = (facts: Facts, trigger: Trigger) =>
          Effect.gen(function* () {
            const repository = yield* issueRepository(facts);
            return yield* repository.call([], trigger);
          });
        const started: ReadonlyArray<readonly [string, Facts, Trigger]> = [
          ["CI", windowsRed(), { event: "workflow_run", workflow: "CI" }],
          ["Beta", windowsRed(), { event: "workflow_run", workflow: "Beta" }],
          ["the schedule", windowsRed(), { event: "schedule" }],
          ["a person", windowsRed(), { event: "workflow_dispatch" }],
          [
            "the Windows check",
            windowsRed({ 70: 2 }),
            { event: "workflow_dispatch", inputs: { windows_run: "70" } },
          ],
        ];
        const results = [];
        for (const [who, facts, trigger] of started) {
          const result = yield* once(facts, trigger);
          expect(result.ran, who).toBe(true);
          expect(result.exitCode, `${who}: ${result.output}`).toBe(0);
          expect(result.mutations, who).toEqual(["create 1"]);
          results.push({ who, ...result });
        }
        const body = results[0]!.body(1)!;
        expect(body).toContain(
          `## The Windows check\n\nRed. Fix the cause: do not re-run or revert to get it green.\n\n- Latest failure: ${runUrl(70)} on ${sha("c")}`,
        );
        for (const result of results) {
          expect(
            result.open.map((issue) => [issue.number, issue.title]),
            result.who,
          ).toEqual([[1, mainTitle]]);
          expect(result.body(1), result.who).toBe(body);
        }
        const dispatched = results[4]!;
        expect(dispatched.sleeps).toEqual(["sleep 10", "sleep 10"]);
        expect(dispatched.requests.slice(0, 3)).toEqual([pollOf(70), pollOf(70), pollOf(70)]);
        expect(dispatched.requests.slice(3)).not.toContain(pollOf(70));
        for (const result of results.slice(0, 4)) {
          expect(result.sleeps, result.who).toEqual([]);
          expect(result.requests, result.who).not.toContain(pollOf(70));
        }
        const unwaited = yield* reconcile(windowsRed({ 70: 2 }));
        expect(unwaited.exitCode, unwaited.output).toBe(0);
        expect(unwaited.open).toEqual([]);
        expect(unwaited.summary).toContain(
          `## The Windows check\n\nGreen: ${runUrl(58)} on ${sha("a")}.`,
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a Windows check that has not ended in five minutes, or a run id that is not one, is a warning, and the issue is written from what is there",
    () =>
      Effect.gen(function* () {
        const late = yield* (yield* issueRepository(windowsRed({ 70: 1000 }))).call([], {
          event: "workflow_dispatch",
          inputs: { windows_run: "70" },
        });
        expect(late.exitCode, late.output).toBe(0);
        expect(late.sleeps).toHaveLength(30);
        expect(late.requests.filter((request) => request === pollOf(70))).toHaveLength(30);
        expect(late.output).toContain(
          "::warning::Run 70 had not ended after five minutes, so this run reads the Windows check before it; the next run reads it.",
        );
        expect(late.open).toEqual([]);
        expect(late.summary).toContain(
          `## The Windows check\n\nGreen: ${runUrl(58)} on ${sha("a")}.`,
        );

        const odd = yield* (yield* issueRepository(windowsRed())).call([], {
          event: "workflow_dispatch",
          inputs: { windows_run: "70; touch owned" },
        });
        expect(odd.exitCode, odd.output).toBe(0);
        expect(odd.output).toContain(
          "::warning::windows_run is a run id, digits only; reading at once.",
        );
        expect(odd.sleeps).toEqual([]);
        expect(odd.requests).not.toContain(pollOf(70));
        expect(odd.mutations).toEqual(["create 1"]);

        const unread = yield* (yield* issueRepository(windowsRed())).call([1], {
          event: "workflow_dispatch",
          inputs: { windows_run: "70" },
        });
        expect(unread.exitCode, unread.output).toBe(0);
        expect(unread.output).toContain("::warning::Run 70 could not be read; reading at once.");
        expect(unread.mutations).toEqual(["create 1"]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "Main health runs every trigger in one group, reads no trigger in its reconcile, and can start no workflow",
    () =>
      Effect.gen(function* () {
        const { text, workflow } = yield* workflowFile("main-health.yml");
        expect(Object.keys(workflow.on)).toEqual(["workflow_run", "schedule", "workflow_dispatch"]);
        expect(workflow.on["workflow_run"]).toEqual({
          workflows: ["CI", "Beta"],
          types: ["completed"],
          branches: ["main"],
        });
        expect(workflow.on["workflow_dispatch"]).toEqual({
          inputs: {
            windows_run: expect.objectContaining({ required: false, default: "", type: "string" }),
          },
        });
        expect(Object.keys(workflow.jobs)).toEqual(["issue"]);
        const job = workflow.jobs["issue"]!;
        expect(workflow.concurrency).toBeUndefined();
        expect(job.concurrency).toEqual({ group: "main-health", "cancel-in-progress": false });
        expect(workflow.permissions).toEqual({});
        expect(job.permissions).toEqual({ contents: "read", actions: "read", issues: "write" });
        expect(JSON.stringify(workflow)).not.toMatch(
          /"actions":"write"|gh workflow run|gh run rerun|\/dispatches|workflow_call/,
        );
        expect(text).toContain("permissions: {}\n");
        const runsFor = (trigger: Trigger) => admits(job.if, mainHealthContext(trigger));
        expect(runsFor({ event: "workflow_run", workflow: "CI" })).toBe(true);
        expect(runsFor({ event: "workflow_run", workflow: "CI", conclusion: "failure" })).toBe(
          true,
        );
        expect(runsFor({ event: "workflow_run", workflow: "Beta" })).toBe(true);
        expect(runsFor({ event: "schedule" })).toBe(true);
        expect(runsFor({ event: "workflow_dispatch" })).toBe(true);
        expect(runsFor({ event: "workflow_dispatch", inputs: { windows_run: "70" } })).toBe(true);
        expect(runsFor({ event: "workflow_run", workflow: "CI", runEvent: "pull_request" })).toBe(
          false,
        );
        expect(runsFor({ event: "workflow_run", workflow: "CI", fork: true })).toBe(false);
        expect(runsFor({ event: "workflow_run", workflow: "Beta", conclusion: "skipped" })).toBe(
          false,
        );
        const reconcileStep = job.steps.find(
          (step) => step.run === "bun scripts/ci/main-health.ts",
        )!;
        const { workflow: beta } = yield* workflowFile("beta.yml");
        expect(reconcileStep.env!["BETA_EVENTS"]!.split(" ")).toEqual(Object.keys(beta.on));
        expect(reconcileStep.if).toBeUndefined();
        const { WORKFLOW: _w, BRANCH: _b, EVENT: _e, ...env } = mainHealthEnv;
        expect(reconcileStep.env).toEqual({ GH_TOKEN: "${{ github.token }}", ...env });
        const waits = job.steps.filter((step) => JSON.stringify(step).includes("inputs."));
        expect(waits.map((step) => step.name)).toEqual([
          "Wait for the Windows check that started this run to end",
        ]);
        expect(job.steps.indexOf(waits[0]!)).toBe(0);
        expect(admits(waits[0]!.if, mainHealthContext({ event: "workflow_dispatch" }))).toBe(false);
        expect(admits(waits[0]!.if, mainHealthContext({ event: "schedule" }))).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "the Windows check's last job dispatches Main health on main with actions: write alone, however the check ended",
    () =>
      Effect.gen(function* () {
        const { workflow } = yield* workflowFile("release-artifacts.yml");
        const job = workflow.jobs["main-health"]!;
        const others = Object.keys(workflow.jobs).filter((id) => id !== "main-health");
        expect([...(job.needs as ReadonlyArray<string>)].sort()).toEqual([...others].sort());
        for (const id of others)
          expect([workflow.jobs[id]!.needs ?? []].flat(), id).not.toContain("main-health");
        expect(job.permissions).toEqual({ actions: "write" });
        expect(job["continue-on-error"]).toBe(true);
        expect(job["timeout-minutes"]).toBe(5);
        expect(job.steps).toHaveLength(1);
        const step = job.steps[0]!;
        expect(step.uses).toBeUndefined();
        expect(step.if).toBeUndefined();
        expect(step.env).toEqual({ PUBLISHES: "no", GH_TOKEN: "${{ github.token }}" });
        const context = (event: string, ref: string) => ({
          github: { event_name: event, ref, repository },
        });
        const windows = context("workflow_dispatch", "refs/heads/ci/windows-check");
        for (const status of [
          { cancelled: false, failed: false },
          { cancelled: false, failed: true },
          { cancelled: true, failed: true },
        ])
          expect(admits(job.if, windows, status), JSON.stringify(status)).toBe(true);
        expect(admits(job.if, context("repository_dispatch", "refs/heads/main"))).toBe(false);
        expect(admits(job.if, context("workflow_dispatch", "refs/heads/main"))).toBe(false);
        expect(admits(job.if, context("workflow_dispatch", "refs/heads/some-branch"))).toBe(false);
        const { workflow: health } = yield* workflowFile("main-health.yml");
        expect(health.on["workflow_dispatch"]).toHaveProperty("inputs.windows_run");
        expect(step.run).toContain(
          'gh workflow run main-health.yml -R "$GITHUB_REPOSITORY" --ref main -f windows_run="$GITHUB_RUN_ID"',
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "every workflow is one valid YAML document, a mis-indented or duplicated key is refused, and the lines that decide who runs Main health are these (review 3, 5)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const files = (yield* fs.readDirectory(".github/workflows"))
          .filter((name) => name.endsWith(".yml"))
          .map((name) => `.github/workflows/${name}`);
        const all = yield* workflowYaml(files);
        if (!all.ok) expect.fail(all.problems);
        expect(Object.keys(all.workflows).sort()).toEqual([...files].sort());
        const artifacts = all.workflows[".github/workflows/release-artifacts.yml"]!;
        expect(artifacts.jobs["local-macos-arm64"]!.steps).toEqual(artifacts.jobs["local"]!.steps);
        expect(artifacts.jobs["local"]!.steps.length).toBeGreaterThan(3);
        const runtime = all.workflows[".github/workflows/bun-runtime.yml"] as unknown as {
          readonly jobs: Readonly<
            Record<
              string,
              {
                readonly strategy?: {
                  readonly matrix?: {
                    readonly include?: ReadonlyArray<Readonly<Record<string, string>>>;
                  };
                };
              }
            >
          >;
        };
        expect(
          Object.values(runtime.jobs).flatMap((job) => job.strategy?.matrix?.include ?? []),
        ).toContainEqual(
          expect.objectContaining({ target: "linux-x64", os: "linux", arch: "x64" }),
        );

        const { text } = yield* workflowFile("main-health.yml");
        const line = '          if [[ ! "$WINDOWS_RUN" =~ ^[0-9]+$ ]]; then\n';
        expect(text).toContain(line);
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-workflow-yaml-" });
        for (const [what, broken] of [
          ["mis-indented block", text.replace(line, `  ${line}`)],
          [
            "duplicated key",
            text.replace(
              "    timeout-minutes: 10\n",
              "    timeout-minutes: 10\n    timeout-minutes: 20\n",
            ),
          ],
          ["tab indentation", text.replace("    timeout-minutes: 10\n", "\ttimeout-minutes: 10\n")],
          ["two documents", `${text}---\nname: Other\n`],
        ] as const) {
          expect(broken, what).not.toBe(text);
          const file = path.join(directory, `${what.replaceAll(" ", "-")}.yml`);
          yield* fs.writeFileString(file, broken);
          const result = yield* workflowYaml([file]);
          expect(result.ok, what).toBe(false);
        }

        const comments = "(?:\\s*#.*\\n)*";
        for (const block of [
          [
            "on:",
            "  workflow_run:",
            "    workflows: [CI, Beta]",
            "    types: [completed]",
            "    branches: [main]",
            "  schedule:",
            '    - cron: "23 * * * *"',
            "  workflow_dispatch:",
            "    inputs:",
            "      windows_run:",
          ],
          ["permissions: {}", "", "jobs:", "  issue:"],
          [
            "    concurrency:",
            "      group: main-health",
            "      cancel-in-progress: false",
            "    permissions:",
            "      contents: read",
            "      actions: read",
            "      issues: write",
            "    steps:",
          ],
          ["          LABEL: main-health"],
        ])
          expect(text).toMatch(
            new RegExp(
              `^${block.map((each) => each.replace(/[[\]{}()*+?.\\^$|]/g, "\\$&")).join(`\\n${comments}`)}\\n`,
              "m",
            ),
          );
        const { text: release } = yield* workflowFile("release-artifacts.yml");
        expect(release).toMatch(
          new RegExp(
            [
              "^  main-health:",
              "    needs:",
              "[\\s\\S]*?",
              "    if: always\\(\\) && github\\.event_name == 'workflow_dispatch' && github\\.ref == 'refs/heads/ci/windows-check'",
              "    runs-on: blacksmith-2vcpu-ubuntu-2404",
              "    timeout-minutes: 5",
              "    continue-on-error: true",
              `${comments}    permissions:`,
              `${comments}      actions: write`,
              "    steps:",
            ]
              .join("\n")
              .replace("\n[\\s\\S]*?\n", "\n[\\s\\S]*?\n"),
            "m",
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("a dispatch that fails is a warning, and the job passes either way", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { workflow } = yield* workflowFile("release-artifacts.yml");
      const script = workflow.jobs["main-health"]!.steps[0]!.run!;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-main-health-dispatch-" });
      yield* fs.writeFileString(
        path.join(root, "gh"),
        '#!/bin/sh\necho "$*" >> "$FAKE/calls"\n[ -f "$FAKE/refuse" ] && { echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; }\nexit 0\n',
      );
      yield* fs.chmod(path.join(root, "gh"), 0o755);
      const dispatch = Effect.gen(function* () {
        yield* fs.remove(path.join(root, "calls"), { force: true });
        yield* fs.writeFileString(path.join(root, "summary.md"), "");
        const result = yield* run(root, "bash", ["-e", "-c", script], {
          PATH: `${root}:${process.env.PATH ?? ""}`,
          FAKE: root,
          GH_TOKEN: "fake-token",
          GITHUB_REPOSITORY: repository,
          GITHUB_RUN_ID: "4242",
          GITHUB_STEP_SUMMARY: path.join(root, "summary.md"),
        });
        return {
          ...result,
          calls: (yield* fs.readFileString(path.join(root, "calls"))).trim(),
          summary: yield* fs.readFileString(path.join(root, "summary.md")),
        };
      });
      const sent = yield* dispatch;
      expect(sent.exitCode, sent.output).toBe(0);
      expect(sent.calls).toBe(
        `workflow run main-health.yml -R ${repository} --ref main -f windows_run=4242`,
      );
      expect(sent.summary).toBe("Started Main health on main for run 4242.\n");
      yield* fs.writeFileString(path.join(root, "refuse"), "");
      const refused = yield* dispatch;
      expect(refused.exitCode, refused.output).toBe(0);
      expect(refused.calls).toBe(sent.calls);
      expect(refused.output).toContain(
        "::warning::Main health could not be started, so this Windows check reaches the red-main issue at Main health's next run: the next CI or Beta completion on main, or a schedule tick GitHub delivers.",
      );
      expect(refused.summary).not.toContain("Started");
    }).pipe(Effect.scoped),
  );
});

type World = Effect.Success<typeof world>;
type History = Parameters<World["decide"]>[0];

interface Outcome {
  readonly exit: number;
  readonly decision: string;
  readonly run: string;
  readonly held: string;
  readonly failed?: number;
  readonly inspects?: string;
}

interface Row {
  readonly history: string;
  readonly setup: (
    world: World,
  ) => Effect.Effect<History, unknown, ChildProcessSpawner.ChildProcessSpawner>;
  readonly main: Outcome;
  readonly patched?: Outcome;
}

const step = (name: string, conclusion: string) => ({ name, conclusion });
const checkout = "Run actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const appToken = "Run actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";
const download = "Run actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093";
const refusedSteps = [
  step("Set up job", "success"),
  step("Set up runner", "success"),
  step(checkout, "success"),
  step("Run ./.github/actions/setup", "success"),
  step("Refuse to publish over a newer release", "success"),
  step(download, "success"),
  step(download, "success"),
  step(download, "success"),
  step("Check the downloaded release notes", "success"),
  step(appToken, "success"),
  step("Export source and create or resume the public draft release", "failure"),
  step("Run bun run release:wrapper .local/publish", "skipped"),
  step("Refuse a version npm holds with another archive", "skipped"),
  step(appToken, "skipped"),
  step("Collect the public assets and their SHA256SUMS", "skipped"),
  step("Upload installers, native archives and bundled Git source", "skipped"),
  step("Publish the tested Docker manifest and channel", "skipped"),
  step("Make the release public without changing v1 latest during beta", "skipped"),
  step("Publish the npm launcher", "skipped"),
  step("Verify a clean public npm installation", "skipped"),
  step(appToken, "skipped"),
  step("Point the Homebrew formula at this release", "skipped"),
  step("Point the desktop update channel at this release", "skipped"),
  step("Report what was and was not published", "success"),
  step(`Post ${appToken}`, "success"),
  step("Post Run ./.github/actions/setup", "success"),
  step(`Post ${checkout}`, "success"),
  step("Complete runner", "success"),
  step("Complete job", "success"),
];
const changed = (changes: Readonly<Record<string, string>>) =>
  refusedSteps.map((each) => ({ ...each, conclusion: changes[each.name] ?? each.conclusion }));

const refused = (id: number, hoursAgo: number, headSha: string): ReleaseRun => ({
  id,
  hoursAgo,
  headSha,
  publish: "failure",
  publishSteps: refusedSteps,
});
const failure = (id: number, hoursAgo: number, headSha: string): ReleaseRun => ({
  id,
  hoursAgo,
  headSha,
});
const publishFailure = (id: number, hoursAgo: number, headSha: string): ReleaseRun => ({
  id,
  hoursAgo,
  headSha,
  publish: "failure",
});
const builds = (count: number, from: number, headSha: string): ReadonlyArray<ReleaseRun> =>
  Array.from({ length: count }, (_, index) => ({
    id: 300 + index,
    channel: "build",
    conclusion: "success",
    hoursAgo: from + index * 0.01,
    headSha,
  }));

const holds = (failed?: number): Outcome => ({
  exit: 0,
  decision: "none",
  run: "",
  held: failed === undefined ? "" : "held",
  ...(failed === undefined ? {} : { failed }),
});
const waits: Outcome = { exit: 0, decision: "none", run: "", held: "" };
const rerun = (run: number, failed?: number): Outcome => ({
  exit: 0,
  decision: "rerun",
  run: String(run),
  held: "",
  ...(failed === undefined ? {} : { failed }),
});
const inspects = (run: number, held = ""): Outcome => ({
  exit: 0,
  decision: "none",
  run: "",
  held,
  inspects: String(run),
});

const day = (
  at: string,
  options: {
    readonly event?: History["event"];
    readonly appsPublished?: boolean;
    readonly matrixRed?: boolean;
    readonly reRunAt?: readonly [string, string];
  } = {},
) =>
  Effect.fnUntraced(function* (w: World) {
    const c75 = yield* w.onVersion("2.0.0-beta.75", "2026-11-25T14:55:44Z");
    const c76 = yield* w.onVersion("2.0.0-beta.76", "2026-11-25T18:24:47Z");
    const c77 = yield* w.onVersion("2.0.0-beta.77", "2026-11-25T19:51:40Z");
    const c78 = yield* w.onVersion("2.0.0-beta.78", "2026-11-25T20:19:22Z");
    const c79 = yield* w.onVersion("2.0.0-beta.79", "2026-11-25T21:39:20Z");
    yield* w.onVersion("2.0.0-beta.80", "2026-11-26T05:28:33Z");
    const h = (time: string) => (Date.parse(at) - Date.parse(time)) / hour;
    const record = (
      id: number,
      headSha: string,
      conclusion: "success" | "failure",
      created: string,
      attempts: ReadonlyArray<readonly [string, string]>,
    ): ReleaseRun => ({
      id,
      headSha,
      conclusion,
      publish: conclusion,
      hoursAgo: h(created),
      attempt: attempts.length,
      startedHoursAgo: h(attempts.at(-1)![0]),
      attemptsStartedHoursAgo: attempts.map(([started]) => h(started)),
      attemptsHoursAgo: attempts.map(([, updated]) => h(updated)),
    });
    const incident: ReadonlyArray<readonly [string, string]> = [
      ["2026-11-26T05:28:36Z", "2026-11-26T05:46:18Z"],
      ...(options.reRunAt === undefined ? [] : [options.reRunAt]),
    ];
    return {
      at,
      event: options.event ?? "schedule",
      appsPublished: options.appsPublished ?? true,
      betaTag: "2.0.0-beta.79",
      npmTimes: {
        "2.0.0-beta.75": h("2026-11-25T16:56:16.998Z"),
        "2.0.0-beta.76": h("2026-11-25T19:46:13.877Z"),
        "2.0.0-beta.77": h("2026-11-25T20:13:31.834Z"),
        "2.0.0-beta.78": h("2026-11-25T20:41:57.701Z"),
        "2.0.0-beta.79": h("2026-11-25T23:05:31.322Z"),
      },
      matrix: [
        {
          id: 900,
          conclusion: options.matrixRed === true ? "failure" : "success",
          hoursAgo: 0.05,
          headSha: c79,
        },
      ],
      runs: [
        {
          ...record(45761840264, c79, "failure", "2026-11-26T05:28:36Z", incident),
          publishSteps: refusedSteps,
        },
        record(45715842446, c79, "success", "2026-11-25T22:44:57Z", [
          ["2026-11-25T22:44:57Z", "2026-11-25T23:06:18Z"],
        ]),
        record(45706328710, c79, "failure", "2026-11-25T21:39:23Z", [
          ["2026-11-25T21:39:23Z", "2026-11-25T21:58:04Z"],
          ["2026-11-25T21:58:25Z", "2026-11-25T22:09:22Z"],
        ]),
        record(45693835617, c78, "success", "2026-11-25T20:19:25Z", [
          ["2026-11-25T20:19:25Z", "2026-11-25T20:42:38Z"],
        ]),
        record(45689330241, c77, "success", "2026-11-25T19:51:43Z", [
          ["2026-11-25T19:51:43Z", "2026-11-25T20:14:17Z"],
        ]),
        record(45684701202, c76, "success", "2026-11-25T19:23:21Z", [
          ["2026-11-25T19:23:21Z", "2026-11-25T19:47:03Z"],
        ]),
        record(45681019003, c76, "failure", "2026-11-25T19:01:24Z", [
          ["2026-11-25T19:01:24Z", "2026-11-25T19:22:41Z"],
        ]),
        record(45674895192, c76, "failure", "2026-11-25T18:24:50Z", [
          ["2026-11-25T18:24:50Z", "2026-11-25T18:47:03Z"],
        ]),
        record(45639436964, c75, "success", "2026-11-25T14:55:48Z", [
          ["2026-11-25T14:55:48Z", "2026-11-25T15:13:39Z"],
          ["2026-11-25T16:47:34Z", "2026-11-25T16:57:06Z"],
        ]),
      ],
    } satisfies History;
  });

const synthetic = (
  runs: (w: World, older: string) => ReadonlyArray<ReleaseRun>,
  extra: Omit<History, "runs"> = {},
) =>
  Effect.fnUntraced(function* (w: World) {
    const older = yield* w.atVersion("2.0.0-beta.4");
    return { ...extra, runs: runs(w, older) } satisfies History;
  });

const differential: ReadonlyArray<Row> = [
  {
    history: "beta.80's day at 10:01:35Z: six failures counted",
    setup: day("2026-11-26T10:01:35Z"),
    main: holds(6),
  },
  {
    history: "beta.80's day at 15:13:38Z, a second before 45639436964's first attempt ages out",
    setup: day("2026-11-26T15:13:38Z"),
    main: holds(5),
  },
  {
    history: "beta.80's day at 15:13:39Z, when 45639436964's first attempt ages out",
    setup: day("2026-11-26T15:13:39Z"),
    main: holds(5),
  },
  {
    history: "beta.80's day at 18:47:02Z, a second before 45674895192 ages out",
    setup: day("2026-11-26T18:47:02Z"),
    main: holds(5),
  },
  {
    history: "beta.80's day at 18:47:03Z, when 45674895192 ages out",
    setup: day("2026-11-26T18:47:03Z"),
    main: rerun(45761840264),
    patched: inspects(45761840264, "held"),
  },
  {
    history: "beta.80's day at 18:55Z",
    setup: day("2026-11-26T18:55:00Z"),
    main: rerun(45761840264),
    patched: inspects(45761840264, "held"),
  },
  {
    history: "beta.80's day at 18:55Z, Beta dispatched by hand",
    setup: day("2026-11-26T18:55:00Z", { event: "workflow_dispatch" }),
    main: rerun(45761840264),
    patched: inspects(45761840264, "held"),
  },
  {
    history: "beta.80's day at 18:55Z, a push tick",
    setup: day("2026-11-26T18:55:00Z", { event: "push" }),
    main: rerun(45761840264),
    patched: inspects(45761840264, "held"),
  },
  {
    history: "beta.80's day at 18:55Z, the apps release not on npm",
    setup: day("2026-11-26T18:55:00Z", { appsPublished: false }),
    main: rerun(45761840264),
    patched: inspects(45761840264, "held"),
  },
  {
    history: "beta.80's day at 18:55Z, the newest release matrix red",
    setup: day("2026-11-26T18:55:00Z", { matrixRed: true }),
    main: rerun(45761840264),
    patched: inspects(45761840264, "held"),
  },
  {
    history: "beta.80's day at 18:55Z, after main re-ran 45761840264 once at 18:47:30Z",
    setup: day("2026-11-26T18:55:00Z", {
      reRunAt: ["2026-11-26T18:47:30Z", "2026-11-26T18:50:00Z"],
    }),
    main: holds(5),
  },
  {
    history: "a refused run on beta.4's commit, alone",
    setup: synthetic((_, older) => [refused(70, 1, older)]),
    main: rerun(70),
    patched: inspects(70),
  },
  {
    history: "a refused run on beta.4's commit, alone, Beta dispatched by hand",
    setup: synthetic((_, older) => [refused(70, 1, older)], { event: "workflow_dispatch" }),
    main: rerun(70),
    patched: inspects(70),
  },
  {
    history: "three failures of beta.5 before publishing, then a refused run",
    setup: synthetic(({ released }, older) => [
      refused(70, 0.5, older),
      failure(71, 1, released),
      failure(72, 2, released),
      failure(73, 3, released),
    ]),
    main: rerun(70),
    patched: inspects(70),
  },
  {
    history: "four failures of beta.5, then a refused run",
    setup: synthetic(({ released }, older) => [
      refused(70, 0.5, older),
      failure(71, 1, released),
      failure(72, 2, released),
      failure(73, 3, released),
      failure(74, 4, released),
    ]),
    main: holds(5),
  },
  {
    history: "a publish failure of beta.5 on its first attempt, then a refused run",
    setup: synthetic(({ released }, older) => [
      refused(70, 0.5, older),
      publishFailure(71, 1, released),
    ]),
    main: rerun(70),
    patched: inspects(70),
  },
  {
    history: "a publish failure of beta.5 on its second attempt, then a refused run",
    setup: synthetic(({ released }, older) => [
      refused(70, 0.5, older),
      { ...publishFailure(71, 2, released), attempt: 2, attemptsHoursAgo: [1.5, 1] },
    ]),
    main: rerun(70),
    patched: inspects(70),
  },
  {
    history: "a successful beta.5 run that npm does not list, then a refused run",
    setup: synthetic(({ released }, older) => [
      refused(70, 0.5, older),
      { id: 71, conclusion: "success", publish: "success", hoursAgo: 1, headSha: released },
    ]),
    main: rerun(70),
    patched: inspects(70),
  },
  {
    history: "two refused runs",
    setup: synthetic((_, older) => [refused(70, 0.5, older), refused(71, 1, older)]),
    main: rerun(70),
    patched: inspects(70),
  },
  {
    history: "a refused run, then an older version that never reached npm failed its publish job",
    setup: Effect.fnUntraced(function* (w: World) {
      const older = yield* w.atVersion("2.0.0-beta.4");
      const unpublished = yield* w.atVersion("2.0.0-beta.3");
      return {
        runs: [refused(70, 0.5, older), publishFailure(72, 1, unpublished)],
      } satisfies History;
    }),
    main: rerun(70),
    patched: inspects(70),
  },
  {
    history: "a refused run, 29 build runs, then a beta.5 publish failure",
    setup: synthetic(({ released }, older) => [
      refused(70, 0.05, older),
      ...builds(29, 0.1, released),
      publishFailure(91, 1, released),
    ]),
    main: rerun(70),
    patched: inspects(70),
  },
  {
    history: "a refused run on beta.4's commit, on its second attempt",
    setup: synthetic((_, older) => [
      { ...refused(70, 2, older), attempt: 2, attemptsHoursAgo: [1.5, 1] },
    ]),
    main: waits,
  },
  {
    history: "a refused run on beta.5's own commit",
    setup: synthetic(({ released }) => [refused(70, 1, released)]),
    main: rerun(70),
  },
  {
    history: "a refused run on beta.4's commit, beta.4 reaching npm after the run was created",
    setup: synthetic((_, older) => [refused(70, 1, older)], {
      npmTimes: { "2.0.0-beta.4": 0.5 },
    }),
    main: rerun(70),
  },
  {
    history: "a refused run on beta.4's commit, beta.4 reaching npm as the run was created",
    setup: synthetic((_, older) => [refused(70, 1, older)], {
      npmTimes: { "2.0.0-beta.4": 1 },
    }),
    main: rerun(70),
  },
  {
    history: "a refused run on beta.4's commit, beta.4 not on npm",
    setup: synthetic((_, older) => [refused(70, 1, older)], { npmTimes: {} }),
    main: rerun(70),
  },
  {
    history: "a cancelled run on beta.4's commit whose publish job failed at the refusal",
    setup: synthetic((_, older) => [{ ...refused(70, 1, older), conclusion: "cancelled" }]),
    main: rerun(70),
  },
  {
    history: "a refused run on beta.4's commit whose publish job was cancelled",
    setup: synthetic((_, older) => [{ ...refused(70, 1, older), publish: "cancelled" }]),
    main: rerun(70),
  },
  {
    history: "a refused run on beta.4's commit with a second publish job",
    setup: synthetic((_, older) => [
      {
        ...refused(70, 1, older),
        failedJobs: [
          { name: "publish", step: "Export source and create or resume the public draft release" },
        ],
      },
    ]),
    main: rerun(70),
  },
  {
    history: "a run on beta.4's commit whose draft step was cancelled",
    setup: synthetic((_, older) => [
      {
        ...refused(70, 1, older),
        publishSteps: changed({
          "Export source and create or resume the public draft release": "cancelled",
        }),
      },
    ]),
    main: rerun(70),
  },
  {
    history: "a run on beta.4's commit that failed publishing the npm launcher",
    setup: synthetic((_, older) => [
      {
        ...refused(70, 1, older),
        publishSteps: changed({
          "Export source and create or resume the public draft release": "success",
          "Run bun run release:wrapper .local/publish": "success",
          "Refuse a version npm holds with another archive": "success",
          "Publish the npm launcher": "failure",
        }),
      },
    ]),
    main: rerun(70),
  },
  {
    history: "a refused run on beta.4's commit whose upload step ran after the refusal",
    setup: synthetic((_, older) => [
      {
        ...refused(70, 1, older),
        publishSteps: changed({
          "Upload installers, native archives and bundled Git source": "success",
        }),
      },
    ]),
    main: rerun(70),
  },
  {
    history: "a refused run on beta.4's commit whose closing runner step failed",
    setup: synthetic((_, older) => [
      {
        ...refused(70, 1, older),
        publishSteps: changed({ "Complete job": "failure" }),
      },
    ]),
    main: rerun(70),
  },
  {
    history: "a refused run on beta.4's commit whose step before the refusal did not succeed",
    setup: synthetic((_, older) => [
      {
        ...refused(70, 1, older),
        publishSteps: changed({ "Check the downloaded release notes": "skipped" }),
      },
    ]),
    main: rerun(70),
  },
  {
    history: "a refused run on beta.4's commit with a publishing failure in another job",
    setup: synthetic((_, older) => [
      {
        ...refused(70, 1, older),
        failedJobs: [
          {
            name: "deploy-published",
            step: "Deploy main again once npm names this release, so the docs name it",
          },
        ],
      },
    ]),
    main: rerun(70),
  },
  {
    history: "a publish failure on beta.4's commit whose steps are not listed",
    setup: synthetic((_, older) => [publishFailure(70, 1, older)]),
    main: rerun(70),
  },
  {
    history: "a refused run whose commit cannot be read",
    setup: synthetic(() => [refused(70, 0.5, "0123456789abcdef0123456789abcdef01234567")]),
    main: rerun(70),
  },
  {
    history: "a refused run whose manifest lookup exits non-zero after printing beta.4's manifest",
    setup: synthetic((_, older) => [refused(70, 1, older)], {
      git: `[ "$1" = show ] && { printf '{"version":"2.0.0-beta.4"}\\n'; echo "fatal: stub" >&2; exit 128; }`,
    }),
    main: rerun(70),
  },
  {
    history:
      "a refused run on beta.4's commit whose hold age cannot read the release commit's date",
    setup: synthetic((_, older) => [refused(70, 1, older)], {
      git: `case "$*" in "log -1 --format=%cI "*) echo "fatal: stub" >&2; exit 128 ;; esac`,
    }),
    main: rerun(70),
  },
  {
    history: "a refused run on beta.4's commit whose hold age cannot find the release commit",
    setup: synthetic((_, older) => [refused(70, 1, older)], {
      git: `case "$*" in "log -1 --format=%H "*) echo "fatal: stub" >&2; exit 128 ;; esac`,
    }),
    main: rerun(70),
  },
  {
    history: "a refused run whose commit's apps/cli/package.json is not JSON",
    setup: Effect.fnUntraced(function* (w: World) {
      const broken = yield* w.aside(
        { "apps/cli/package.json": "not json\n" },
        "Break the manifest",
      );
      return { runs: [refused(70, 1, broken)] } satisfies History;
    }),
    main: rerun(70),
  },
  {
    history: "an older version that never reached npm failed its publish job",
    setup: Effect.fnUntraced(function* (w: World) {
      const unpublished = yield* w.atVersion("2.0.0-beta.3");
      return { npmTimes: {}, runs: [publishFailure(72, 1, unpublished)] } satisfies History;
    }),
    main: rerun(72),
  },
  {
    history: "two recent failures before publishing on an older version, inside the back-off",
    setup: synthetic((_, older) => [failure(82, 1, older), failure(83, 2, older)]),
    main: waits,
  },
  {
    history: "a release run in progress",
    setup: synthetic(({ released }) => [
      { id: 95, status: "in_progress", hoursAgo: 0.1, headSha: released },
    ]),
    main: waits,
  },
  {
    history: "beta.5 on npm for seven hours with a commit after it",
    setup: Effect.fnUntraced(function* (w: World) {
      yield* w.merge;
      return { published: 7 } satisfies History;
    }),
    main: { exit: 0, decision: "bump", run: "", held: "clear" },
  },
];

const outcome = (result: {
  readonly exitCode: number;
  readonly outputs: Readonly<Record<string, string>>;
}): Outcome => {
  const reason = result.outputs["reason"] ?? "";
  const counted = /at least (\d+) publishing attempts failed|(\d+) of 5 attempts today failed/.exec(
    reason,
  );
  const inspected = /^Not re-running \S+\/runs\/(\d+) /.exec(reason);
  return {
    exit: result.exitCode,
    decision: result.outputs["decision"] ?? "",
    run: result.outputs["run"] ?? "",
    held: result.outputs["held"] ?? "",
    ...(counted === null ? {} : { failed: Number(counted[1] ?? counted[2]) }),
    ...(inspected === null ? {} : { inspects: inspected[1] }),
  };
};

layer(NodeServices.layer, { excludeTestServices: true })(
  "Beta decides as main's beta-due.ts at c35ac66114 did, except that it holds a refused run that built a published version instead of re-running it",
  (it) => {
    for (const row of differential)
      it.effect(row.history, () =>
        Effect.gen(function* () {
          const w = yield* world;
          const result = yield* w.decide(yield* row.setup(w));
          expect(outcome(result), result.output).toEqual(row.patched ?? row.main);
          if (row.patched !== undefined) {
            expect(row.main.decision).toBe("rerun");
            expect(row.patched).toEqual(inspects(Number(row.main.run), row.patched.held));
          }
        }).pipe(Effect.scoped),
      );

    it.effect(
      "a manifest lookup that stalls is given up at its limit and stopped, and the run is re-run as main does",
      () =>
        Effect.gen(function* () {
          const w = yield* world;
          const history = yield* synthetic((_, older) => [refused(70, 1, older)], {
            stall: true,
            git: `[ "$1" = show ] && { echo $$ > "$BETA_DUE_STALLED"; exec sleep 300; }`,
          })(w);
          const result = yield* w.decide(history);
          expect(outcome(result), result.output).toEqual(rerun(70));
          expect(result.outputs["reason"]).toContain("re-running its failed jobs");
          expect(result.lookup?.pid).toMatch(/^\d+$/);
          expect(result.lookup?.running).toBe(false);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "at 18:55Z on beta.80's day the hold names the run, its commit and both versions",
      () =>
        Effect.gen(function* () {
          const w = yield* world;
          const history = yield* day("2026-11-26T18:55:00Z")(w);
          const result = yield* w.decide(history);
          const incident = history.runs.find((each) => each.id === 45761840264)!;
          expect(result.output).toContain("::warning::Not re-running");
          expect(result.outputs["reason"]).toBe(
            `Not re-running https://github.com/${repository}/actions/runs/45761840264 (commit ${incident.headSha}): it built executor@2.0.0-beta.79, which was already on npm when the run was created, and failed at "Export source and create or resume the public draft release", so re-running it cannot publish executor@2.0.0-beta.80. Inspect it; if it is a dispatch that started before the version bump reached main, publish executor@2.0.0-beta.80 by dispatching Executor releases from main with channel beta by hand (RELEASING.md, "Publish beta").`,
          );
        }).pipe(Effect.scoped),
    );
  },
);
