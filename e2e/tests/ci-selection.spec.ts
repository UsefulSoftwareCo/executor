/**
 * The select job turns a pull request's `e2e` block into each E2E job's `--test-name` pattern.
 * These cases run `node e2e/ci-selection.ts` as a process with the environment the job gives it,
 * and read the outputs file and step summary it writes, as GitHub Actions does. A stub `gh` first
 * on its PATH answers the job's reads of the pull request.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { releaseSuiteConfigs } from "../release-lanes.ts";
import { closureOf } from "../save-path.ts";
import { scenarios } from "../test-plan.ts";

const jobs = [
  "local",
  "self-host",
  "self-host-inventory",
  "self-host-catalog",
  "cloud",
  "cloud-product",
  "cloud-domains",
  "cloud-workers",
  "cloud-locks",
  "cloud-removal-recovery",
  "cloud-batch",
  "cloud-export-hang",
  "cloud-autumn",
  "cloud-isolate",
  "cloud-telemetry-flush",
  "cloud-connections",
  "cloud-v1-bound",
  "cloud-rate-limit",
  "cloud-rollback",
  "cloud-oauth-proxy-preview",
];
/** The outputs that start the E2E runners: each sharded job's parts and the Cloud runners. */
const runnerOutputs = ["local-shards", "self-host-shards", "cloud-runners"];
/** The release lanes, which only a pull request runs (e2e/release-lanes.ts). */
const laneOutputs = ["release-docker", "release-local"];
const cloudJobs = jobs.filter((job) => job.startsWith("cloud"));

/** A sharded job's matrix entries: each part's name, such as 2/3, and its pattern. */
const shards = (outputs: Readonly<Record<string, string>>, job: string) =>
  JSON.parse(outputs[`${job}-shards`]!) as ReadonlyArray<{ shard: string; pattern: string }>;

/** The Cloud runners' matrix entries: a name and every Cloud job's pattern, empty when not its own. */
const cloudRunners = (outputs: Readonly<Record<string, string>>) =>
  outputs["cloud-runners"] === ""
    ? []
    : (JSON.parse(outputs["cloud-runners"]!) as ReadonlyArray<Readonly<Record<string, string>>>);

const block = (...lines: ReadonlyArray<string>) =>
  ["Description.", "", "```e2e", ...lines, "```", ""].join("\n");

/**
 * A `gh` that answers the select job's reads from files beside it: the description (`body.<n>`),
 * the open pull requests based on the branch (`above.<n>`), the changed files, the files changed
 * between the run's comparison ends (`compared`) and main's contents (`main/<path with / as _>`).
 * The nth read of a kind returns its nth answer, and the last answer once they run out, so a case
 * can edit the description while the job waits.
 */
const stubGh = `#!/bin/sh
dir=$(dirname "$0")
case "$*" in
  "pr list "*) kind=above ;;
  *"/compare/"*) exec jq -r "$4" "$dir/compared.json" ;;
  *"/files "*) cat "$dir/files"; exit ;;
  *"/contents/"*) exec cat "$dir/main/$(echo "$*" | sed 's|.*/contents/||; s|[?].*||' | tr / _)" ;;
  *) kind=body ;;
esac
read=$(cat "$dir/$kind.reads" 2>/dev/null || echo 0)
echo $((read + 1)) > "$dir/$kind.reads"
while [ ! -f "$dir/$kind.$read" ]; do read=$((read - 1)); done
cat "$dir/$kind.$read"
`;

/**
 * One select run: a pull request run when `body` is given, otherwise a push to main. A list of
 * bodies, or of `stackedAbove` answers, is what successive reads return. The job waits `wait`
 * seconds, none by default, for an incomplete description. It runs the checkout's selector unless
 * `root` names a fixture tree. `main` answers the reads of main's contents by repository path;
 * without it the job has no default branch and compares nothing with main. `compared` lists the
 * files changed since main or the previous main commit, none by default; `"unknown"` gives the job
 * no comparison, as on a manual run.
 */
const select = (input: {
  readonly body?: string | ReadonlyArray<string>;
  readonly changed?: ReadonlyArray<string>;
  readonly compared?: ReadonlyArray<string> | "unknown";
  /** Files the comparison lists as renamed, with the name each had before. */
  readonly renamed?: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly main?: Readonly<Record<string, string>>;
  readonly stackedAbove?: string | ReadonlyArray<string>;
  readonly wait?: number;
  readonly root?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-ci-selection-" });
    const output = path.join(directory, "output");
    const summary = path.join(directory, "summary");
    yield* fs.writeFileString(output, "");
    yield* fs.writeFileString(summary, "");
    const bin = path.join(directory, "bin");
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(path.join(bin, "gh"), stubGh);
    yield* fs.chmod(path.join(bin, "gh"), 0o755);
    const answers = (kind: string, values: string | ReadonlyArray<string>) =>
      Effect.forEach(
        typeof values === "string" ? [values] : values,
        (value, index) => fs.writeFileString(path.join(bin, `${kind}.${index}`), value),
        { discard: true },
      );
    yield* answers("body", input.body ?? "");
    yield* answers("above", input.stackedAbove ?? "");
    yield* fs.writeFileString(path.join(bin, "files"), (input.changed ?? []).join("\n"));
    const compared = input.compared ?? [];
    if (compared !== "unknown")
      yield* fs.writeFileString(
        path.join(bin, "compared.json"),
        JSON.stringify({
          files: [
            ...compared.map((filename) => ({ filename })),
            ...(input.renamed ?? []).map(({ from, to }) => ({
              filename: to,
              previous_filename: from,
            })),
          ],
        }),
      );
    yield* fs.makeDirectory(path.join(bin, "main"));
    for (const [file, text] of Object.entries(input.main ?? {}))
      yield* fs.writeFileString(path.join(bin, "main", file.replaceAll("/", "_")), text);
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["e2e/ci-selection.ts"], {
        cwd: input.root,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          E2E_PULL_REQUEST: input.body === undefined ? "" : "1",
          E2E_HEAD_REF: "layer",
          E2E_DEFAULT_BRANCH: input.main === undefined ? "" : "main",
          ...(compared === "unknown"
            ? {}
            : { E2E_COMPARE_BASE: "main", E2E_COMPARE_HEAD: "0123456789abcdef" }),
          E2E_DESCRIPTION_WAIT_SECONDS: String(input.wait ?? 0),
          E2E_DESCRIPTION_POLL_SECONDS: "0.05",
          GITHUB_REPOSITORY: "owner/repository",
          GITHUB_RUN_ID: "123456",
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
        extendEnv: true,
      }),
    );
    // The runtime logs a failure to stdout, so the cases read both streams together.
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    const outputs = Object.fromEntries(
      (yield* fs.readFileString(output))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return {
      exitCode,
      log,
      outputs,
      summary: yield* fs.readFileString(summary),
    };
  }).pipe(Effect.scoped);

/**
 * A temporary copy of what the selector reads, for a case that changes it: the top-level e2e/*.ts
 * files, an empty e2e/tests/, package.json and the workflows, with the checkout's node_modules
 * linked in. The selector resolves its imports and files from its own location, so it reads only
 * the copy, and the case writes `files` there. The checkout is never written, so a killed or
 * concurrent run leaves it unchanged. The tree is removed when the case's scope closes.
 */
const fixture = (files: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-ci-selection-root-" });
    yield* fs.makeDirectory(path.join(root, "e2e", "tests"), { recursive: true });
    for (const name of yield* fs.readDirectory("e2e"))
      if (name.endsWith(".ts"))
        yield* fs.copyFile(path.join("e2e", name), path.join(root, "e2e", name));
    yield* fs.copyFile("package.json", path.join(root, "package.json"));
    yield* fs.copy(path.join(".github", "workflows"), path.join(root, ".github", "workflows"));
    yield* fs.symlink(path.resolve("node_modules"), path.join(root, "node_modules"));
    // The selection reads the source a save runs (e2e/save-path.ts).
    for (const tree of ["apps", "packages", "playground"])
      yield* fs.symlink(path.resolve(tree), path.join(root, tree));
    for (const [file, text] of Object.entries(files))
      yield* fs.writeFileString(path.join(root, file), text);
    return root;
  });

/**
 * A saved run's report: each scenario on a target, with how it ended. `files` keeps only some spec
 * files, as one part of a sharded job saves.
 */
interface SavedRun {
  readonly target: "local" | "self-host" | "cloud";
  readonly status?: (title: string) => string;
  readonly files?: (file: string) => boolean;
}

/**
 * `node e2e/ci-selection.ts verify <suite>` over runs saved as the E2E jobs save them, each with
 * every scenario the plan schedules on its target. `status` says how one ended; passed by default.
 */
const verify = (suite: string, saved: ReadonlyArray<SavedRun>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-ci-coverage-" });
    for (const [index, run] of saved.entries()) {
      const files = new Map<string, Array<{ title: string; status: string }>>();
      for (const scenario of Object.values(scenarios))
        if (
          scenario.targets[run.target].status === "scheduled" &&
          (run.files?.(scenario.file) ?? true)
        )
          files.set(scenario.file, [
            ...(files.get(scenario.file) ?? []),
            { title: scenario.title, status: run.status?.(scenario.title) ?? "passed" },
          ]);
      const report = path.join(
        directory,
        `artifact-${index}`,
        `run-${index}`,
        run.target,
        "report",
        "diagnostics",
      );
      yield* fs.makeDirectory(report, { recursive: true });
      yield* fs.writeFileString(
        path.join(report, "results.json"),
        JSON.stringify({
          testResults: [...files].map(([file, assertionResults]) => ({
            name: `/runner/work/e2e/tests/${file}`,
            assertionResults,
          })),
        }),
      );
    }
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["e2e/ci-selection.ts", "verify", suite, directory], {
        env: { GITHUB_STEP_SUMMARY: "" },
        extendEnv: true,
      }),
    );
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { exitCode, log };
  }).pipe(Effect.scoped);

/**
 * A job of .github/workflows/checks.yml, read from its text: its `if`, its `needs` and its first
 * step's `run` script. The workflow is plain block YAML, so a job is the lines indented under it.
 */
const workflowJob = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lines = (yield* fs.readFileString(".github/workflows/checks.yml")).split("\n");
    const start = lines.indexOf(`  ${name}:`);
    expect(start, name).toBeGreaterThan(-1);
    const end = lines.findIndex((line, index) => index > start && /^ {0,2}\S/.test(line));
    const body = lines.slice(start + 1, end === -1 ? undefined : end);
    // A flow list too long for one line is written over several, from `[` to `]`.
    const field = (key: string) => {
      const at = body.findIndex(
        (line) => line === `    ${key}:` || line.startsWith(`    ${key}: `),
      );
      if (at === -1) return undefined;
      const inline = body[at]!.slice(`    ${key}:`.length).trim();
      if (inline !== "") return inline;
      const close = body.findIndex((line, index) => index > at && line.trim() === "]");
      return `[${body
        .slice(at + 2, close)
        .map((line) => line.trim().replace(/,$/, ""))
        .join(", ")}]`;
    };
    const run = body.findIndex((line) => line === "        run: |");
    const script = body
      .slice(run + 1)
      .filter((line, index, rest) => rest.slice(0, index + 1).every((l) => /^ {10}|^$/.test(l)))
      .map((line) => line.slice(10))
      .join("\n");
    return { if: field("if"), needs: field("needs"), script: run === -1 ? undefined : script };
  });

/** The select outputs that start each E2E job, as its `if` in checks.yml reads them. */
const startedBy = {
  "e2e-local": ["local-shards"],
  "e2e-self-host": ["self-host-shards"],
  "e2e-self-host-scale": ["self-host-inventory", "self-host-catalog"],
  "e2e-cloud": ["cloud-runners"],
  "release-docker": ["release-docker"],
  "release-local": ["release-local"],
} as const;
type E2eJob = keyof typeof startedBy;
const e2eJobs = Object.keys(startedBy) as ReadonlyArray<E2eJob>;

/** Whether select's outputs start an E2E job. */
const chosen = (outputs: Readonly<Record<string, string>>, job: E2eJob) =>
  startedBy[job].some((name) => (outputs[name] ?? "") !== "");

/**
 * The `e2e` check's script, run as its step runs it, with `needs` as GitHub gives it: each job's
 * result, and select's outputs. `results` says how each E2E job ended.
 */
const gate = (
  select: { readonly result: string; readonly outputs: Readonly<Record<string, string>> },
  results: Readonly<Record<E2eJob, string>>,
) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { script } = yield* workflowJob("e2e");
    expect(script).toBeDefined();
    const needs = {
      select,
      ...Object.fromEntries(e2eJobs.map((job) => [job, { result: results[job], outputs: {} }])),
    };
    const child = yield* processes.spawn(
      ChildProcess.make("bash", ["-e", "-c", script!], {
        env: { NEEDS: JSON.stringify(needs) },
        extendEnv: true,
      }),
    );
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { exitCode, log };
  }).pipe(Effect.scoped);

/** This suite's own config, rewritten only in a fixture tree. */
const ownConfig = "e2e/ci-selection.config.ts";

/** Files `fileGuards` in e2e/ci-selection.ts watches; main lists each in its directory. */
const guardedFiles = ["packages/sdk/src/implementation/app-protocols.ts"];
/**
 * Main's listings of the guarded files' directories, with each file's blob ID in this checkout
 * unless `changed` gives another.
 */
const guardedListings = (blobs: ReadonlyArray<string>, changed: Record<string, string> = {}) => {
  const listings: Record<string, string> = {};
  guardedFiles.forEach((file, index) => {
    const directory = file.slice(0, file.lastIndexOf("/"));
    listings[directory] = `${listings[directory] ?? ""}${changed[file] ?? blobs[index]} ${file}\n`;
  });
  return listings;
};

layer(NodeServices.layer)("CI E2E selection", (it) => {
  it.effect("a push to main runs every job's full pattern", () =>
    Effect.gen(function* () {
      const run = yield* select({});
      expect(run.exitCode).toBe(0);
      expect(Object.keys(run.outputs).sort()).toEqual(
        [...jobs, ...runnerOutputs, ...laneOutputs, "full"].sort(),
      );
      for (const job of [...jobs, ...runnerOutputs]) expect(run.outputs[job], job).not.toBe("");
      // Executor releases runs the whole release matrix on main after merge instead.
      for (const lane of laneOutputs) expect(run.outputs[lane], lane).toBe("");
      expect(run.outputs.full).toBe("true");
      expect(run.summary).toContain("Full suite: this run is not for a pull request.");
    }),
  );

  it.effect(
    "a full run splits local and self-host by spec file and spreads Cloud over four runners",
    () =>
      Effect.gen(function* () {
        const [main, all, named] = yield* Effect.all(
          [
            select({}),
            select({ body: block("all: changes the lockfile") }),
            select({
              body: block("groups.spec.ts", "cloud-onboarding.spec.ts", "auth-cleanup.spec.ts"),
            }),
          ],
          { concurrency: "unbounded" },
        );
        for (const run of [main, all]) {
          expect(run.exitCode, run.log).toBe(0);
          for (const [job, target, names] of [
            ["local", "local", ["1/3", "2/3", "3/3"]],
            ["self-host", "self-host", Array.from({ length: 12 }, (_, index) => `${index + 1}/12`)],
          ] as const) {
            const parts = shards(run.outputs, job);
            expect(parts.map(({ shard }) => shard)).toEqual(names);
            // The parts run every scenario the job's full pattern runs, each once, and keep each
            // spec file's scenarios together.
            const full = new RegExp(run.outputs[job]!);
            const partOf = new Map<string, number>();
            let count = 0;
            for (const scenario of Object.values(scenarios)) {
              if (scenario.targets[target].status !== "scheduled") continue;
              const matched = parts.flatMap(({ pattern }, index) =>
                new RegExp(pattern).test(scenario.title) ? [index] : [],
              );
              expect(matched.length, scenario.title).toBe(full.test(scenario.title) ? 1 : 0);
              if (matched.length === 0) continue;
              count++;
              expect(partOf.get(scenario.file) ?? matched[0], scenario.file).toBe(matched[0]);
              partOf.set(scenario.file, matched[0]!);
            }
            expect(run.summary).toContain(
              `| ${job} | ${count} | ${names.length}, split by spec file |`,
            );
          }
          const runners = cloudRunners(run.outputs);
          // A full run's cloud-product passes what one local Cloud holds.
          const productParts = Math.ceil(
            Number(/\| cloud-product \| (\d+) \|/.exec(run.summary)![1]) / 30,
          );
          expect(productParts).toBeGreaterThan(1);
          expect(runners.map(({ name }) => name)).toEqual([
            "cloud",
            "cloud-isolate, cloud-telemetry-flush, cloud-connections",
            ...Array.from(
              { length: productParts },
              (_, index) => `cloud-product ${index + 1}/${productParts}`,
            ),
            "cloud-workers, cloud-locks, cloud-batch, cloud-autumn",
            "cloud-domains, cloud-v1-bound, cloud-rate-limit, cloud-rollback, cloud-oauth-proxy-preview",
            "cloud-removal-recovery, cloud-export-hang",
          ]);
          // Each Cloud job's pattern is on exactly one runner and empty on the others. The runner
          // runs it unchanged, except cloud-product past what one local Cloud holds: each of its
          // local Clouds has a runner of its own, and together they run exactly the scenarios its
          // pattern does, each once, and keep each spec file's scenarios on one.
          for (const job of cloudJobs) {
            const on = runners.flatMap((runner) =>
              runner[job] === undefined || runner[job] === "" ? [] : [runner[job]],
            );
            if (on.length === 1 && on[0] === run.outputs[job]) continue;
            expect(job).toBe("cloud-product");
            const parts = on;
            const full = new RegExp(run.outputs[job]!);
            const partOf = new Map<string, number>();
            let count = 0;
            for (const scenario of Object.values(scenarios)) {
              const cloud = scenario.targets.cloud;
              if (cloud.status !== "scheduled") continue;
              if ("runtime" in cloud && cloud.runtime !== "managed") continue;
              const matched = parts.flatMap((pattern, index) =>
                new RegExp(pattern).test(scenario.title) ? [index] : [],
              );
              expect(matched.length, scenario.title).toBe(full.test(scenario.title) ? 1 : 0);
              if (matched.length === 0) continue;
              count++;
              expect(partOf.get(scenario.file) ?? matched[0], scenario.file).toBe(matched[0]);
              partOf.set(scenario.file, matched[0]!);
            }
            expect(count).toBeGreaterThan(30);
            expect(parts).toHaveLength(Math.ceil(count / 30));
          }
        }
        expect(main.summary).toMatch(
          /\| cloud-locks \| \d+ \| e2e-cloud \(cloud-workers, cloud-locks, cloud-batch, cloud-autumn\) \|/,
        );

        // A selection runs each job on one runner, and starts only the Cloud runners it needs.
        expect(named.exitCode, named.log).toBe(0);
        expect(shards(named.outputs, "self-host")).toEqual([
          { shard: "1/1", pattern: named.outputs["self-host"] },
        ]);
        const runners = cloudRunners(named.outputs);
        expect(runners.map(({ name }) => name)).toEqual(["cloud", "cloud-locks"]);
        expect(runners[0]!.cloud).toBe(named.outputs.cloud);
        expect(runners[1]!["cloud-locks"]).toBe(named.outputs["cloud-locks"]);
        for (const job of cloudJobs.filter((job) => job !== "cloud" && job !== "cloud-locks")) {
          expect(named.outputs[job], job).toBe("");
          for (const runner of runners) expect(runner[job], job).toBe("");
        }
      }),
  );

  it.effect("a named spec file selects its scenarios, with or without the e2e/tests/ prefix", () =>
    Effect.gen(function* () {
      const [bare, prefixed] = yield* Effect.all(
        [
          select({ body: block("groups.spec.ts") }),
          select({ body: block("e2e/tests/groups.spec.ts") }),
        ],
        { concurrency: "unbounded" },
      );
      expect(bare.exitCode).toBe(0);
      expect(bare.outputs["self-host"]).toMatch(/^\^\(\?:/);
      expect(bare.outputs.cloud).toBe("");
      expect(shards(bare.outputs, "self-host")).toEqual([
        { shard: "1/1", pattern: bare.outputs["self-host"] },
      ]);
      expect(bare.outputs["cloud-runners"]).toBe("");
      expect(prefixed.outputs).toEqual(bare.outputs);
    }),
  );

  it.effect("a name that is not a spec file in e2e/tests/ fails before any job is chosen", () =>
    Effect.gen(function* () {
      const names = [
        "./groups.spec.ts",
        "e2e/tests/./groups.spec.ts",
        "../tests/groups.spec.ts",
        "../../package.json",
        "../test-plan.ts",
        ".",
        "groups-renamed.spec.ts",
      ];
      const runs = yield* Effect.forEach(names, (name) => select({ body: block(name) }), {
        concurrency: 4,
      });
      for (const [index, run] of runs.entries()) {
        expect(run.exitCode, names[index]).toBe(1);
        expect(run.log, names[index]).toContain(`not spec files in e2e/tests/: "${names[index]}"`);
        expect(run.outputs, names[index]).toEqual({});
      }
    }),
  );

  it.effect("a spec file another config runs fails and names what runs it", () =>
    Effect.gen(function* () {
      const cases = [
        ["billing.spec.ts", "e2e/billing.config.ts: bun run e2e:billing. No workflow runs it."],
        [
          "docker-release.spec.ts",
          "e2e/docker-release.config.ts in Checks (.github/workflows/checks.yml) and Executor releases (.github/workflows/release-artifacts.yml)",
        ],
        // Planned, but its scenarios run only against the release archive.
        [
          "local-bootstrap.spec.ts",
          "e2e/local-bootstrap.config.ts in Checks (.github/workflows/checks.yml) and Executor releases (.github/workflows/release-artifacts.yml)",
        ],
        [
          "ci-selection.spec.ts",
          "e2e/ci-selection.config.ts in Checks (.github/workflows/checks.yml). Locally: bun run e2e:ci-selection.",
        ],
        ["claude-mcp.spec.ts", "these jobs exclude all of its scenarios"],
      ] as const;
      const runs = yield* Effect.forEach(
        cases,
        ([file]) => select({ body: block("groups.spec.ts", file) }),
        { concurrency: 4 },
      );
      for (const [index, run] of runs.entries()) {
        const [file, where] = cases[index]!;
        expect(run.exitCode, file).toBe(1);
        expect(run.log, file).toContain(`- ${file}`);
        expect(run.log, file).toContain(where);
        expect(run.log, file).toContain("Remove them from the e2e block.");
        expect(run.outputs, file).toEqual({});
      }
    }),
  );

  it.effect("changed spec files run when these jobs run them and are reported otherwise", () =>
    Effect.gen(function* () {
      // A rename lists the new name; the deleted name no longer exists and is ignored.
      const run = yield* select({
        body: block("none"),
        changed: [
          "e2e/tests/groups.spec.ts",
          "e2e/tests/billing.spec.ts",
          "e2e/tests/groups-before-rename.spec.ts",
          "README.md",
        ],
      });
      expect(run.exitCode).toBe(0);
      expect(run.outputs["self-host"]).toMatch(/^\^\(\?:/);
      expect(run.summary).toContain("Spec files: groups.spec.ts\n");
      expect(run.summary).toContain(
        "- billing.spec.ts runs only by hand, with e2e/billing.config.ts",
      );
    }),
  );

  it.effect("a changed scenario only deployed Cloud runs runs in cloud-product when it can", () =>
    Effect.gen(function* () {
      const [links, compiler, all] = yield* Effect.all(
        [
          select({ body: block("none"), changed: ["e2e/tests/deployment-links.spec.ts"] }),
          select({ body: block("none"), changed: ["e2e/tests/cloud-compiler.spec.ts"] }),
          select({
            body: block("all: changes the lockfile"),
            changed: ["e2e/tests/deployment-links.spec.ts"],
          }),
        ],
        { concurrency: "unbounded" },
      );
      expect(links.exitCode, links.log).toBe(0);
      expect(links.outputs["cloud-product"]).toBe(
        "^(?:Cloud product links follow the deployment origin)$",
      );
      expect(links.outputs.cloud).toBe("");
      expect(links.summary).toContain("Spec files: deployment-links.spec.ts\n");
      expect(links.summary).toContain(
        "- deployment-links.spec.ts: Cloud product links follow the deployment origin",
      );
      expect(links.summary).not.toContain("Changed spec files these jobs do not run");
      expect(links.log).not.toContain("::warning");

      // Three of its scenarios need a deployed stage, and one runs on no CI path at all.
      expect(compiler.exitCode, compiler.log).toBe(0);
      expect(compiler.outputs["cloud-product"]).toContain(
        "Cloud compiler installs imported packages",
      );
      // This one is in the cloud job's own pattern.
      expect(compiler.outputs.cloud).toContain("Cloud deploys fail promptly");
      for (const job of ["cloud", "cloud-product"]) {
        expect(compiler.outputs[job]).not.toContain("Concurrent Cloud deploys");
        expect(compiler.outputs[job]).not.toContain("Cloud catalog installs Axiom");
        expect(compiler.outputs[job]).not.toContain("memory failures");
      }
      for (const title of [
        "Cloud catalog installs Axiom through the browser and reaches account setup",
        "Concurrent Cloud deploys that install npm packages all compile",
        "Cloud builds keep large UI files out of the server bundle",
      ]) {
        expect(compiler.log).toContain(
          `::warning title=Runs only on deployed Cloud after merge::cloud-compiler.spec.ts: "${title}" changed`,
        );
        expect(compiler.summary).toContain(`- cloud-compiler.spec.ts: ${title}`);
      }
      expect(compiler.summary).toContain(
        "bun run e2e:deployed --test-name '^(?:Cloud catalog installs Axiom through the browser and reaches account setup|Concurrent Cloud deploys that install npm packages all compile|Cloud builds keep large UI files out of the server bundle)$'",
      );
      expect(compiler.log).not.toContain('"Cloud compiler memory failures');

      // The full suite keeps the job's own pattern and adds the changed scenario.
      expect(all.exitCode, all.log).toBe(0);
      expect(all.outputs["cloud-product"]).toMatch(
        /^Cloud SSO SAML accepts\|.*\|\^\(\?:Cloud product links follow the deployment origin\)\$$/,
      );
      expect(all.outputs.cloud).not.toContain("Cloud product links");
    }),
  );

  it.effect(
    "changed scenarios past what one local Cloud holds run in cloud-product on local Clouds of their own, split by spec file",
    () =>
      Effect.gen(function* () {
        // Each file's scenarios otherwise run only on deployed Cloud after merge.
        const files = [
          "app-ui.spec.ts",
          "workflows.spec.ts",
          "webhook-source-handover.spec.ts",
          "mcp-execute-failures.spec.ts",
          "hosted-app-accounts.spec.ts",
          "hosted-account-scheduling.spec.ts",
          "app-account-links.spec.ts",
          "pat-mcp.spec.ts",
          "hosted-schedule-browser.spec.ts",
          "mcp-connections.spec.ts",
          "mcp-server.spec.ts",
          "hosted-shared.spec.ts",
          "credential-hosts.spec.ts",
        ];
        const run = yield* select({
          body: block("none"),
          changed: files.map((file) => `e2e/tests/${file}`),
        });
        expect(run.exitCode, run.log).toBe(0);
        /** The titles an exact pattern of the selector's matches. */
        const titlesOf = (pattern: string) => {
          expect(pattern).toMatch(/^\^\(\?:.*\)\$$/);
          return pattern
            .slice(4, -2)
            .split(/(?<!\\)\|/)
            .map((title) => title.replace(/\\(.)/g, "$1"));
        };
        const selected = titlesOf(run.outputs["cloud-product"]!);
        // More than one local Cloud holds, so the case is not vacuous.
        expect(selected.length).toBeGreaterThan(30);
        const fileOf = new Map(Object.values(scenarios).map((s) => [s.title, s.file]));
        // Each local Cloud has a runner of its own.
        const runners = cloudRunners(run.outputs).filter((entry) => entry["cloud-product"] !== "");
        const parts = runners.map((entry) => titlesOf(entry["cloud-product"]!));
        expect(parts).toHaveLength(Math.ceil(selected.length / 30));
        expect(runners.map(({ name }) => name)).toEqual(
          parts.map((_, index) => `cloud-product ${index + 1}/${parts.length}`),
        );
        // Every selected scenario runs once, and a spec file's scenarios share one local Cloud.
        expect(parts.flat().sort()).toEqual([...selected].sort());
        const partOfFile = new Map<string, number>();
        parts.forEach((part, index) => {
          for (const title of part) {
            const file = fileOf.get(title)!;
            expect(partOfFile.get(file) ?? index, file).toBe(index);
            partOfFile.set(file, index);
          }
        });
        expect(run.summary).toContain(
          `| cloud-product | ${selected.length} | ${runners.map(({ name }) => `e2e-cloud (${name})`).join(", ")}: ${parts.length} local Clouds split by spec file |`,
        );
      }),
  );

  it.effect("naming a spec file only deployed Cloud runs says where it runs", () =>
    Effect.gen(function* () {
      const run = yield* select({ body: block("deployment-links.spec.ts") });
      expect(run.exitCode).toBe(1);
      expect(run.log).toContain(
        "- deployment-links.spec.ts: only Cloud tests on main runs its scenarios, on a deployed stage after merge.",
      );
    }),
  );

  it.effect("naming a changed spec file only deployed Cloud runs selects its scenarios", () =>
    Effect.gen(function* () {
      const [changed, other] = yield* Effect.all(
        [
          select({
            body: block("deployment-links.spec.ts"),
            changed: ["e2e/tests/deployment-links.spec.ts"],
          }),
          // Another changed deployed-only file does not let an unchanged one be named.
          select({
            body: block("deployment-links.spec.ts"),
            changed: ["e2e/tests/cloud-compiler.spec.ts"],
          }),
        ],
        { concurrency: "unbounded" },
      );
      expect(changed.exitCode, changed.log).toBe(0);
      expect(changed.outputs["cloud-product"]).toBe(
        "^(?:Cloud product links follow the deployment origin)$",
      );
      expect(changed.summary).toContain("Spec files: deployment-links.spec.ts\n");
      expect(other.exitCode).toBe(1);
      expect(other.log).toContain(
        "- deployment-links.spec.ts: only Cloud tests on main runs its scenarios, on a deployed stage after merge.",
      );
      expect(other.outputs).toEqual({});
    }),
  );

  it.effect("a scheduled scenario no CI job runs fails every run except a skipped layer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const deadline = "Cloud deploys fail promptly when the compiler does not answer";
      const renamed = "Cloud deploys stop when the compiler is silent";
      const root = yield* fixture({
        "e2e/test-plan.ts": (yield* fs.readFileString("e2e/test-plan.ts")).replace(
          `"${deadline}"`,
          `"${renamed}"`,
        ),
      });
      const [main, named, skip] = yield* Effect.all(
        [
          select({ root }),
          select({ body: block("groups.spec.ts"), root }),
          select({ body: block("skip"), stackedAbove: "123", root }),
        ],
        { concurrency: "unbounded" },
      );
      for (const run of [main, named]) {
        expect(run.exitCode, run.log).toBe(1);
        expect(run.log).toContain(
          `- scenarios.cloudCompilerDeadline (cloud-compiler.spec.ts) on cloud: "${renamed}" is scheduled, but no CI job runs it.`,
        );
        expect(run.log).toContain("add it to notRunInCi in e2e/ci-selection.ts with why");
        expect(run.outputs).toEqual({});
      }
      expect(skip.exitCode, skip.log).toBe(0);
      expect(skip.outputs).toEqual({ skip: "true" });
    }).pipe(Effect.scoped),
  );

  it.effect("an exception no longer needed fails until it is removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // The self-host job stops excluding the Claude Code scenario, which needs a model API key.
      const selection = (yield* fs.readFileString("e2e/ci-selection.ts")).replace(
        "pattern: `^(?!.*(?:${claude}|",
        "pattern: `^(?!.*(?:",
      );
      const root = yield* fixture({ "e2e/ci-selection.ts": selection });
      const run = yield* select({ root });
      expect(run.exitCode, run.log).toBe(1);
      expect(run.log).toContain(
        "- scenarios.mcp (claude-mcp.spec.ts) on self-host is in notRunInCi, but the self-host job runs it.",
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an effect version or patch that differs from main runs the session object timing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const names = yield* fs.readDirectory("patches");
        const hashed = (yield* processes.string(
          ChildProcess.make("git", [
            "hash-object",
            ...guardedFiles,
            ...names.map((name) => `patches/${name}`),
          ]),
        ))
          .trim()
          .split("\n");
        const guarded = hashed.slice(0, guardedFiles.length),
          blobs = hashed.slice(guardedFiles.length);
        // Main as this checkout, except for the blob ID it lists for effect's patch.
        const patches = names
          .map(
            (name, index) =>
              `${name.startsWith("effect@") ? "0".repeat(40) : blobs[index]} ${name}`,
          )
          .join("\n");
        const run = yield* select({
          body: block("none"),
          main: {
            "package.json": yield* fs.readFileString("package.json"),
            patches,
            ...guardedListings(guarded),
          },
        });
        expect(run.exitCode, run.log).toBe(0);
        expect(run.summary).not.toContain("A guarded file differs");
        expect(run.summary).toContain(
          "A dependency patch differs from main, so its guards run: mcp-telemetry-privacy.spec.ts, mcp-protocol-versions.spec.ts, cloud-mcp-session-timing.spec.ts",
        );
        expect(run.outputs["cloud-isolate"]).toContain("Cloud MCP session objects report");
      }),
  );

  it.effect(
    "a guarded file that differs from main runs its scenarios, whatever the block says",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const protocols = "packages/sdk/src/implementation/app-protocols.ts";
        const names = yield* fs.readDirectory("patches");
        // Git's own blob IDs for the working tree, as the contents API lists main's.
        const hashed = (yield* processes.string(
          ChildProcess.make("git", [
            "hash-object",
            ...guardedFiles,
            ...names.map((name) => `patches/${name}`),
          ]),
        ))
          .trim()
          .split("\n");
        const guarded = hashed.slice(0, guardedFiles.length),
          patchBlobs = hashed.slice(guardedFiles.length),
          current = guarded[0] ?? "";
        const patches = names.map((name, index) => `${patchBlobs[index]} ${name}`);
        const manifest = yield* fs.readFileString("package.json");
        // Main as this checkout, except for the blob ID it lists for the host's protocols.
        const main = (protocolsBlob: string) => ({
          "package.json": manifest,
          patches: patches.join("\n"),
          ...guardedListings(guarded, { [protocols]: protocolsBlob }),
        });
        const [same, changed] = yield* Effect.all(
          [
            select({ body: block("none"), main: main(current) }),
            select({ body: block("none"), main: main("0".repeat(40)) }),
          ],
          { concurrency: "unbounded" },
        );
        expect(same.exitCode, same.log).toBe(0);
        expect(same.summary).toContain("No E2E scenarios");
        expect(same.summary).not.toContain("guards run");
        expect(changed.exitCode, changed.log).toBe(0);
        expect(changed.summary).toContain(
          "Spec files: app-older-protocols.spec.ts, app-package.spec.ts\n",
        );
        expect(changed.summary).toContain(
          "A guarded file differs from main, so its guards run: app-package.spec.ts, app-older-protocols.spec.ts",
        );
        expect(changed.outputs["self-host"]).toContain(
          "App builds retain their selected npm framework across rebuilds",
        );
      }),
  );

  it.effect("a changed spec file that no plan or config includes fails", () =>
    Effect.gen(function* () {
      const name = "ci-selection-unregistered.spec.ts";
      const file = `e2e/tests/${name}`;
      const root = yield* fixture({ [file]: "" });
      const run = yield* select({ body: block("none"), changed: [file], root });
      expect(run.exitCode).toBe(1);
      expect(run.log).toContain(
        `neither e2e/test-plan.ts nor an e2e/*.config.ts includes them: ${name}`,
      );
      expect(run.outputs).toEqual({});
    }).pipe(Effect.scoped),
  );

  it.effect("a config's own test.include counts, however it is written, and nothing else", () =>
    Effect.gen(function* () {
      const included = "ci-selection-included.spec.ts";
      const covered = "ci-selection-covered.spec.ts";
      // A list in a variable, a quoted key, and coverage's unrelated include of a spec file.
      const root = yield* fixture({
        [`e2e/tests/${included}`]: "",
        [`e2e/tests/${covered}`]: "",
        [ownConfig]: [
          'import { defineConfig } from "vitest/config";',
          `const specs = ["e2e/tests/ci-selection.spec.ts", "e2e/tests/${included}"];`,
          "export default defineConfig({",
          "  test: {",
          '    "include": specs,',
          `    coverage: { include: ["packages/**/*.ts", "e2e/tests/${covered}"] },`,
          "  },",
          "});",
          "",
        ].join("\n"),
      });
      const [main, named, changed] = yield* Effect.all(
        [
          select({ root }),
          select({ body: block(included), root }),
          select({ body: block("none"), changed: [`e2e/tests/${covered}`], root }),
        ],
        { concurrency: "unbounded" },
      );
      expect(main.exitCode, main.log).toBe(0);
      expect(named.exitCode).toBe(1);
      expect(named.log).toContain(
        `- ${included} runs with ${ownConfig} in Checks (.github/workflows/checks.yml).`,
      );
      expect(changed.exitCode).toBe(1);
      expect(changed.log).toContain(
        `neither e2e/test-plan.ts nor an e2e/*.config.ts includes them: ${covered}`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a config the selection cannot read fails every run except a skipped layer", () =>
    Effect.forEach(
      [
        [
          ownConfig,
          [
            'import { defineConfig } from "vitest/config";',
            'export default defineConfig({ test: { include: ["e2e/tests/*.spec.ts"] } });',
          ].join("\n"),
          `${ownConfig} must export a config object whose test.include lists e2e/tests/*.spec.ts paths`,
        ],
        [
          ownConfig,
          'throw new Error("Start a target first.");',
          `${ownConfig} failed to load: Error: Start a target first.`,
        ],
        [
          "e2e/ci-selection-unlisted.config.ts",
          "export default {};",
          "Add e2e/ci-selection-unlisted.config.ts.",
        ],
      ] as const,
      ([config, text, failure]) =>
        Effect.gen(function* () {
          const root = yield* fixture({ [config]: `${text}\n` });
          const [main, named, skip] = yield* Effect.all(
            [
              select({ root }),
              select({ body: block("groups.spec.ts"), root }),
              select({ body: block("skip"), stackedAbove: "123", root }),
            ],
            { concurrency: "unbounded" },
          );
          for (const run of [main, named]) {
            expect(run.exitCode, failure).toBe(1);
            expect(run.log, failure).toContain(failure);
            expect(run.outputs, failure).toEqual({});
          }
          expect(skip.exitCode, skip.log).toBe(0);
          expect(skip.outputs, failure).toEqual({ skip: "true" });
        }).pipe(Effect.scoped),
      { discard: true },
    ),
  );

  it.effect(
    "the save path reads imports with a parser: wildcard exports, dynamic imports after a regular expression, no method calls or template text, and it fails closed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-save-path-" });
        const write = (file: string, text: string) =>
          fs
            .makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
            .pipe(Effect.andThen(fs.writeFileString(path.join(root, file), text)));
        yield* write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
        yield* write(
          "packages/lib/package.json",
          JSON.stringify({ name: "@example/lib", exports: { "./parts/*": "./src/parts/*.ts" } }),
        );
        yield* write("packages/lib/src/parts/a.ts", "export const a = 1;\n");
        yield* write(
          "entry.ts",
          [
            'import { a } from "@example/lib/parts/a";',
            // An app's source a template writes imports its own files.
            'const app = `import x from "./generated.ts";\n${a ? `import y from "./other.ts"` : ""}`;',
            "export { a, app };",
          ].join("\n"),
        );
        // Method calls named `from` are not imports, and a regular expression with a quote and a
        // backtick does not hide the dynamic import after it.
        yield* write(
          "calls.ts",
          [
            'const bytes = Buffer.from("./missing");',
            'const letters = Array.from(".");',
            'const quoted = /["`]/;',
            'const later = await import("./later.ts");',
            "export { bytes, letters, quoted, later };",
          ].join("\n"),
        );
        yield* write("later.ts", "export const later = 1;\n");
        yield* write("broken.ts", 'import { gone } from "./gone.ts";\nexport { gone };\n');
        yield* write("unparsable.ts", "export const = ;\n");
        expect([...(yield* closureOf(root, ["entry.ts"]))].sort()).toEqual([
          "entry.ts",
          "packages/lib/src/parts/a.ts",
        ]);
        expect([...(yield* closureOf(root, ["calls.ts"]))].sort()).toEqual([
          "calls.ts",
          "later.ts",
        ]);
        // A file the parser cannot read fails the computation, naming it.
        const unparsed = yield* closureOf(root, ["entry.ts", "unparsable.ts"]).pipe(Effect.flip);
        expect(unparsed.message).toContain("unparsable.ts");
        const failed = yield* closureOf(root, ["entry.ts", "broken.ts"]).pipe(Effect.flip);
        expect(failed.message).toContain("cannot follow these imports");
        expect(failed.message).toContain("broken.ts: ./gone.ts");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "the webhook source lookup runs when a file a save runs or reads changed, or when nothing says it did not",
    () =>
      Effect.gen(function* () {
        const lookup = scenarios.webhookSourceLookup.title;
        const runs = yield* Effect.all(
          {
            route: select({
              body: block("none"),
              compared: ["apps/hosted/server/src/implementation/accounts.ts"],
            }),
            // Reached only through the SDK's exports, not named anywhere by hand.
            storage: select({
              body: block("none"),
              compared: ["packages/fumadb-effect/src/implementation/sql/query.ts"],
            }),
            schema: select({
              body: block("none"),
              compared: ["apps/hosted/server/src/implementation/resource-schema.ts"],
            }),
            elsewhere: select({ body: block("none"), compared: ["apps/marketing/src/pages.ts"] }),
            manual: select({ body: block("none"), compared: "unknown" }),
            // GitHub lists at most 300 files of a comparison; a longer one may hide a save's file.
            tooLongToList: select({
              body: block("none"),
              compared: Array.from({ length: 300 }, (_, index) => `apps/file-${index}.ts`),
            }),
          },
          { concurrency: 4 },
        );
        const ran = Object.fromEntries(
          Object.entries(runs).map(([name, run]) => {
            expect(run.exitCode, `${name}: ${run.log}`).toBe(0);
            const selected = run.outputs["cloud-locks"] ?? "";
            return [name, selected !== "" && new RegExp(selected).test(lookup)];
          }),
        );
        expect(ran).toEqual({
          route: true,
          storage: true,
          schema: true,
          elsewhere: false,
          manual: true,
          tooLongToList: true,
        });
        expect(runs.storage.summary).toContain(
          "A file a save runs or reads differs from main (e2e/save-path.ts), so these run in cloud-locks: webhook-source-lookup.spec.ts",
        );
      }),
  );

  it.effect(
    "the harness scenarios run when a harness path changed, or when nothing says it did not",
    () =>
      Effect.gen(function* () {
        const harness = scenarios.failureEvidence.title;
        const runs = yield* Effect.all(
          {
            push: select({}),
            pushChangingHarness: select({ compared: ["e2e/support/evidence.ts"] }),
            manual: select({ compared: "unknown" }),
            product: select({
              body: block("groups.spec.ts"),
              compared: ["apps/local/server/src/bin.ts", "e2e/tests/groups.spec.ts"],
            }),
            harnessWithNone: select({ body: block("none"), compared: ["e2e/setup.ts"] }),
            lockfile: select({ body: block("none"), compared: ["bun.lock"] }),
            tooLongToList: select({
              body: block("none"),
              compared: Array.from({ length: 300 }, (_, index) => `apps/file-${index}.ts`),
            }),
            named: select({ body: block("failure-evidence.spec.ts") }),
          },
          { concurrency: 4 },
        );
        const ran = Object.fromEntries(
          Object.entries(runs).map(([name, run]) => {
            expect(run.exitCode, `${name}: ${run.log}`).toBe(0);
            const selected = run.outputs["self-host"] ?? "";
            return [name, selected !== "" && new RegExp(selected).test(harness)];
          }),
        );
        expect(ran).toEqual({
          push: false,
          pushChangingHarness: true,
          manual: true,
          product: false,
          harnessWithNone: true,
          lockfile: true,
          tooLongToList: true,
          named: true,
        });
        // A full run that runs them puts them in one of the job's parts.
        expect(
          shards(runs.pushChangingHarness.outputs, "self-host").some(({ pattern }) =>
            new RegExp(pattern).test(harness),
          ),
        ).toBe(true);
        expect(
          shards(runs.push.outputs, "self-host").some(({ pattern }) =>
            new RegExp(pattern).test(harness),
          ),
        ).toBe(false);
      }),
  );

  it.effect("none, all and skip keep their meaning", () =>
    Effect.gen(function* () {
      const [none, all, bareAll, skip, loneSkip, missing, twice] = yield* Effect.all(
        [
          select({ body: block("none") }),
          select({ body: block("all: changes the lockfile") }),
          select({ body: block("all") }),
          select({ body: block("skip"), stackedAbove: "123" }),
          select({ body: block("skip") }),
          select({ body: "No block." }),
          select({ body: `${block("none")}\n${block("none")}` }),
        ],
        { concurrency: 4 },
      );
      expect(none.exitCode).toBe(0);
      for (const job of [...jobs, ...runnerOutputs]) expect(none.outputs[job], job).toBe("");
      expect(none.outputs.full).toBe("false");
      expect(all.exitCode).toBe(0);
      for (const job of [...jobs, ...runnerOutputs]) expect(all.outputs[job], job).not.toBe("");
      expect(all.outputs.full).toBe("true");
      expect(all.summary).toContain("Full suite: changes the lockfile");
      expect(bareAll.exitCode).toBe(1);
      expect(skip.exitCode).toBe(0);
      expect(skip.outputs).toEqual({ skip: "true" });
      expect(loneSkip.exitCode).toBe(1);
      expect(missing.exitCode).toBe(1);
      expect(twice.exitCode).toBe(1);
    }),
  );

  it.effect("the job waits for an e2e block written after the pull request opened", () =>
    Effect.gen(function* () {
      const footer = "Stack created with GitHub Stacks CLI";
      const run = yield* select({ body: [footer, footer, block("none")], wait: 30 });
      expect(run.exitCode, run.log).toBe(0);
      expect(run.log).toContain("Waiting up to 30 seconds for an e2e block in the description.");
      expect(run.log).toMatch(/Waited \d+ s for an e2e block in the description\./);
      for (const job of jobs) expect(run.outputs[job], job).toBe("");
    }),
  );

  it.effect("a skipped layer waits for the pull request above it, even after its block", () =>
    Effect.gen(function* () {
      const run = yield* select({
        body: ["", block("skip")],
        stackedAbove: ["", "", "124"],
        wait: 30,
      });
      expect(run.exitCode, run.log).toBe(0);
      expect(run.outputs).toEqual({ skip: "true" });
      expect(run.log).toMatch(
        /Waited \d+ s for an e2e block in the description, then an open pull request based on this branch\./,
      );
      expect(run.summary).toContain("a lower stack layer under #124");
    }),
  );

  it.effect("the wait reads skip as the selection does, however the block writes it", () =>
    Effect.gen(function* () {
      // The block splits on whitespace and commas, so each of these is skip and waits for the
      // layer above. Names are compared as written, so SKIP is a file name and waits for nothing.
      const skips = ["skip,", " skip ", ",skip,\n"];
      const [waited, upper, named] = yield* Effect.all(
        [
          Effect.forEach(
            skips,
            (text) => select({ body: block(text), stackedAbove: ["", "124"], wait: 30 }),
            { concurrency: "unbounded" },
          ),
          select({ body: block("SKIP"), stackedAbove: ["", "124"], wait: 30 }),
          select({ body: block("groups.spec.ts"), stackedAbove: ["", "124"], wait: 30 }),
        ],
        { concurrency: "unbounded" },
      );
      for (const [index, run] of waited.entries()) {
        expect(run.exitCode, `${skips[index]}: ${run.log}`).toBe(0);
        expect(run.outputs, skips[index]).toEqual({ skip: "true" });
        expect(run.log, skips[index]).toMatch(
          /Waited \d+ s for an open pull request based on this branch\./,
        );
      }
      expect(upper.exitCode).toBe(1);
      expect(upper.log).toContain('not spec files in e2e/tests/: "SKIP"');
      expect(upper.log).not.toContain("Waiting");
      expect(named.exitCode, named.log).toBe(0);
      expect(named.outputs["self-host"]).toMatch(/^\^\(\?:/);
      expect(named.log).not.toContain("Waiting");
    }),
  );

  it.effect("a description still incomplete after the wait fails with how to rerun", () =>
    Effect.gen(function* () {
      const [missing, loneSkip] = yield* Effect.all(
        [select({ body: "No block.", wait: 1 }), select({ body: block("skip"), wait: 1 })],
        { concurrency: "unbounded" },
      );
      expect(missing.exitCode).toBe(1);
      expect(missing.log).toMatch(
        /Waited \d+ s for an e2e block in the description; there is still no e2e block in the description\./,
      );
      expect(missing.log).toContain("The pull request description has no e2e block.");
      expect(missing.log).toContain(
        "CI waited 1 second for the description. Once it is fixed, rerun the whole workflow: gh run rerun 123456.",
      );
      expect(loneSkip.exitCode).toBe(1);
      expect(loneSkip.log).toContain("no open pull request builds on this branch");
      expect(loneSkip.log).toContain("gh run rerun 123456.");
    }),
  );
  it.effect("a full run passes when every scheduled scenario ran, passed or failed", () =>
    Effect.gen(function* () {
      const failed = "Cloud onboarding";
      const [ci, deployed] = yield* Effect.all(
        [
          verify("ci", [
            { target: "local" },
            { target: "self-host" },
            {
              target: "cloud",
              status: (title) => (title.startsWith(failed) ? "failed" : "passed"),
            },
          ]),
          verify("deployed", [{ target: "cloud" }]),
        ],
        { concurrency: "unbounded" },
      );
      expect(ci.exitCode, ci.log).toBe(0);
      expect(ci.log).toMatch(
        /Every one of the \d+ scenario runs the jobs here schedule executed\./,
      );
      expect(deployed.exitCode, deployed.log).toBe(0);
      expect(deployed.log).toMatch(/Every one of the \d+ scenario runs Cloud tests on main/);
    }),
  );

  it.effect("a sharded job's parts count together, and a missing part fails the full run", () =>
    Effect.gen(function* () {
      // Three parts by spec file, as e2e-self-host's runners save them.
      const part = (index: number) => (file: string) =>
        [...file].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 3 === index;
      const parts = [0, 1, 2].map((index) => ({
        target: "self-host" as const,
        files: part(index),
      }));
      const [complete, missing] = yield* Effect.all(
        [
          verify("ci", [{ target: "local" }, ...parts, { target: "cloud" }]),
          verify("ci", [{ target: "local" }, ...parts.slice(0, 2), { target: "cloud" }]),
        ],
        { concurrency: "unbounded" },
      );
      expect(complete.exitCode, complete.log).toBe(0);
      expect(missing.exitCode, missing.log).toBe(1);
      expect(missing.log).toMatch(
        /- the self-host job on self-host: \d+ of \d+ scenarios did not run/,
      );
      expect(missing.log).not.toContain("- the local job");
      expect(missing.log).not.toMatch(/- the cloud[\w-]* job/);
    }),
  );

  it.effect("a job, step or deployed run that saved no result fails the full run", () =>
    Effect.gen(function* () {
      const rateLimit =
        /^Cloud (?:limits sign-in|counts two first requests|reports a Better Auth query the database failed|records a rate-limited OAuth token request)/;
      const [noCloud, skippedStep, noDeployed, deployedOnLocal] = yield* Effect.all(
        [
          // The e2e-cloud job was skipped or disabled: it saved nothing.
          verify("ci", [{ target: "local" }, { target: "self-host" }]),
          // The rate-limit step's guard never held: its scenarios are only filtered out.
          verify("ci", [
            { target: "local" },
            { target: "self-host" },
            { target: "cloud", status: (title) => (rateLimit.test(title) ? "skipped" : "passed") },
          ]),
          verify("deployed", []),
          verify("deployed", [{ target: "self-host" }]),
        ],
        { concurrency: "unbounded" },
      );
      for (const run of [noCloud, skippedStep, noDeployed, deployedOnLocal]) {
        expect(run.exitCode, run.log).toBe(1);
        expect(run.log).toContain("A full run must execute every scheduled scenario");
      }
      for (const job of [
        "cloud",
        "cloud-product",
        "cloud-domains",
        "cloud-workers",
        "cloud-locks",
        "cloud-removal-recovery",
        "cloud-batch",
        "cloud-export-hang",
        "cloud-autumn",
        "cloud-isolate",
        "cloud-telemetry-flush",
        "cloud-connections",
        "cloud-v1-bound",
        "cloud-rate-limit",
        "cloud-rollback",
        "cloud-oauth-proxy-preview",
      ])
        expect(noCloud.log).toMatch(
          new RegExp(`- the ${job} job on cloud: (\\d+) of \\1 scenarios did not run`),
        );
      expect(noCloud.log).not.toContain("- the local job");
      expect(noCloud.log).not.toContain("- the self-host job");
      expect(skippedStep.log).toContain(
        "- the cloud-rate-limit job on cloud: 4 of 4 scenarios did not run",
      );
      expect(skippedStep.log).not.toContain("- the cloud job");
      for (const run of [noDeployed, deployedOnLocal])
        expect(run.log).toMatch(
          /- Cloud tests on main on cloud: (\d+) of \1 scenarios did not run/,
        );
    }),
  );

  it.effect("a report outside a directory named for its target fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-ci-coverage-" });
      yield* fs.makeDirectory(path.join(directory, "run", "report", "diagnostics"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(directory, "run", "report", "diagnostics", "results.json"),
        JSON.stringify({ testResults: [] }),
      );
      const child = yield* processes.spawn(
        ChildProcess.make("node", ["e2e/ci-selection.ts", "verify", "ci", directory]),
      );
      const [log, exitCode] = yield* Effect.all(
        [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
        { concurrency: "unbounded" },
      );
      expect(exitCode).toBe(1);
      expect(log).toContain("is not in a run directory named for its target");
    }).pipe(Effect.scoped),
  );

  it.effect("a pull request runs each release lane for the files it reads, since main", () =>
    Effect.gen(function* () {
      const lanes = (compared: ReadonlyArray<string> | "unknown") =>
        select({ body: block("none"), compared }).pipe(
          Effect.tap((run) => Effect.sync(() => expect(run.exitCode, run.log).toBe(0))),
          Effect.map((run) => [run.outputs["release-docker"], run.outputs["release-local"]]),
        );
      const cases: ReadonlyArray<
        readonly [ReadonlyArray<string> | "unknown", readonly [string, string]]
      > = [
        // A file the released-image suite imports, and the image's own inputs.
        [["e2e/support/docker-release-server.ts"], ["true", ""]],
        // A support file both a local suite and the released-image suite import.
        [["e2e/support/evidence.ts"], ["true", "true"]],
        // Support files only the packaged CLI and desktop suites import.
        [["e2e/support/ports.ts"], ["", "true"]],
        [
          ["e2e/support/os-credential.ts", "e2e/support/stand-in-package.ts"],
          ["", "true"],
        ],
        // What else the image's build and both lanes' steps read.
        [["bunfig.toml"], ["true", ""]],
        [["playground/demo-apps/live-inbox/package.json"], ["true", ""]],
        [[".github/actions/e2e-tools/action.yml"], ["true", "true"]],
        [["apps/hosted/self-host/Dockerfile"], ["true", ""]],
        // The image's server, which the fixtures' scenario server also runs on.
        [["apps/hosted/server/src/index.ts"], ["true", "true"]],
        [["apps/hosted/testing/src/scenario-server.ts"], ["true", "true"]],
        // The CLI's and the desktop app's source: their own packages, as pull request #4028's
        // startup change was, and packaging.
        [["apps/local/server/src/bin.ts"], ["", "true"]],
        [["apps/local/web/src/main.tsx"], ["", "true"]],
        [["apps/cli/src/main.ts"], ["", "true"]],
        // A workspace package both are built from, and the dependencies both install.
        [["packages/app-management/src/tools-cli.ts"], ["true", "true"]],
        [
          ["packages/sdk/src/index.ts", "packages/apps/src/index.ts"],
          ["true", "true"],
        ],
        [["bun.lock"], ["true", "true"]],
        [["apps/docs/public/install.sh"], ["", "true"]],
        [["scripts/releases/config.ts"], ["true", "true"]],
        // The lanes' own definition runs both.
        [[".github/workflows/checks.yml"], ["true", "true"]],
        // A support file the suite does not import, the scenario list it imports only for its
        // schema, and what only the matrix after merge runs start neither.
        [
          ["e2e/support/billing.ts", "e2e/test-plan.ts"],
          ["", ""],
        ],
        [
          ["e2e/tests/desktop-recovery.spec.ts", ".github/workflows/release-artifacts.yml"],
          ["", ""],
        ],
        // Packages only Cloud and the site are built from.
        [
          ["apps/hosted/cloud/src/worker.ts", "apps/marketing/src/index.ts"],
          ["", ""],
        ],
        // Without a comparison, or with one GitHub cut short, both run.
        ["unknown", ["true", "true"]],
        [Array.from({ length: 300 }, (_, index) => `notes/file-${index}.md`), ["true", "true"]],
      ];
      const results = yield* Effect.forEach(cases, ([compared]) => lanes(compared), {
        concurrency: 4,
      });
      for (const [index, [compared, expected]] of cases.entries())
        expect(results[index], JSON.stringify(compared).slice(0, 120)).toEqual(expected);

      const summary = (yield* select({
        body: block("none"),
        compared: ["e2e/support/docker-release-server.ts"],
      })).summary;
      expect(summary).toContain("release-docker: runs, for e2e/support/docker-release-server.ts.");
      expect(summary).toContain("release-local: skipped, no file it reads changed.");
    }),
  );

  it.effect("a file renamed out of a lane's path starts that lane by its old name", () =>
    Effect.gen(function* () {
      const run = yield* select({
        body: block("none"),
        renamed: [
          {
            from: "e2e/support/docker-release-server.ts",
            to: "e2e/fixtures/docker-release-server.ts",
          },
          { from: "apps/local/server/src/bin.ts", to: "notes/bin.ts" },
        ],
      });
      expect(run.exitCode, run.log).toBe(0);
      expect([run.outputs["release-docker"], run.outputs["release-local"]]).toEqual([
        "true",
        "true",
      ]);
      expect(run.summary).toContain(
        "release-docker: runs, for e2e/support/docker-release-server.ts.",
      );
    }),
  );

  it.effect("a skipped stack layer runs no release lane; the layer above runs them", () =>
    Effect.gen(function* () {
      const run = yield* select({
        body: block("skip"),
        stackedAbove: "12",
        compared: ["apps/cli/src/main.ts", "e2e/support/docker-release-server.ts"],
      });
      expect(run.exitCode, run.log).toBe(0);
      expect(run.outputs).toEqual({ skip: "true" });
    }),
  );

  it.effect("an import the released-image suite no longer makes ends its exception", () =>
    Effect.gen(function* () {
      const root = yield* fixture({
        "e2e/docker-release.config.ts":
          'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["e2e/tests/docker-release.spec.ts"] } });\n',
        "e2e/tests/docker-release.spec.ts": 'import { it } from "vitest";\nit("runs", () => {});\n',
      });
      const run = yield* select({ body: block("none"), root });
      expect(run.exitCode, run.log).toBe(1);
      expect(run.log).toContain(
        "notSuiteInputs in e2e/release-lanes.ts lists files the released-image suite no longer imports: e2e/test-plan.ts. Remove them.",
      );
    }),
  );

  it.effect("a check tests Linux x64 and the image; publishing and builds test everything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-release-matrix-" });
      const targets = (channel: string, notarize = false, ref = "refs/heads/main") =>
        Effect.gen(function* () {
          const output = path.join(directory, channel);
          yield* fs.writeFileString(output, "");
          const child = yield* processes.spawn(
            ChildProcess.make("node", ["scripts/releases/workflow.ts"], {
              env: {
                GITHUB_OUTPUT: output,
                GITHUB_EVENT_NAME: "workflow_dispatch",
                GITHUB_REF: ref,
                RELEASE_CHANNEL: channel,
                RELEASE_NOTARIZE: String(notarize),
              },
              extendEnv: true,
            }),
          );
          const [log, exitCode] = yield* Effect.all(
            [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
            { concurrency: "unbounded" },
          );
          expect(exitCode, log).toBe(0);
          const values = Object.fromEntries(
            (yield* fs.readFileString(output))
              .split("\n")
              .filter((line) => line !== "")
              .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
          );
          const names = (key: string) =>
            (JSON.parse(values[key]!) as { include: ReadonlyArray<Record<string, string>> }).include
              .map((entry) =>
                entry.platform === undefined ? entry.arch : `${entry.platform}-${entry.arch}`,
              )
              .sort();
          return {
            publish: values.publish,
            local: names("matrix"),
            checks: names("checks_matrix"),
            recovery: names("recovery_matrix"),
            notarized: names("notarized_recovery_matrix"),
            cli: names("cli_matrix"),
            docker: names("docker_matrix"),
          };
        }).pipe(Effect.scoped);
      // The CLI suite runs in two parts and desktop crash recovery in three, each on its own runner.
      const parts = (names: ReadonlyArray<string>, count: number) =>
        names.flatMap((name) => Array.from({ length: count }, () => name));
      expect(yield* targets("check")).toEqual({
        publish: "false",
        local: ["linux-x64"],
        checks: ["linux-x64"],
        recovery: parts(["linux-x64"], 3),
        notarized: [],
        cli: parts(["linux-x64"], 2),
        docker: ["amd64", "arm64"],
      });
      expect(yield* targets("build")).toEqual({
        publish: "false",
        local: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"],
        checks: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"],
        recovery: parts(["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"], 3),
        notarized: [],
        cli: parts(["linux-x64", "win32-x64"], 2),
        docker: ["amd64", "arm64"],
      });
      // A publishing run, in the channel the CLI's version names, tests the macOS app it
      // notarizes, after local has built it.
      const { version } = JSON.parse(yield* fs.readFileString("apps/cli/package.json")) as {
        readonly version: string;
      };
      const notarized = {
        local: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"],
        checks: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"],
        recovery: parts(["linux-arm64", "linux-x64", "win32-x64"], 3),
        notarized: parts(["darwin-arm64"], 3),
        cli: parts(["linux-x64", "win32-x64"], 2),
        docker: ["amd64", "arm64"],
      };
      expect(yield* targets(version.includes("-beta.") ? "beta" : "latest")).toEqual({
        publish: "true",
        ...notarized,
      });
      // A build asked to notarize tests the notarized macOS app the same way, and publishes nothing.
      expect(yield* targets("build", true)).toEqual({ publish: "false", ...notarized });
      // Notarizing signs and notarizes the desktop app with the company's Developer ID, so only main may ask.
      const refused = yield* Effect.gen(function* () {
        const output = path.join(directory, "branch-notarize");
        yield* fs.writeFileString(output, "");
        const child = yield* processes.spawn(
          ChildProcess.make("node", ["scripts/releases/workflow.ts"], {
            env: {
              GITHUB_OUTPUT: output,
              GITHUB_EVENT_NAME: "workflow_dispatch",
              GITHUB_REF: "refs/heads/some-branch",
              RELEASE_CHANNEL: "build",
              RELEASE_NOTARIZE: "true",
            },
            extendEnv: true,
          }),
        );
        const [log, exitCode] = yield* Effect.all(
          [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
          { concurrency: "unbounded" },
        );
        return { log, exitCode, written: yield* fs.readFileString(output) };
      }).pipe(Effect.scoped);
      expect(refused.exitCode, refused.log).not.toBe(0);
      expect(refused.log).toContain("Notarize from main: it signs and notarizes the desktop app.");
      expect(refused.written, "a refused run decides no matrix").toBe("");
      // A build from a branch without notarize still runs.
      expect((yield* targets("build", false, "refs/heads/some-branch")).publish).toBe("false");
    }),
  );

  it.effect(
    "each release lane runs its release job's steps for one platform, minus publishing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        /** The names of a job's named steps, in order, from the workflow's block YAML. */
        const steps = (file: string, job: string) =>
          Effect.gen(function* () {
            const lines = (yield* fs.readFileString(file)).split("\n");
            const begin = lines.indexOf(`  ${job}:`);
            expect(begin, `${file}: ${job}`).toBeGreaterThan(-1);
            const end = lines.findIndex((line, index) => index > begin && /^ {0,2}\S/.test(line));
            return lines
              .slice(begin + 1, end === -1 ? undefined : end)
              .flatMap((line) => /^ {6}- name: (.+)$/.exec(line)?.[1] ?? []);
          });
        const own = "Read the release identity";
        /**
         * The local release job's steps with the checks job's tests where local ran them, after
         * staging the apps package: release-local runs both jobs' steps for Linux x64, in one job.
         */
        const localAndChecks = Effect.gen(function* () {
          const local = yield* steps(".github/workflows/release-artifacts.yml", "local");
          const checks = yield* steps(".github/workflows/release-artifacts.yml", "checks");
          const staged = local.indexOf("Stage the apps package") + 1;
          const tests = checks.slice(checks.indexOf("Stage the apps package") + 1);
          return [...local.slice(0, staged), ...tests, ...local.slice(staged)];
        });
        const lanes = [
          ["release-docker", "docker", ["Push the tested architecture without moving a channel"]],
          [
            "release-local",
            "local",
            [
              // Windows and macOS only, or the check of a target without the packaged tests.
              "Diagnose Windows npm archive failure",
              "Install Chromium on desktop runners",
              "Smoke-test the installed CLI",
              "Sign and notarize public macOS installers",
              "Verify macOS installer and update archive",
              "Verify the macOS update archive keeps a valid signature",
              "Verify Windows long-path support survives both packages",
              "Verify Apple signing and notarization",
              "Wait for Apple to accept the CLI's notarization",
              // For publication: the archives job compares it with the cli and checks jobs'.
              "Record the published archive's digest",
              // The archives job compares it with the recovery parts' apps, which this lane lacks.
              "Record the packaged desktop app's digest",
            ],
          ],
        ] as const;
        for (const [lane, job, omitted] of lanes) {
          const ran = yield* steps(".github/workflows/checks.yml", lane);
          expect(ran, lane).toContain(own);
          const released =
            job === "local"
              ? yield* localAndChecks
              : yield* steps(".github/workflows/release-artifacts.yml", job);
          for (const name of omitted) expect(released, `${job} still has ${name}`).toContain(name);
          expect(
            ran.filter((name) => name !== own),
            lane,
          ).toEqual(released.filter((name) => !(omitted as ReadonlyArray<string>).includes(name)));
        }
      }),
  );

  it.effect("the e2e check runs after a cancellation and skips only for a skipped layer", () =>
    Effect.gen(function* () {
      // A check its condition skips counts as passed, so a condition that a cancellation can
      // make false, such as !cancelled(), would pass a cancelled run.
      const check = yield* workflowJob("e2e");
      expect(check.if).toBe("${{ always() && needs.select.outputs.skip != 'true' }}");
      expect(check.needs).toBe(`[select, ${e2eJobs.join(", ")}]`);
      for (const job of e2eJobs)
        expect((yield* workflowJob(job)).if, job).toBe(
          startedBy[job].map((name) => `needs.select.outputs.${name} != ''`).join(" || "),
        );
    }),
  );

  it.effect(
    "the e2e check passes only when select succeeded, each chosen job passed and the rest skipped",
    () =>
      Effect.gen(function* () {
        const [main, named] = yield* Effect.all(
          [select({}), select({ body: block("groups.spec.ts") })],
          { concurrency: "unbounded" },
        );
        expect(named.exitCode, named.log).toBe(0);
        const skippedJobs = e2eJobs.filter((job) => !chosen(named.outputs, job));
        const namedJobs = e2eJobs.filter((job) => chosen(named.outputs, job));
        expect(skippedJobs.length, named.log).toBeGreaterThan(0);
        expect(namedJobs.length, named.log).toBeGreaterThan(0);
        const ended = (
          outputs: Readonly<Record<string, string>>,
          change: Partial<Record<E2eJob, string>> = {},
        ) =>
          ({
            ...Object.fromEntries(
              e2eJobs.map((job) => [job, chosen(outputs, job) ? "success" : "skipped"]),
            ),
            ...change,
          }) as Record<E2eJob, string>;
        const succeeded = (outputs: Readonly<Record<string, string>>) => ({
          result: "success",
          outputs,
        });

        for (const run of [main, named]) {
          const passed = yield* gate(succeeded(run.outputs), ended(run.outputs));
          expect(passed.exitCode, passed.log).toBe(0);
        }

        const [job] = namedJobs;
        const failing = yield* Effect.all(
          [
            // A chosen job that a failed or cancelled select left unstarted is skipped.
            gate(succeeded(named.outputs), ended(named.outputs, { [job!]: "skipped" })),
            gate(succeeded(named.outputs), ended(named.outputs, { [job!]: "cancelled" })),
            gate(succeeded(named.outputs), ended(named.outputs, { [job!]: "failure" })),
            gate(succeeded(main.outputs), ended(main.outputs, { "e2e-cloud": "cancelled" })),
            // A cancelled or failed select gives no outputs, so every E2E job is skipped.
            gate({ result: "cancelled", outputs: {} }, ended({})),
            gate({ result: "failure", outputs: {} }, ended({})),
          ],
          { concurrency: "unbounded" },
        );
        for (const run of failing) expect(run.exitCode, run.log).toBe(1);
        expect(failing[0]!.log).toContain(`::error::${job}: selected, but skipped`);
        expect(failing[1]!.log).toContain(`::error::${job}: selected, but cancelled`);
        expect(failing[2]!.log).toContain(`::error::${job}: selected, but failure`);
        expect(failing[3]!.log).toContain("::error::e2e-cloud: selected, but cancelled");
        expect(failing[4]!.log).toContain(
          "::error::select: cancelled, so the E2E jobs did not run its selection",
        );
        expect(failing[5]!.log).toContain(
          "::error::select: failure, so the E2E jobs did not run its selection",
        );
      }),
  );
});

/**
 * A `gh` for e2e/release-check.ts: `run list` answers the runs in `runs.json` with the event its
 * `-e` names, as GitHub filters, `run view N` answers
 * `jobs-N.json`, and `api <compare path> --jq <filter>` applies the filter to `compared.json` with
 * jq, as gh does. A `fails` file beside it makes `run list` fail.
 */
const stubCheckGh = `#!/bin/sh
dir=$(dirname "$0")
case "$1 $2" in
  "run list") [ -f "$dir/fails" ] && { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
    while [ $# -gt 0 ]; do [ "$1" = -e ] && event=$2; shift; done
    exec jq --arg event "$event" '[.[] | select(.event == $event)] | map(del(.event))' "$dir/runs.json" ;;
  "run view") exec cat "$dir/jobs-$3.json" ;;
  api*) exec jq -r "$4" "$dir/compared.json" ;;
esac
echo "stub gh: unsupported: $*" >&2
exit 2
`;

/** A dispatched Executor releases run on main, newest first in `checks`. */
interface DispatchedRun {
  readonly id: number;
  readonly sha: string;
  readonly title?: string;
  readonly status?: "queued" | "in_progress" | "completed";
  readonly conclusion?: "success" | "failure" | "cancelled";
  readonly pace?: "success" | "failure";
  /** The metadata job; skipped when the matrix did not run. */
  readonly metadata?: "success" | "skipped";
}

const head = "f".repeat(40);

/**
 * `node e2e/release-check.ts` for a push of `head`, with these dispatched runs on main and these
 * files changed since the base it picks, in the checkout or a fixture tree `root`.
 */
const decideCheck = (input: {
  readonly checks: ReadonlyArray<DispatchedRun>;
  readonly changed?: ReadonlyArray<string>;
  readonly renamed?: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly status?: string;
  readonly fails?: boolean;
  readonly root?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-release-check-" });
    const bin = path.join(directory, "bin");
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(path.join(bin, "gh"), stubCheckGh);
    yield* fs.chmod(path.join(bin, "gh"), 0o755);
    if (input.fails === true) yield* fs.writeFileString(path.join(bin, "fails"), "");
    yield* fs.writeFileString(
      path.join(bin, "runs.json"),
      JSON.stringify(
        input.checks.map((check) => ({
          databaseId: check.id,
          // A check is a repository dispatch; a build or a publication is a workflow dispatch.
          event: check.title === undefined ? "repository_dispatch" : "workflow_dispatch",
          status: check.status ?? "completed",
          conclusion:
            (check.status ?? "completed") === "completed" ? (check.conclusion ?? "success") : "",
          headSha: check.sha,
          url: `https://github.com/owner/repository/actions/runs/${check.id}`,
        })),
      ),
    );
    for (const check of input.checks)
      yield* fs.writeFileString(
        path.join(bin, `jobs-${check.id}.json`),
        JSON.stringify({
          jobs: [
            { name: "pace", conclusion: check.pace ?? "success" },
            { name: "metadata", conclusion: check.metadata ?? "success" },
          ],
        }),
      );
    yield* fs.writeFileString(
      path.join(bin, "compared.json"),
      JSON.stringify({
        status: input.status ?? "ahead",
        files: [
          ...(input.changed ?? []).map((filename) => ({ filename })),
          ...(input.renamed ?? []).map(({ from, to }) => ({
            filename: to,
            previous_filename: from,
          })),
        ],
      }),
    );
    const output = path.join(directory, "output");
    const summary = path.join(directory, "summary");
    yield* fs.writeFileString(output, "");
    yield* fs.writeFileString(summary, "");
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["e2e/release-check.ts"], {
        cwd: input.root,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GITHUB_REPOSITORY: "owner/repository",
          RELEASE_CHECK_HEAD: head,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
        extendEnv: true,
      }),
    );
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return {
      exitCode,
      log,
      output: yield* fs.readFileString(output),
      summary: yield* fs.readFileString(summary),
    };
  }).pipe(Effect.scoped);

const tested: DispatchedRun = { id: 70, sha: "a".repeat(40) };

layer(NodeServices.layer)("Release check after a push to main", (it) => {
  it.effect("a change to what a release lane builds or runs starts the check", () =>
    Effect.gen(function* () {
      for (const changed of [
        ["apps/local/server/src/bin.ts"],
        ["packages/sdk/src/index.ts"],
        ["e2e/support/docker-release-server.ts"],
        ["e2e/tests/desktop-recovery.spec.ts"],
        [".github/workflows/release-artifacts.yml"],
        ["bun.lock"],
      ]) {
        const result = yield* decideCheck({ checks: [tested], changed });
        expect(result.exitCode, result.log).toBe(0);
        expect(result.output, changed[0]).toBe("run=true\n");
        expect(result.summary).toContain(`these changed: \`"${changed[0]}"\``);
      }
      const renamed = yield* decideCheck({
        checks: [tested],
        renamed: [{ from: "e2e/support/docker-release-server.ts", to: "notes/server.ts" }],
      });
      expect(renamed.output, renamed.log).toBe("run=true\n");
    }),
  );

  it.effect("a change nothing in a release lane reads skips it, saying why", () =>
    Effect.gen(function* () {
      const result = yield* decideCheck({
        checks: [tested],
        changed: ["notes/ci.md", "apps/hosted/cloud/src/worker.ts", "e2e/support/billing.ts"],
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.output).toBe("run=false\n");
      expect(result.summary).toContain(
        `Skipped: no file a release lane builds or runs changed since ${"a".repeat(40)}`,
      );
      const same = yield* decideCheck({ checks: [{ id: 71, sha: head }] });
      expect(same.output, same.log).toBe("run=false\n");
    }),
  );

  it.effect("the comparison starts at the last check that tested main, or will", () =>
    Effect.gen(function* () {
      const base = (checks: ReadonlyArray<DispatchedRun>) =>
        decideCheck({ checks, changed: ["notes/ci.md"] }).pipe(
          Effect.map((result) => result.summary),
        );
      // Builds, cancelled checks and checks that tested nothing are passed over.
      expect(
        yield* base([
          { id: 75, sha: "1".repeat(40), title: "Executor releases (build)" },
          { id: 74, sha: "2".repeat(40), conclusion: "cancelled" },
          {
            id: 73,
            sha: "3".repeat(40),
            pace: "failure",
            conclusion: "failure",
            metadata: "skipped",
          },
          { id: 72, sha: "4".repeat(40), title: "Executor releases (beta)" },
          tested,
        ]),
      ).toContain(`runs/70 tests`);
      // A check still queued or pacing will test its commit.
      expect(
        yield* base([{ id: 76, sha: "5".repeat(40), status: "in_progress" }, tested]),
      ).toContain("runs/76 tests");
    }),
  );

  it.effect("a file a release suite starts importing counts without editing a list", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fixture({ "e2e/release-new-helper.ts": "export const helper = 1;\n" });
      yield* fs.symlink(path.resolve("scripts"), path.join(root, "scripts"));
      for (const directory of ["support", "sdk"])
        yield* fs.symlink(path.resolve("e2e", directory), path.join(root, "e2e", directory));
      for (const name of yield* fs.readDirectory("e2e/tests"))
        yield* fs.copyFile(path.join("e2e/tests", name), path.join(root, "e2e/tests", name));
      const changed = ["e2e/release-new-helper.ts"];
      const before = yield* decideCheck({ checks: [tested], changed, root });
      expect(before.output, before.log).toBe("run=false\n");
      const spec = path.join(root, "e2e/tests/docker-release.spec.ts");
      yield* fs.writeFileString(
        spec,
        `import { helper } from "../release-new-helper.ts";\nvoid helper;\n${yield* fs.readFileString(spec)}`,
      );
      const after = yield* decideCheck({ checks: [tested], changed, root });
      expect(after.output, after.log).toBe("run=true\n");
    }).pipe(Effect.scoped),
  );

  it.effect("without a base, a full comparison or GitHub, it runs or fails, never skips", () =>
    Effect.gen(function* () {
      const none = yield* decideCheck({
        checks: [{ id: 77, sha: "6".repeat(40), conclusion: "cancelled" }],
      });
      expect(none.output, none.log).toBe("run=true\n");
      expect(none.summary).toContain("no earlier check on main tested a commit");
      const diverged = yield* decideCheck({
        checks: [tested],
        status: "diverged",
        changed: ["notes/ci.md"],
      });
      expect(diverged.output, diverged.log).toBe("run=true\n");
      const long = yield* decideCheck({
        checks: [tested],
        changed: Array.from({ length: 300 }, (_, index) => `notes/${index}.md`),
      });
      expect(long.output, long.log).toBe("run=true\n");
      const failed = yield* decideCheck({
        checks: [tested],
        fails: true,
        changed: ["notes/ci.md"],
      });
      expect(failed.exitCode).not.toBe(0);
      expect(failed.output).toBe("");
      expect(failed.log).toContain("HTTP 502: Bad Gateway");
    }),
  );

  it.effect("the workflow starts the check unless the decision passed and said to skip it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(".github/workflows/release-check.yml");
      expect(text).toContain("  push:\n    branches: [main]\n");
      expect(text).toContain("  schedule:\n");
      expect(text).not.toContain("paths:");
      const decide = text.slice(text.indexOf("\n  decide:\n"), text.indexOf("\n  dispatch:\n"));
      const dispatch = text.slice(text.indexOf("\n  dispatch:\n"));
      // The job that runs the checkout's code holds no write token; the one that starts the
      // check checks nothing out.
      expect(decide).toContain("run: node e2e/release-check.ts");
      expect(decide).not.toMatch(/^ {6}[\w-]+: write$/m);
      expect(dispatch).toMatch(/^ {6}contents: write$/m);
      expect(dispatch).not.toContain("actions/checkout");
      expect(dispatch).not.toContain("./.github/actions");
      expect(dispatch).toContain(
        "if: ${{ !cancelled() && (needs.decide.result != 'success' || needs.decide.outputs.run != 'false') }}",
      );
      expect(dispatch).toContain(
        'gh api --method POST "repos/$GITHUB_REPOSITORY/dispatches" -f event_type=release-check',
      );
    }),
  );

  it.effect(
    "the names the gate, the pace job and the issue script look up are in the workflow",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const text = yield* fs.readFileString(".github/workflows/release-artifacts.yml");
        // A check is the repository dispatch release-check.yml sends, and runs on main alone.
        expect(text).toContain("  repository_dispatch:\n    types: [release-check]\n");
        // beta-due.ts and matrix-issue.sh tell a build by its title.
        expect(text).toContain(
          "run-name: Executor releases (${{ github.event_name == 'repository_dispatch' && 'check' || inputs.channel }})",
        );
        expect(text).toContain("        options: [build, beta, latest]");
        for (const job of ["pace", "metadata", "releases", "report"])
          expect(text, job).toContain(`\n  ${job}:\n`);
        // beta-due.ts tells a publishing run from a build by this metadata step.
        expect(text).toContain("      - name: Check the apps release is published unchanged\n");
      }),
  );

  it.effect("every suite the release workflows run is a release suite the lanes follow", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configs = (file: string) =>
        fs
          .readFileString(file)
          .pipe(
            Effect.map((text) => [
              ...new Set(
                [...text.matchAll(/--config (e2e\/[\w.-]+\.config\.ts)/g)].map(
                  (match) => match[1]!,
                ),
              ),
            ]),
          );
      const released = yield* configs(".github/workflows/release-artifacts.yml");
      expect([...released].sort()).toEqual(releaseSuiteConfigs);
      for (const config of yield* configs(".github/workflows/checks.yml"))
        expect(releaseSuiteConfigs, config).toContain(config);
    }),
  );

  it.effect(
    "the CLI suite's runner, its pinned packages and the scenario server start a check",
    () =>
      Effect.gen(function* () {
        for (const changed of [
          ["scripts/e2e-npm-packages.ts"],
          ["e2e/npm-packages.json"],
          ["e2e/run.ts"],
          ["e2e/setup.ts"],
          ["e2e/check-boundary.ts"],
          ["apps/hosted/testing/src/scenario-server.ts"],
        ]) {
          const result = yield* decideCheck({ checks: [tested], changed });
          expect(result.output, changed[0]).toBe("run=true\n");
        }
      }),
  );

  it.effect("a check whose pace passed but whose matrix did not run is no base", () =>
    Effect.gen(function* () {
      const result = yield* decideCheck({
        checks: [
          { id: 78, sha: "7".repeat(40), conclusion: "success", metadata: "skipped" },
          tested,
        ],
        changed: ["notes/ci.md"],
      });
      expect(result.output, result.log).toBe("run=false\n");
      expect(result.summary).toContain("runs/70 tests");
    }),
  );

  it.effect("a file name reaches the summary and the log quoted, whatever it holds", () =>
    Effect.gen(function* () {
      const result = yield* decideCheck({
        checks: [tested],
        changed: ["apps/cli/`x`\n::error::@someone.ts"],
      });
      expect(result.output, result.log).toBe("run=true\n");
      expect(result.summary).toContain('`"apps/cli/\\u0060x\\u0060\\n::error::@someone.ts"`');
      expect(result.log.split("\n").some((line) => line.startsWith("::"))).toBe(false);
    }),
  );
});
