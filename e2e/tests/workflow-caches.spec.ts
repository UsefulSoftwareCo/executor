/**
 * Which code can write the caches that runs on `main` restore. A run's cache entries belong to its
 * ref, and runs on `main` restore only `main`'s: so a job that runs code from another ref must never
 * run with `main`'s ref, and a run that publishes, deploys or pushes to `main` restores only caches
 * that only `main`'s own runs save, on runners that start empty. These cases read every workflow and
 * composite action as text, and each rule is also run on a small workflow it must reject.
 *
 * What they do not see: fetches made by programs other than shell scripts under `scripts/` that a
 * step starts (a `.ts` script, or a script another script calls), commands built at run time
 * (`eval`, a command held in a variable), and what an action classified in `actionKinds` does with
 * inputs other than those read here.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

interface File {
  readonly file: string;
  readonly text: string;
}

/** One step of a job or composite action: its lines, with its job and the job's `if:`. */
interface Step {
  readonly file: string;
  readonly job: string;
  readonly jobIf: string;
  readonly text: string;
}

/** The steps of a workflow (`      - ` under a job) or a composite action (`    - `). */
const stepsOf = ({ file, text }: File): ReadonlyArray<Step> => {
  const action = file.startsWith(".github/actions/");
  const start = action ? /^ {4}- / : /^ {6}- /;
  const steps: Array<Step> = [];
  let job = action ? file : "";
  let jobIf = "";
  let current: Array<string> | undefined;
  const close = () => {
    if (current !== undefined) steps.push({ file, job, jobIf, text: current.join("\n") });
    current = undefined;
  };
  for (const line of text.split("\n")) {
    const named = /^ {2}([a-z0-9-]+):$/.exec(line);
    if (!action && named !== null) {
      close();
      job = named[1]!;
      jobIf = "";
      continue;
    }
    const condition = /^ {4}if: (.*)$/.exec(line);
    if (!action && condition !== null) jobIf = condition[1]!.trim();
    if (start.test(line)) {
      close();
      current = [line];
      continue;
    }
    if (current === undefined) continue;
    const indent = line.length - line.trimStart().length;
    if (line.trim() !== "" && indent <= (action ? 4 : 6)) close();
    else current.push(line);
  }
  close();
  return steps;
};

/** A step's `key:` value, or its `if:` condition, as written. */
const field = (step: Step, name: string) =>
  new RegExp(`^\\s+(?:- )?${name}: (.*)$`, "m").exec(step.text)?.[1]?.trim() ?? "";

/** A condition's `&&` clauses, or none when any `||` lets another clause stand in for them. */
/**
 * A condition's top-level `&&` clauses, or none when a top-level `||` lets another clause stand in
 * for them. A clause in parentheses stays whole: `(a || b) && c` requires `c`.
 */
const clauses = (condition: string) => {
  const bare = condition.replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
  const parts: Array<string> = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < bare.length; index++) {
    const character = bare[index];
    if (character === "(") depth++;
    if (character === ")") depth--;
    const pair = bare.slice(index, index + 2);
    if (depth === 0 && pair === "||") return [];
    if (depth === 0 && pair === "&&") {
      parts.push(bare.slice(start, index).trim());
      start = index + 2;
    }
  }
  return [...parts, bare.slice(start).trim()];
};
const requires = (condition: string, clause: string) => clauses(condition).includes(clause);

/** The events a workflow runs on, from its `on:`. */
const triggers = (text: string): ReadonlyArray<string> => {
  const inline = /^on: (.+)$/m.exec(text)?.[1];
  if (inline !== undefined)
    return inline
      .replace(/[[\]]/g, "")
      .split(",")
      .map((e) => e.trim());
  const block = /^on:\n((?: .*\n|\n)*)/m.exec(text)?.[1] ?? "";
  return [...block.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]!);
};

/** Whether a step runs only for the `pull_request` event: by its `if:`, its job's, or the triggers. */
const pullRequestOnly = (step: Step, files: ReadonlyArray<File>) => {
  const only = "github.event_name == 'pull_request'";
  const on = triggers(files.find((file) => file.file === step.file)?.text ?? "");
  return (
    requires(field(step, "if"), only) ||
    requires(step.jobIf, only) ||
    (on.length === 1 && on[0] === "pull_request")
  );
};

/**
 * Each file's steps, all of them: a file whose steps are indented other than as `stepsOf` reads
 * them would otherwise pass every case below by yielding none. So every step `uses:` or `run:` line
 * in a file must belong to a step `stepsOf` found, and a file with `steps:` must yield at least one.
 */
const unread = (files: ReadonlyArray<File>) =>
  files.flatMap((file) => {
    const steps = stepsOf(file);
    // A job's or an output's key of the same name is not a step: steps start with `- `.
    const notStep = file.file.startsWith(".github/actions/") ? /^ {0,4}\w/ : /^ {0,6}\w/;
    const lines = file.text
      .split("\n")
      .filter((line) => /^\s+(- )?(uses|run): \S/.test(line) && !notStep.test(line)).length;
    const found = steps.filter(
      (step) => field(step, "uses") !== "" || field(step, "run") !== "",
    ).length;
    return (/^\s+steps:$/m.test(file.text) && steps.length === 0) || lines !== found
      ? [`${file.file}: ${found} of ${lines} steps with uses: or run: read`]
      : [];
  });

/**
 * Every action a step or job uses, by what it can do here. A new one fails until it is listed:
 * `caching` ones are read by `saves` and `cachesOf`, `fetching` ones by the checkout and fetch
 * cases, and `neither` moves no code or cache onto a runner. The repository's own composite
 * actions and reusable workflows are read as files of their own.
 */
const actionKinds: Record<string, "caching" | "fetching" | "neither"> = {
  "actions/cache": "caching",
  "actions/cache/restore": "caching",
  "actions/cache/save": "caching",
  "actions/setup-go": "caching",
  "actions/setup-node": "caching",
  "oven-sh/setup-bun": "caching",
  "./.github/actions/setup": "caching",
  "./.github/actions/e2e-tools": "caching",
  // The telemetry collector's build, restored and saved under its identity.
  "./.github/actions/collector": "caching",
  // rustup-init from rustup's own site, checked against the digest pinned in the action, then the
  // toolchain the collector crate pins; no code from another ref of this repository.
  "./.github/actions/rustup": "fetching",
  "actions/checkout": "fetching",
  // Another run's artifacts when given a `run-id`; see `codeFetches`.
  "actions/download-artifact": "fetching",
  "actions/upload-artifact": "neither",
  "actions/create-github-app-token": "neither",
};
const unclassified = (files: ReadonlyArray<File>) => [
  ...new Set(
    files
      .flatMap(({ text }) => [...text.matchAll(/^\s+(?:- )?uses: ([^@\s]+)/gm)])
      .map((match) => match[1]!)
      .filter((name) => !(name in actionKinds) && !name.startsWith("./.github/workflows/")),
  ),
];

/**
 * The refs a workflow may check out without running another ref's code: its own commit, `main`
 * itself, and the bases of a pull request's comparison, which are commits on `main`.
 */
const ownRefs = [
  "${{ github.sha }}",
  "${{ github.workflow_sha }}",
  "main",
  "${{ steps.lock-base.outputs.sha }}",
];
const ownRef = (ref: string) =>
  ownRefs.includes(ref) ||
  // checks.yml's apps-version: the pull request's base on main, or main itself for a stack's layer.
  ref.startsWith(
    "${{ github.event.pull_request.base.ref == github.event.repository.default_branch",
  );
/**
 * Another project's repository, checked out at a ref this repository names: only these literal
 * names. Any other `repository:`, an expression above all, may name a pull request's fork.
 */
const otherProjects = ["oven-sh/bun"];
const thisRepository = (repository: string) =>
  ["", "${{ github.repository }}", "usefulsoftwareco/executor-next"].includes(
    repository.toLowerCase(),
  );

/**
 * Checkouts of code from another ref of this repository, or from a repository a pull request may
 * name, each with whether only a pull request's own event runs it.
 */
const otherRefCheckouts = (files: ReadonlyArray<File>) =>
  files
    .flatMap(stepsOf)
    .filter((step) => field(step, "uses").startsWith("actions/checkout@"))
    .filter((step) => !otherProjects.includes(field(step, "repository")))
    .filter(
      (step) =>
        !thisRepository(field(step, "repository")) ||
        !ownRef(field(step, "ref") || "${{ github.sha }}"),
    )
    .map((step) => ({ step, limited: pullRequestOnly(step, files) }));

/**
 * The steps that can save a cache: `actions/cache` and `actions/cache/save`, and the setup actions
 * that cache unless told not to: `setup-go` by default, `setup-node` and `setup-python` when given
 * a `cache:`, and `setup-bun`, which keeps Bun itself, unless `no-cache: true`.
 */
const saves = (step: Step) => {
  const uses = field(step, "uses");
  if (/^actions\/cache(\/save)?@/.test(uses)) return true;
  if (uses.startsWith("actions/setup-go@")) return field(step, "cache") !== "false";
  if (/^actions\/setup-(node|python)@/.test(uses)) return field(step, "cache") !== "";
  if (uses.startsWith("oven-sh/setup-bun@")) return field(step, "no-cache") !== "true";
  return false;
};

/** A runner that starts empty: the provider's are all named `blacksmith-…`; the desktop's are not. */
const freshRunner = "startsWith(runner.name, 'blacksmith-')";

/**
 * Saves that a run on `main` could restore without both conditions: saved by a run on `main`, and
 * on a fresh runner, since the desktop runner keeps its disk between jobs of any ref. `setup-go`'s
 * cache is a pull request's own when it runs for one, so it needs only the fresh runner, given as
 * the value of its `cache:`.
 */
const unguardedSaves = (files: ReadonlyArray<File>) =>
  files
    .flatMap(stepsOf)
    .filter(saves)
    .filter((step) =>
      field(step, "uses").startsWith("actions/setup-go@")
        ? field(step, "cache") !== `\${{ ${freshRunner} }}`
        : !requires(field(step, "if"), "github.ref == 'refs/heads/main'") ||
          !requires(field(step, "if"), freshRunner),
    )
    .map((step) => `${step.file} ${step.job}: ${field(step, "uses")} ${field(step, "key")}`);

/**
 * The caches the workflows that publish, deploy or push to `main` may restore, each saved only by
 * runs on `main`'s ref: Bun's package cache (`.github/actions/setup`), the browsers' apt packages
 * (`.github/actions/e2e-tools`) and the oldest Node the launcher supports.
 */
const trustedCaches = ["bun-package", "e2e-apt", "oldest-node"];
const trustedWorkflows: Record<string, ReadonlyArray<string>> = {
  ".github/workflows/release-artifacts.yml": trustedCaches,
  ".github/workflows/beta.yml": trustedCaches,
  ".github/workflows/export-public.yml": trustedCaches,
  // The deploy installs from the registry, so it restores no cache at all.
  ".github/workflows/deploy.yml": [],
};

/** The caches named in `trustedCaches`, by the file that restores them and the start of its key. */
const namedCaches: ReadonlyArray<{ name: string; file?: string; key: string }> = [
  {
    name: "bun-package",
    file: ".github/actions/setup/action.yml",
    key: "${{ steps.package-cache.outputs.prefix }}",
  },
  {
    name: "e2e-apt",
    file: ".github/actions/e2e-tools/action.yml",
    key: "${{ steps.apt-cache.outputs.prefix }}",
  },
  { name: "oldest-node", key: "oldest-node-" },
];
const cacheName = (step: Step) => {
  const uses = field(step, "uses");
  const key = field(step, "key");
  const known = namedCaches.find(
    (cache) => (cache.file === undefined || cache.file === step.file) && key.startsWith(cache.key),
  );
  return known?.name ?? `${step.file}: ${uses.split("@")[0]} ${key}`;
};

/**
 * What is wrong with the collector action's cache steps: each must use exactly the target and the
 * identity `build-collector.ts --key` computes in its `key` step, with no `restore-keys` prefix
 * that could hand back another identity's build, and there must be one restore and one save.
 */
const collectorAction = ".github/actions/collector/action.yml";
const collectorKey = "collector-${{ inputs.target }}-${{ steps.key.outputs.key }}";
const collectorKeyProblems = (files: ReadonlyArray<File>) => {
  const action = files.find(({ file }) => file === collectorAction);
  if (action === undefined) return [`${collectorAction}: not read`];
  const steps = stepsOf(action);
  const cacheSteps = steps.filter((step) => /^actions\/cache(\/\w+)?@/.test(field(step, "uses")));
  const kind = (step: Step) => /^actions\/cache(?:\/(\w+))?@/.exec(field(step, "uses"))?.[1];
  const identity = steps.find((step) => field(step, "id") === "key");
  return [
    ...(identity !== undefined &&
    /build-collector\.ts --target "\$TARGET" --key\)\n\s+.*\n\s+echo "key=\$key" >> "\$GITHUB_OUTPUT"/.test(
      identity.text,
    )
      ? []
      : ["the key step does not write build-collector.ts --key's identity as its key output"]),
    ...cacheSteps.flatMap((step) => [
      ...(field(step, "key") === collectorKey
        ? []
        : [`${field(step, "uses").split("@")[0]}: key ${field(step, "key")}, not ${collectorKey}`]),
      ...(/^\s+restore-keys:/m.test(step.text)
        ? [`${field(step, "uses").split("@")[0]}: has a restore-keys prefix`]
        : []),
    ]),
    ...(["restore", "save"] as const)
      .filter((each) => cacheSteps.filter((step) => kind(step) === each).length !== 1)
      .map((each) => `not exactly one actions/cache/${each} step`),
    ...(cacheSteps.some((step) => kind(step) === undefined) ? ["an actions/cache step"] : []),
  ];
};

/** A composite action's file, by the `./.github/actions/<name>` a step uses. */
const localAction = (uses: string, files: ReadonlyArray<File>) =>
  files.find((file) =>
    [`${uses.slice(2)}/action.yml`, `${uses.slice(2)}/action.yaml`].includes(file.file),
  );

/**
 * The clauses a composite action's step runs only under: its own, and those of each step whose
 * output it requires to be set (`steps.<id>.outputs.<name> != ''`), since a skipped step sets none.
 */
const effectiveClauses = (
  step: Step,
  steps: ReadonlyArray<Step>,
  seen: ReadonlyArray<Step> = [],
): ReadonlyArray<string> =>
  clauses(field(step, "if")).flatMap((clause) => {
    const id = /^steps\.([\w-]+)\.outputs\.[\w-]+ != ''$/.exec(clause)?.[1];
    const source = steps.find((each) => field(each, "id") === id);
    return source === undefined || seen.includes(source)
      ? [clause]
      : [clause, ...effectiveClauses(source, steps, [...seen, step])];
  });

/**
 * Whether the step that uses an action switches one of its steps off on every run: that step
 * requires `inputs.<name> == '<value>'` (or `!=`), and the caller passes `<name>` as a literal that
 * fails it. A default, or a value from an expression, cannot be decided from the files, so the step
 * counts as running.
 */
const switchedOff = (inner: Step, steps: ReadonlyArray<Step>, caller: Step) =>
  effectiveClauses(inner, steps).some((clause) => {
    const input = /^inputs\.([\w-]+) (==|!=) '([^']*)'$/.exec(clause);
    if (input === null) return false;
    const [, name, operator, value] = input;
    const passed = field(caller, name!);
    if (passed === "" || passed.includes("${{")) return false;
    const literal = passed.replace(/^(["'])(.*)\1$/, "$2");
    return operator === "==" ? literal !== value : literal === value;
  });

/**
 * The caches one step restores, by name, following each composite action of this repository it
 * uses into that action's steps, at any depth. A local action that cannot be read is named as one.
 */
const cachesOf = (
  step: Step,
  files: ReadonlyArray<File>,
  depth: ReadonlyArray<string> = [],
): ReadonlyArray<string> => {
  const uses = field(step, "uses");
  if (uses.startsWith("./.github/actions/")) {
    const action = localAction(uses, files);
    if (action === undefined) return [`${uses}: not read`];
    if (depth.includes(action.file)) return [];
    const steps = stepsOf(action);
    return steps
      .filter((inner) => !switchedOff(inner, steps, step))
      .flatMap((inner) => cachesOf(inner, files, [...depth, action.file]));
  }
  if (/^actions\/cache(\/restore)?@/.test(uses) || saves(step)) return [cacheName(step)];
  return [];
};

/**
 * What each publishing, deploying or pushing workflow restores, outside its list: its own steps',
 * and those of every workflow of this repository it calls, whose inputs are not followed.
 */
const untrustedRestores = (
  files: ReadonlyArray<File>,
  workflows: ReadonlyArray<string> = Object.keys(trustedWorkflows),
) =>
  workflows.flatMap((file) => {
    const allowed = trustedWorkflows[file] ?? [];
    const reached = (name: string, seen: ReadonlyArray<string>): ReadonlyArray<File> => {
      const workflow = files.find((each) => each.file === name);
      if (workflow === undefined) return [{ file: name, text: "" }];
      const called = [...workflow.text.matchAll(/^ {4}uses: \.\/(\.github\/workflows\/\S+)/gm)]
        .map((match) => match[1]!)
        .filter((each) => !seen.includes(each));
      return [workflow, ...called.flatMap((each) => reached(each, [...seen, name, ...called]))];
    };
    return reached(file, [])
      .flatMap((workflow) =>
        workflow.text === ""
          ? [`${workflow.file}: not read`]
          : stepsOf(workflow).flatMap((step) => cachesOf(step, files)),
      )
      .filter((cache) => !allowed.includes(cache))
      .map((cache) => `${file}: ${cache}`);
  });

/** Commands that bring a ref's code, or a file from another run or release, onto the runner. */
const fetching =
  /\bgit(?: -[cC] \S+)* (fetch|checkout|clone|worktree)\b|\bgh (pr checkout|repo clone|run download|release download)\b/g;

/**
 * Each fetch in a `run:` step, or in a script under `scripts/` that one runs, that can run for an
 * event other than a pull request's own, with why what it fetches is not code from another ref.
 */
const fetchesAllowed: ReadonlyArray<{ readonly at: string; readonly why: string }> = [
  {
    at: ".github/workflows/checks.yml gh run download",
    why: "main's Worker sizes, a JSON file read as numbers to show a change",
  },
  {
    at: ".github/workflows/release-artifacts.yml git clone",
    why: "the Homebrew tap, whose formula file is rewritten and pushed; nothing in it runs",
  },
  {
    at: "scripts/export-public.sh git clone",
    why: "the public mirror's commits without their trees, as parents for the export's commit",
  },
  {
    at: 'scripts/export-public.sh git -C "$target" checkout',
    why: "an orphan branch in that clone when the mirror has none; it checks out no files",
  },
  {
    at: 'scripts/export-public.sh git -C "$target" fetch',
    why: "a ported contributor head, as a parent commit only: its files are never written or run",
  },
  {
    at: "scripts/releases/bun-runtime/fetch.sh gh release download",
    why: "the Bun runtime, which runs, but only once it matches the digest pinned on main",
  },
];

/**
 * A script a `run:` line starts, as opposed to one a message names, including one that
 * `scripts/releases/background.sh start <name>` starts in the background.
 */
const invoked =
  /^\s*(?:- run: |run: )?(?:(?:\.\/)?scripts\/releases\/background\.sh start \S+ )?(?:bash )?(?:\.\/)?(scripts\/[\w./-]+\.sh)\b/gm;

/** A shell text with its continued lines joined, so `git \` and `fetch` on the next line match. */
const joined = (text: string) => text.replace(/[ \t]*\\\n\s*/g, " ");

/**
 * The fetches in `run:` steps and the scripts they run, and downloads of another run's artifacts,
 * other than for a pull request only.
 */
const codeFetches = (files: ReadonlyArray<File>, scripts: ReadonlyArray<File>) =>
  files.flatMap(stepsOf).flatMap((step) => {
    if (pullRequestOnly(step, files)) return [];
    if (field(step, "uses").startsWith("actions/download-artifact@"))
      return field(step, "run-id") === "" ? [] : [`${step.file} actions/download-artifact run-id`];
    const start = step.text.search(/^\s+(- )?run: /m);
    if (start === -1) return [];
    const run = step.text.slice(start);
    const called = [...run.matchAll(invoked)].flatMap((match) =>
      scripts.filter((script) => script.file === match[1]),
    );
    return [{ file: step.file, text: run }, ...called].flatMap(({ file, text }) =>
      [...joined(text).matchAll(fetching)].map((match) => `${file} ${match[0]}`),
    );
  });

/** GitHub runs workflow files with either extension; anything else in the directory is a mistake. */
const workflowFile = (name: string) => /\.ya?ml$/.test(name);

const workflowFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const actions = yield* Effect.forEach(yield* fs.readDirectory(".github/actions"), (name) =>
    Effect.filter(
      ["action.yml", "action.yaml"].map((file) => path.join(".github/actions", name, file)),
      (file) => fs.exists(file),
    ),
  );
  const files = [
    ...(yield* fs.readDirectory(".github/workflows")).map((name) => `.github/workflows/${name}`),
    ...actions.flat(),
  ];
  return yield* Effect.forEach(files, (file) =>
    fs.readFileString(file).pipe(Effect.map((text): File => ({ file, text }))),
  );
});

/** The scripts under `scripts/` that the workflows' `run:` steps name. */
const calledScripts = (files: ReadonlyArray<File>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = [
      ...new Set(
        files.flatMap(({ text }) => [...text.matchAll(invoked)].map((match) => match[1]!)),
      ),
    ];
    return yield* Effect.forEach(names, (file) =>
      fs.readFileString(file).pipe(Effect.map((text): File => ({ file, text }))),
    );
  });

/** A one-job workflow for a case, its steps given as written under `steps:`. */
const workflow = (steps: string, job = "") => [
  {
    file: ".github/workflows/case.yml",
    text: `on:\n  push:\n  pull_request:\njobs:\n  case:\n    runs-on: x\n${job}    steps:\n${steps}`,
  },
];

const run = (command: string, args: ReadonlyArray<string>, env: Record<string, string>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make(command, args, { env, extendEnv: true }),
    );
    const [output, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { output, exitCode };
  }).pipe(Effect.scoped);

layer(NodeServices.layer)("Workflow caches", (it) => {
  it.effect("every step of every workflow and composite action is read", () =>
    Effect.gen(function* () {
      const files = yield* workflowFiles;
      expect(unread(files)).toEqual([]);
      expect(
        files.filter(({ file }) => file.startsWith(".github/workflows/")).length,
      ).toBeGreaterThan(10);
      // Every file in the workflows directory is one GitHub runs, and so one read here.
      expect(
        files
          .map(({ file }) => file)
          .filter((file) => file.startsWith(".github/workflows/") && !workflowFile(file)),
      ).toEqual([]);
      expect(["a.yml", "zz.yaml", "notes.md"].filter(workflowFile)).toEqual(["a.yml", "zz.yaml"]);
      // Steps listed at their key's own indent are valid YAML, and read as none.
      expect(
        unread([
          {
            file: ".github/workflows/case.yml",
            text: "jobs:\n  case:\n    steps:\n    - uses: actions/checkout@v4\n",
          },
        ]),
      ).toHaveLength(1);
      // One job read and one not still fails, file by file.
      expect(
        unread([
          {
            file: ".github/workflows/case.yml",
            text: "jobs:\n  read:\n    steps:\n      - uses: actions/checkout@v4\n  unread:\n    steps:\n    - uses: actions/checkout@v4\n",
          },
        ]),
      ).toHaveLength(1);
      // So does a step that only runs a command.
      expect(
        unread([
          {
            file: ".github/workflows/case.yml",
            text: "jobs:\n  read:\n    steps:\n      - uses: actions/checkout@v4\n  unread:\n    steps:\n    - run: git fetch\n",
          },
        ]),
      ).toHaveLength(1);
    }),
  );

  it.effect("every action the workflows use is classified by what it can do", () =>
    Effect.gen(function* () {
      expect(unclassified(yield* workflowFiles)).toEqual([]);
      expect(
        unclassified(
          workflow("      - uses: someone/cache-anything@v1\n        with:\n          path: x\n"),
        ),
      ).toEqual(["someone/cache-anything"]);
    }),
  );

  it.effect("a checkout of another ref's code runs only for that pull request's own event", () =>
    Effect.gen(function* () {
      const files = yield* workflowFiles;
      const checkouts = otherRefCheckouts(files);
      // The PR preview's checkout of the pull request's head is one; there may be others.
      expect(checkouts.map(({ step }) => step.job)).toContain("preview");
      expect(checkouts.filter(({ limited }) => !limited).map(({ step }) => step.file)).toEqual([]);

      const head = "        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n";
      const limited = (steps: string, job?: string) =>
        otherRefCheckouts(workflow(steps, job)).map((checkout) => checkout.limited);
      // A condition another event can satisfy does not limit it.
      expect(
        limited(
          `      - if: github.event_name == 'pull_request' || github.event_name == 'push'\n        uses: actions/checkout@v4\n${head}`,
        ),
      ).toEqual([false]);
      // `&&` binds first, so this holds on every event.
      expect(
        limited(
          `      - if: always() || github.ref == 'x' && github.event_name == 'pull_request'\n        uses: actions/checkout@v4\n${head}`,
        ),
      ).toEqual([false]);
      expect(
        limited(
          `      - if: \${{ github.event_name == 'pull_request' && always() }}\n        uses: actions/checkout@v4\n${head}`,
        ),
      ).toEqual([true]);
      expect(
        limited(
          `      - uses: actions/checkout@v4\n${head}`,
          "    if: github.event_name == 'pull_request'\n",
        ),
      ).toEqual([true]);
      // Naming this repository is still this repository; only a listed project is not its code.
      expect(
        limited(
          `      - uses: actions/checkout@v4\n${head}          repository: \${{ github.repository }}\n`,
        ),
      ).toEqual([false]);
      // A pull request's fork, at any ref, is that pull request's code.
      expect(
        limited(
          "      - uses: actions/checkout@v4\n        with:\n          repository: ${{ github.event.pull_request.head.repo.full_name }}\n",
        ),
      ).toEqual([false]);
      expect(
        limited(`      - uses: actions/checkout@v4\n${head}          repository: oven-sh/bun\n`),
      ).toEqual([]);
    }),
  );

  it.effect(
    "the caches a run on main may restore are saved only by runs on main, on fresh runners",
    () =>
      Effect.gen(function* () {
        const files = yield* workflowFiles;
        expect(files.flatMap(stepsOf).filter(saves).length).toBeGreaterThan(2);
        expect(unguardedSaves(files)).toEqual([]);
        expect(untrustedRestores(files)).toEqual([]);
        // On main, the composite actions say when they skip a save.
        for (const action of [".github/actions/setup", ".github/actions/e2e-tools"])
          expect(
            files
              .filter(({ file }) => file.startsWith(`${action}/`))
              .flatMap(stepsOf)
              .filter(
                (step) =>
                  requires(field(step, "if"), "github.ref == 'refs/heads/main'") &&
                  requires(field(step, "if"), `!${freshRunner}`) &&
                  step.text.includes("::warning"),
              ),
            action,
          ).toHaveLength(1);

        const guarded = `if: github.ref == 'refs/heads/main' && ${freshRunner}`;
        const save = (steps: string) => unguardedSaves(workflow(steps));
        expect(save(`      - ${guarded}\n        uses: actions/cache/save@v4\n`)).toEqual([]);
        expect(save("      - uses: actions/cache/save@v4\n")).toHaveLength(1);
        // Saved on main by the desktop runner, which keeps whatever earlier jobs left.
        expect(
          save("      - if: github.ref == 'refs/heads/main'\n        uses: actions/cache@v4\n"),
        ).toHaveLength(1);
        expect(
          save(
            `      - if: github.ref == 'refs/heads/main' || ${freshRunner}\n        uses: actions/cache@v4\n`,
          ),
        ).toHaveLength(1);
        // setup-go caches unless told not to; setup-bun keeps Bun unless told not to.
        expect(save("      - uses: actions/setup-go@v6\n")).toHaveLength(1);
        expect(
          save("      - uses: actions/setup-go@v6\n        with:\n          cache: false\n"),
        ).toEqual([]);
        expect(
          save(
            `      - uses: actions/setup-go@v6\n        with:\n          cache: \${{ ${freshRunner} }}\n`,
          ),
        ).toEqual([]);
        expect(save("      - uses: oven-sh/setup-bun@v2\n")).toHaveLength(1);
        expect(
          save("      - uses: oven-sh/setup-bun@v2\n        with:\n          no-cache: true\n"),
        ).toEqual([]);
        expect(
          untrustedRestores(
            [
              {
                file: ".github/workflows/deploy.yml",
                text: workflow("      - uses: oven-sh/setup-bun@v2\n")[0]!.text,
              },
            ],
            [".github/workflows/deploy.yml"],
          ),
        ).toEqual([
          ".github/workflows/deploy.yml: .github/workflows/deploy.yml: oven-sh/setup-bun ",
        ]);
      }),
  );

  it.effect(
    "a publishing workflow's restores are counted inside every local action it reaches",
    () =>
      Effect.gen(function* () {
        // The deploy restores nothing: it switches the setup action's package cache off.
        expect(untrustedRestores(yield* workflowFiles)).toEqual([]);
        const release = ".github/workflows/release-artifacts.yml";
        const restore = (condition: string) =>
          `    - ${condition}uses: actions/cache/restore@v4\n      with:\n        path: x\n        key: anything-\n`;
        const action = (name: string, steps: string): File => ({
          file: `.github/actions/${name}/action.yml`,
          text: `name: ${name}\nruns:\n  using: composite\n  steps:\n${steps}`,
        });
        const restores = (call: string, ...actions: ReadonlyArray<File>) =>
          untrustedRestores(
            [{ file: release, text: workflow(call)[0]!.text }, ...actions],
            [release],
          );
        const plain = action("new", restore(""));
        const guarded = action("new", restore("if: inputs.restore == 'true'\n      "));
        // An action whose name says nothing about caches.
        expect(restores("      - uses: ./.github/actions/new\n", plain)).toEqual([
          `${release}: .github/actions/new/action.yml: actions/cache/restore anything-`,
        ]);
        // Two actions down.
        expect(
          restores(
            "      - uses: ./.github/actions/outer\n",
            action("outer", "    - uses: ./.github/actions/new\n"),
            plain,
          ),
        ).toHaveLength(1);
        expect(restores("      - uses: ./.github/actions/missing\n")).toEqual([
          `${release}: ./.github/actions/missing: not read`,
        ]);
        // Behind an input: off only for a literal that fails the condition.
        const call = (value?: string) =>
          `      - uses: ./.github/actions/new\n${value === undefined ? "" : `        with:\n          restore: ${value}\n`}`;
        expect(restores(call("'false'"), guarded)).toEqual([]);
        expect(restores(call('"false"'), guarded)).toEqual([]);
        expect(restores(call(), guarded)).toHaveLength(1);
        expect(restores(call("${{ inputs.restore }}"), guarded)).toHaveLength(1);
        expect(restores(call("'true'"), guarded)).toHaveLength(1);
        // The input may switch off the step whose output the restore needs.
        const indirect = action(
          "new",
          "    - id: name\n      if: inputs.restore == 'true' && runner.os != 'Windows'\n      run: echo prefix=x >> \"$GITHUB_OUTPUT\"\n      shell: bash\n" +
            restore(
              "if: steps.name.outputs.prefix != '' && (github.ref != 'x' || always())\n      ",
            ),
        );
        expect(restores(call("'false'"), indirect)).toEqual([]);
        expect(restores(call(), indirect)).toHaveLength(1);
        // A workflow the publishing one calls is read too.
        expect(
          untrustedRestores(
            [
              {
                file: release,
                text: "jobs:\n  runtime:\n    uses: ./.github/workflows/inner.yml\n",
              },
              {
                file: ".github/workflows/inner.yml",
                text: workflow("      - uses: ./.github/actions/new\n")[0]!.text,
              },
              plain,
            ],
            [release],
          ),
        ).toHaveLength(1);
      }),
  );

  it.effect(
    "the collector's cache entry is found only by its target and its computed identity",
    () =>
      Effect.gen(function* () {
        const files = yield* workflowFiles;
        expect(collectorKeyProblems(files)).toEqual([]);
        // The same action with one change, read in place of the real one.
        const text = files.find(({ file }) => file === collectorAction)!.text;
        const changed = (from: string, to: string) => {
          expect(text, from).toContain(from);
          return collectorKeyProblems([{ file: collectorAction, text: text.replace(from, to) }]);
        };
        // Without the identity, an entry of one identity would answer for every other.
        expect(
          collectorKeyProblems([
            {
              file: collectorAction,
              text: text.replaceAll(collectorKey, "collector-${{ inputs.target }}"),
            },
          ]),
        ).toEqual([
          "actions/cache/restore: key collector-${{ inputs.target }}, not " + collectorKey,
          "actions/cache/save: key collector-${{ inputs.target }}, not " + collectorKey,
        ]);
        // Without the target, one target's build would answer for another's.
        expect(
          changed(`key: ${collectorKey}`, "key: collector-${{ steps.key.outputs.key }}"),
        ).toHaveLength(1);
        // A prefix fallback restores the newest entry of any identity.
        expect(
          changed(
            `key: ${collectorKey}`,
            `key: ${collectorKey}\n        restore-keys: collector-\${{ inputs.target }}-`,
          ),
        ).toEqual(["actions/cache/restore: has a restore-keys prefix"]);
        // The key output must be the script's identity, not some other value.
        expect(changed('echo "key=$key"', 'echo "key=${{ github.sha }}"')).toEqual([
          "the key step does not write build-collector.ts --key's identity as its key output",
        ]);
        expect(collectorKeyProblems([])).toEqual([`${collectorAction}: not read`]);
      }),
  );

  it.effect("code is fetched in a run step only for a pull request, or as listed", () =>
    Effect.gen(function* () {
      const files = yield* workflowFiles;
      const found = [...new Set(codeFetches(files, yield* calledScripts(files)))].sort();
      expect(found).toEqual(fetchesAllowed.map(({ at }) => at).sort());

      const fetches = (steps: string, job?: string) => codeFetches(workflow(steps, job), []);
      expect(fetches("      - run: git -C src fetch origin pull/1/head\n")).toEqual([
        ".github/workflows/case.yml git -C src fetch",
      ]);
      expect(fetches("      - run: |\n          gh pr checkout 1\n")).toHaveLength(1);
      expect(
        fetches("      - run: gh pr checkout 1\n", "    if: github.event_name == 'pull_request'\n"),
      ).toEqual([]);
      // A command continued onto the next line.
      expect(fetches("      - run: |\n          git \\\n            fetch origin\n")).toHaveLength(
        1,
      );
      // Another run's artifacts.
      expect(
        fetches(
          "      - uses: actions/download-artifact@v4\n        with:\n          run-id: ${{ inputs.run }}\n",
        ),
      ).toEqual([".github/workflows/case.yml actions/download-artifact run-id"]);
      expect(
        fetches("      - uses: actions/download-artifact@v4\n        with:\n          name: x\n"),
      ).toEqual([]);
      // A script a step runs as ./scripts/….
      expect(
        codeFetches(workflow("      - run: ./scripts/x.sh\n"), [
          { file: "scripts/x.sh", text: "git clone https://example.invalid/x.git\n" },
        ]),
      ).toEqual(["scripts/x.sh git clone"]);
      // A script started in the background, and the background script itself.
      expect(
        codeFetches(
          workflow("      - run: scripts/releases/background.sh start x bash scripts/x.sh\n"),
          [{ file: "scripts/x.sh", text: "git clone https://example.invalid/x.git\n" }],
        ),
      ).toEqual(["scripts/x.sh git clone"]);
      expect((yield* calledScripts(files)).map(({ file }) => file)).toContain(
        "scripts/releases/background.sh",
      );
    }),
  );

  it.effect("the Bun runtime is used only when it matches the digest pinned for it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-bun-runtime-" });
      const scripts = path.join(root, "scripts");
      const release = path.join(root, "release");
      yield* fs.makeDirectory(scripts);
      yield* fs.makeDirectory(release);
      yield* fs.copyFile("scripts/releases/bun-runtime/fetch.sh", path.join(scripts, "fetch.sh"));
      yield* fs.writeFileString(path.join(release, "bun-linux-x64"), "runtime\n");
      yield* fs.writeFileString(path.join(release, "bun-darwin-arm64"), "changed\n");
      // The first file's digest, pinned for both: the second was changed after publishing.
      const digest = createHash("sha256").update("runtime\n").digest("hex");
      yield* fs.writeFileString(
        path.join(scripts, "SHA256SUMS"),
        `${digest}  bun-runtime-x/bun-linux-x64\n${digest}  bun-runtime-x/bun-darwin-arm64\n`,
      );
      // A gh that serves the release's file named by --pattern into --dir.
      const bin = path.join(root, "bin");
      yield* fs.makeDirectory(bin);
      yield* fs.writeFileString(
        path.join(bin, "gh"),
        `#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do case "$1" in --pattern) p="$2"; shift;; --dir) d="$2"; shift;; esac; shift; done\necho "$p" >> "${root}/served"\ncp "${release}/$p" "$d/$p"\n`,
      );
      yield* fs.chmod(path.join(bin, "gh"), 0o755);
      const env = { PATH: `${bin}:${process.env["PATH"]}`, GITHUB_REPOSITORY: "o/r" };
      const fetch = (file: string, release = "bun-runtime-x") =>
        run("bash", [path.join(scripts, "fetch.sh"), release, file, path.join(root, "out")], env);

      expect((yield* fetch("bun-linux-x64")).exitCode).toBe(0);
      expect((yield* fs.stat(path.join(root, "out", "bun-linux-x64"))).mode & 0o111).not.toBe(0);
      const changed = yield* fetch("bun-darwin-arm64");
      expect(changed.exitCode).toBe(1);
      expect(changed.output).toContain("does not match its pinned digest");
      // The file that failed is not left where a later step would run it, nor anywhere else.
      expect(yield* fs.readDirectory(path.join(root, "out"))).toEqual(["bun-linux-x64"]);
      const unpinned = yield* fetch("bun-linux-x64", "bun-runtime-y");
      expect(unpinned.exitCode).toBe(1);
      expect(unpinned.output).toContain("pin.sh bun-runtime-y");
      // Nothing is downloaded for a runtime with no pin.
      expect(yield* fs.readFileString(path.join(root, "served"))).toBe(
        "bun-linux-x64\nbun-darwin-arm64\n",
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a runtime is pinned only from a release that has not changed since it was published",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-bun-pin-" });
        const git = (...args: ReadonlyArray<string>) =>
          run("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {});
        const here = path.join(root, "scripts/releases/bun-runtime");
        yield* fs.makeDirectory(here, { recursive: true });
        yield* fs.makeDirectory(path.join(root, ".github/workflows"), { recursive: true });
        yield* fs.copyFile("scripts/releases/bun-runtime/pin.sh", path.join(here, "pin.sh"));
        for (const file of ["lockdown.patch", "setup-linux.sh", "SHA256SUMS"])
          yield* fs.writeFileString(path.join(here, file), "");
        yield* fs.writeFileString(path.join(root, ".github/workflows/bun-runtime.yml"), "");
        yield* git("init", "--quiet");
        yield* git("add", "-A");
        yield* git("commit", "--quiet", "-m", "built");
        const target = (yield* git("rev-parse", "HEAD")).output.trim();

        const digest = createHash("sha256").update("runtime\n").digest("hex");
        const release = (
          assets: ReadonlyArray<{ name: string; digest: string; updated: string }>,
        ) =>
          JSON.stringify({
            draft: false,
            published_at: "2026-01-01T00:00:10Z",
            target_commitish: target,
            author: { login: "github-actions[bot]" },
            assets: assets.map((asset) => ({
              name: asset.name,
              digest: `sha256:${asset.digest}`,
              updated_at: asset.updated,
            })),
          });
        // A gh that answers the release's metadata, its SHA256SUMS and its tag.
        const bin = path.join(root, "bin");
        yield* fs.makeDirectory(bin);
        yield* fs.writeFileString(
          path.join(bin, "gh"),
          `#!/usr/bin/env bash\ncase "$1 $2" in\n  "api repos/o/r/releases/tags/"*) cat "${root}/release.json";;\n  "release download") printf '%s  bun-linux-x64\\n' "${digest}";;\n  "api repos/o/r/git/ref/tags/"*) echo "${target}";;\nesac\n`,
        );
        yield* fs.chmod(path.join(bin, "gh"), 0o755);
        const pin = (json: string) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(path.join(root, "release.json"), json);
            return yield* run("bash", [path.join(here, "pin.sh"), "bun-runtime-x"], {
              PATH: `${bin}:${process.env["PATH"]}`,
              GITHUB_REPOSITORY: "o/r",
              GIT_DIR: path.join(root, ".git"),
              GIT_WORK_TREE: root,
            });
          });
        const sums = { name: "SHA256SUMS", digest: "0", updated: "2026-01-01T00:00:05Z" };

        const changed = yield* pin(
          release([sums, { name: "bun-linux-x64", digest, updated: "2026-01-02T00:00:00Z" }]),
        );
        expect(changed.exitCode).toBe(1);
        expect(changed.output).toContain("after the release was published");
        const other = yield* pin(
          release([sums, { name: "bun-linux-x64", digest: "f".repeat(64), updated: sums.updated }]),
        );
        expect(other.exitCode).toBe(1);
        expect(other.output).toContain(`SHA256SUMS lists ${digest}`);
        expect(yield* fs.readFileString(path.join(here, "SHA256SUMS"))).toBe("");

        const pinned = yield* pin(
          release([sums, { name: "bun-linux-x64", digest, updated: sums.updated }]),
        );
        expect(pinned.exitCode, pinned.output).toBe(0);
        expect(pinned.output).toContain(`published by github-actions[bot] from commit ${target}`);
        expect(pinned.output).toContain("build inputs are the same");
        expect(yield* fs.readFileString(path.join(here, "SHA256SUMS"))).toBe(
          `${digest}  bun-runtime-x/bun-linux-x64\n`,
        );
      }).pipe(Effect.scoped),
  );
});
