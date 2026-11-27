import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

interface File {
  readonly file: string;
  readonly text: string;
}

interface Step {
  readonly file: string;
  readonly job: string;
  readonly jobIf: string;
  readonly text: string;
}

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

const field = (step: Step, name: string) =>
  new RegExp(`^\\s+(?:- )?${name}: (.*)$`, "m").exec(step.text)?.[1]?.trim() ?? "";

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

const pullRequestOnly = (step: Step, files: ReadonlyArray<File>) => {
  const only = "github.event_name == 'pull_request'";
  const on = triggers(files.find((file) => file.file === step.file)?.text ?? "");
  return (
    requires(field(step, "if"), only) ||
    requires(step.jobIf, only) ||
    (on.length === 1 && on[0] === "pull_request")
  );
};

const unread = (files: ReadonlyArray<File>) =>
  files.flatMap((file) => {
    const steps = stepsOf(file);
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

const actionKinds: Record<string, "caching" | "fetching" | "neither"> = {
  "actions/cache": "caching",
  "actions/cache/restore": "caching",
  "actions/cache/save": "caching",
  "actions/setup-go": "caching",
  "actions/setup-node": "caching",
  "oven-sh/setup-bun": "caching",
  "./.github/actions/setup": "caching",
  "./.github/actions/e2e-tools": "caching",
  "./.github/actions/collector": "caching",
  "./.github/actions/rustup": "fetching",
  "actions/checkout": "fetching",
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

const ownRefs = [
  "${{ github.sha }}",
  "${{ github.workflow_sha }}",
  "main",
  "${{ steps.lock-base.outputs.sha }}",
];
const ownRef = (ref: string) =>
  ownRefs.includes(ref) ||
  ref.startsWith(
    "${{ github.event.pull_request.base.ref == github.event.repository.default_branch",
  );
const otherProjects = ["oven-sh/bun"];
const thisRepository = (repository: string) =>
  ["", "${{ github.repository }}", "usefulsoftwareco/executor-next"].includes(
    repository.toLowerCase(),
  );

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

const saves = (step: Step) => {
  const uses = field(step, "uses");
  if (/^actions\/cache(\/save)?@/.test(uses)) return true;
  if (uses.startsWith("actions/setup-go@")) return field(step, "cache") !== "false";
  if (/^actions\/setup-(node|python)@/.test(uses)) return field(step, "cache") !== "";
  if (uses.startsWith("oven-sh/setup-bun@")) return field(step, "no-cache") !== "true";
  return false;
};

const freshRunner = "startsWith(runner.name, 'blacksmith-')";

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

const trustedCaches = ["bun-package", "e2e-apt", "e2e-browsers", "oldest-node"];
const trustedWorkflows: Record<string, ReadonlyArray<string>> = {
  ".github/workflows/release-artifacts.yml": trustedCaches,
  ".github/workflows/beta.yml": trustedCaches,
  ".github/workflows/export-public.yml": trustedCaches,
  ".github/workflows/deploy.yml": [],
};

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
  {
    name: "e2e-browsers",
    file: ".github/actions/e2e-tools/action.yml",
    key: "${{ steps.browser-cache.outputs.key }}",
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

const localAction = (uses: string, files: ReadonlyArray<File>) =>
  files.find((file) =>
    [`${uses.slice(2)}/action.yml`, `${uses.slice(2)}/action.yaml`].includes(file.file),
  );

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

const reachedSteps = (
  step: Step,
  files: ReadonlyArray<File>,
  depth: ReadonlyArray<string> = [],
): ReadonlyArray<Step> => {
  const uses = field(step, "uses");
  if (!uses.startsWith("./.github/actions/")) return [step];
  const action = localAction(uses, files);
  if (action === undefined) return [step];
  if (depth.includes(action.file)) return [];
  const steps = stepsOf(action);
  return steps
    .filter((inner) => !switchedOff(inner, steps, step))
    .flatMap((inner) => reachedSteps(inner, files, [...depth, action.file]));
};

const cachesOf = (step: Step, files: ReadonlyArray<File>): ReadonlyArray<string> =>
  reachedSteps(step, files).flatMap((inner) => {
    const uses = field(inner, "uses");
    if (uses.startsWith("./.github/actions/")) return [`${uses}: not read`];
    if (/^actions\/cache(\/restore)?@/.test(uses) || saves(inner)) return [cacheName(inner)];
    return [];
  });

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

const fetching =
  /\bgit(?: -[cC] \S+)* (fetch|checkout|clone|worktree)\b|\bgh (pr checkout|repo clone|run download|release download)\b|\bgh\(\[\s*"(?:pr",\s*"checkout|repo",\s*"clone|run",\s*"download|release",\s*"download)"|"git",\s*\[\s*(?:"-[cC]",\s*[^,\]]+,\s*)*"(?:fetch|checkout|clone|worktree)"/g;

const fetchesAllowed: ReadonlyArray<{
  readonly at: string;
  readonly why: string;
}> = [
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
    at: 'scripts/ci/worker-baseline.ts gh(["run", "download"',
    why: "Worker sizes, JSON the size gate reads and never runs: main's only from main's own push runs, a branch's only from CI runs of this repository's own pull requests whose sizes name the commit asked for; and, for a skip layer, the record of the run above, text read for two fields",
  },
  {
    at: "scripts/releases/bun-runtime/fetch.sh gh release download",
    why: "the Bun runtime, which runs, but only once it matches the digest pinned on main",
  },
];

const invoked =
  /^\s*(?:- run: |run: )?(?:(?:\.\/)?scripts\/releases\/background\.sh start \S+ )?(?:bash )?(?:\.\/)?(scripts\/[\w./-]+\.sh)\b|\bnode (?:\.\/)?(scripts\/[\w./-]+\.ts)\b/gm;

const scriptOf = (match: RegExpMatchArray) => (match[1] ?? match[2])!;

const joined = (text: string) => text.replace(/[ \t]*\\\n\s*/g, " ");

const codeFetches = (files: ReadonlyArray<File>, scripts: ReadonlyArray<File>) =>
  files.flatMap(stepsOf).flatMap((step) => {
    if (pullRequestOnly(step, files)) return [];
    if (field(step, "uses").startsWith("actions/download-artifact@"))
      return field(step, "run-id") === "" ? [] : [`${step.file} actions/download-artifact run-id`];
    const start = step.text.search(/^\s+(- )?run: /m);
    if (start === -1) return [];
    const run = step.text.slice(start);
    const called = [...run.matchAll(invoked)].flatMap((match) =>
      scripts.filter((script) => script.file === scriptOf(match)),
    );
    return [{ file: step.file, text: run }, ...called].flatMap(({ file, text }) =>
      [...joined(text).matchAll(fetching)].map(
        (match) => `${file} ${match[0].replace(/\[\s+/g, "[").replace(/\s+/g, " ")}`,
      ),
    );
  });

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

const calledScripts = (files: ReadonlyArray<File>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = [
      ...new Set(files.flatMap(({ text }) => [...text.matchAll(invoked)].map(scriptOf))),
    ];
    return yield* Effect.forEach(names, (file) =>
      fs.readFileString(runFrom[file] ?? file).pipe(Effect.map((text): File => ({ file, text }))),
    );
  });

const runFrom: Readonly<Record<string, string>> = {
  "scripts/pr-preview.ts": "apps/hosted/cloud/scripts/pr-preview.ts",
};

const workflow = (steps: string, job = "") => [
  {
    file: ".github/workflows/case.yml",
    text: `on:\n  push:\n  pull_request:\njobs:\n  case:\n    runs-on: x\n${job}    steps:\n${steps}`,
  },
];

const releaseWorkflow = ".github/workflows/release-artifacts.yml";
const ownDockerStore = "scripts/releases/own-docker-store.sh own /etc/docker/daemon.json";
const restoreDockerStore = "scripts/releases/own-docker-store.sh restore /etc/docker/daemon.json";
const imageCommand =
  /\bdocker (?:buildx )?(?:build|push|pull|run|load|tag|image)\b|pull-image-bases\.sh/;
const imageBuild = /\bdocker (?:buildx )?(?:build|push)\b/;
const imagePush = /\bdocker (?:buildx )?push\b/;

const sharedStoreAllowed: ReadonlyArray<{
  readonly at: string;
  readonly why: string;
}> = [
  {
    at: "collector .github/actions/collector/action.yml Smoke-test the collector on Ubuntu 22.04",
    why: "runs the collector this job built, with Node and the checkout mounted read-only, in Ubuntu 22.04 pinned by digest; it builds no image, and the release image builds its own collector from source",
  },
];

const sharedStoreUses = (files: ReadonlyArray<File>) => {
  const release = files.find(({ file }) => file === releaseWorkflow);
  if (release === undefined) return [`${releaseWorkflow}: not read`];
  const steps = stepsOf(release);
  const jobs = [...new Set(steps.map((step) => step.job))];
  return jobs.flatMap((job) => {
    const ofJob = steps.filter((step) => step.job === job);
    const reached = ofJob.map((step) =>
      reachedSteps(step, files).filter(
        (inner) =>
          !sharedStoreAllowed.some(
            ({ at }) => at === `${job} ${inner.file} ${field(inner, "name")}`,
          ),
      ),
    );
    const uses = reached.flatMap((inner, index) =>
      inner.some((each) => imageCommand.test(each.text)) ? [index] : [],
    );
    if (uses.length === 0) return [];
    const builds = reached.flat().some((each) => imageBuild.test(each.text));
    const restart = ofJob.findIndex((step) => field(step, "run") === ownDockerStore);
    const restore = ofJob.findIndex((step) => field(step, "run") === restoreDockerStore);
    const own = ofJob[restart];
    const back = ofJob[restore];
    const pushes =
      restore >= uses.at(-1)! && reached.flat().some((each) => imagePush.test(each.text));
    const upload = ofJob
      .slice(0, Math.max(restore, 0))
      .filter((step) => field(step, "uses").startsWith("actions/upload-artifact@"))
      .at(-1);
    const uploaded = upload === undefined ? "" : field(upload, "id");
    return [
      ...(builds && job !== "docker"
        ? [`${job}: builds or pushes an image outside the docker job`]
        : []),
      ...(own === undefined || restart > uses[0]!
        ? [`${job}: uses Docker before restarting it on an empty store of its own`]
        : []),
      ...(own !== undefined && field(own, "if") !== ""
        ? [`${job}: restarts Docker on its own store only if ${field(own, "if")}`]
        : []),
      ...(own !== undefined && field(own, "continue-on-error") !== ""
        ? [`${job}: carries on when Docker does not restart on its own store`]
        : []),
      ...(back === undefined
        ? [`${job}: leaves Docker on its own store at the end`]
        : [
            ...(restore < uses.at(-1)! ? [`${job}: uses Docker after putting it back`] : []),
            ...(field(back, "if") !== "always()"
              ? [`${job}: puts Docker back only if ${field(back, "if") || "the job has passed"}`]
              : []),
            ...(field(back, "continue-on-error") !== ""
              ? [`${job}: carries on when Docker is not put back`]
              : []),
            ...(pushes && uploaded === ""
              ? [`${job}: puts Docker back after a push with no digest upload it can name`]
              : []),
            ...(pushes &&
            uploaded !== "" &&
            field(back, "DIGEST_UPLOAD") !== `\${{ steps.${uploaded}.outcome }}`
              ? [`${job}: puts Docker back without the digest upload's outcome`]
              : []),
            ...(pushes && field(back, "RELEASE_PUBLISH") !== "${{ needs.metadata.outputs.publish }}"
              ? [`${job}: puts Docker back without the publish flag`]
              : []),
          ]),
    ];
  });
};

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
      expect(
        files
          .map(({ file }) => file)
          .filter((file) => file.startsWith(".github/workflows/") && !workflowFile(file)),
      ).toEqual([]);
      expect(["a.yml", "zz.yaml", "notes.md"].filter(workflowFile)).toEqual(["a.yml", "zz.yaml"]);
      expect(
        unread([
          {
            file: ".github/workflows/case.yml",
            text: "jobs:\n  case:\n    steps:\n    - uses: actions/checkout@v4\n",
          },
        ]),
      ).toHaveLength(1);
      expect(
        unread([
          {
            file: ".github/workflows/case.yml",
            text: "jobs:\n  read:\n    steps:\n      - uses: actions/checkout@v4\n  unread:\n    steps:\n    - uses: actions/checkout@v4\n",
          },
        ]),
      ).toHaveLength(1);
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
      expect(checkouts.map(({ step }) => step.job)).toContain("preview");
      expect(checkouts.filter(({ limited }) => !limited).map(({ step }) => step.file)).toEqual([]);

      const head = "        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n";
      const limited = (steps: string, job?: string) =>
        otherRefCheckouts(workflow(steps, job)).map((checkout) => checkout.limited);
      expect(
        limited(
          `      - if: github.event_name == 'pull_request' || github.event_name == 'push'\n        uses: actions/checkout@v4\n${head}`,
        ),
      ).toEqual([false]);
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
      expect(
        limited(
          `      - uses: actions/checkout@v4\n${head}          repository: \${{ github.repository }}\n`,
        ),
      ).toEqual([false]);
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
        expect(
          save("      - if: github.ref == 'refs/heads/main'\n        uses: actions/cache@v4\n"),
        ).toHaveLength(1);
        expect(
          save(
            `      - if: github.ref == 'refs/heads/main' || ${freshRunner}\n        uses: actions/cache@v4\n`,
          ),
        ).toHaveLength(1);
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
        expect(restores("      - uses: ./.github/actions/new\n", plain)).toEqual([
          `${release}: .github/actions/new/action.yml: actions/cache/restore anything-`,
        ]);
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
        const call = (value?: string) =>
          `      - uses: ./.github/actions/new\n${value === undefined ? "" : `        with:\n          restore: ${value}\n`}`;
        expect(restores(call("'false'"), guarded)).toEqual([]);
        expect(restores(call('"false"'), guarded)).toEqual([]);
        expect(restores(call(), guarded)).toHaveLength(1);
        expect(restores(call("${{ inputs.restore }}"), guarded)).toHaveLength(1);
        expect(restores(call("'true'"), guarded)).toHaveLength(1);
        const indirect = action(
          "new",
          "    - id: name\n      if: inputs.restore == 'true' && runner.os != 'Windows'\n      run: echo prefix=x >> \"$GITHUB_OUTPUT\"\n      shell: bash\n" +
            restore(
              "if: steps.name.outputs.prefix != '' && (github.ref != 'x' || always())\n      ",
            ),
        );
        expect(restores(call("'false'"), indirect)).toEqual([]);
        expect(restores(call(), indirect)).toHaveLength(1);
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
        const text = files.find(({ file }) => file === collectorAction)!.text;
        const changed = (from: string, to: string) => {
          expect(text, from).toContain(from);
          return collectorKeyProblems([{ file: collectorAction, text: text.replace(from, to) }]);
        };
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
        expect(
          changed(`key: ${collectorKey}`, "key: collector-${{ steps.key.outputs.key }}"),
        ).toHaveLength(1);
        expect(
          changed(
            `key: ${collectorKey}`,
            `key: ${collectorKey}\n        restore-keys: collector-\${{ inputs.target }}-`,
          ),
        ).toEqual(["actions/cache/restore: has a restore-keys prefix"]);
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
      expect(fetches("      - run: |\n          git \\\n            fetch origin\n")).toHaveLength(
        1,
      );
      expect(
        fetches(
          "      - uses: actions/download-artifact@v4\n        with:\n          run-id: ${{ inputs.run }}\n",
        ),
      ).toEqual([".github/workflows/case.yml actions/download-artifact run-id"]);
      expect(
        fetches("      - uses: actions/download-artifact@v4\n        with:\n          name: x\n"),
      ).toEqual([]);
      expect(
        codeFetches(workflow("      - run: ./scripts/x.sh\n"), [
          {
            file: "scripts/x.sh",
            text: "git clone https://example.invalid/x.git\n",
          },
        ]),
      ).toEqual(["scripts/x.sh git clone"]);
      expect(
        codeFetches(
          workflow("      - run: scripts/releases/background.sh start x bash scripts/x.sh\n"),
          [
            {
              file: "scripts/x.sh",
              text: "git clone https://example.invalid/x.git\n",
            },
          ],
        ),
      ).toEqual(["scripts/x.sh git clone"]);
      expect((yield* calledScripts(files)).map(({ file }) => file)).toContain(
        "scripts/releases/background.sh",
      );
      expect(
        codeFetches(workflow("      - run: node scripts/x.ts fetch\n"), [
          {
            file: "scripts/x.ts",
            text: 'yield* gh([\n  "run",\n  "download", run]);\nChildProcess.make("git", ["-C", dir, "fetch", "origin"]);\n',
          },
        ]),
      ).toEqual(['scripts/x.ts gh(["run", "download"', 'scripts/x.ts "git", ["-C", dir, "fetch"']);
      expect((yield* calledScripts(files)).map(({ file }) => file)).toContain(
        "scripts/ci/worker-baseline.ts",
      );
    }),
  );

  it.effect("the Bun runtime is used only when it matches the digest pinned for it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "executor-bun-runtime-",
      });
      const scripts = path.join(root, "scripts");
      const release = path.join(root, "release");
      yield* fs.makeDirectory(scripts);
      yield* fs.makeDirectory(release);
      yield* fs.copyFile("scripts/releases/bun-runtime/fetch.sh", path.join(scripts, "fetch.sh"));
      yield* fs.writeFileString(path.join(release, "bun-linux-x64"), "runtime\n");
      yield* fs.writeFileString(path.join(release, "bun-darwin-arm64"), "changed\n");
      const digest = createHash("sha256").update("runtime\n").digest("hex");
      yield* fs.writeFileString(
        path.join(scripts, "SHA256SUMS"),
        `${digest}  bun-runtime-x/bun-linux-x64\n${digest}  bun-runtime-x/bun-darwin-arm64\n`,
      );
      const bin = path.join(root, "bin");
      yield* fs.makeDirectory(bin);
      yield* fs.writeFileString(
        path.join(bin, "gh"),
        `#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do case "$1" in --pattern) p="$2"; shift;; --dir) d="$2"; shift;; esac; shift; done\necho "$p" >> "${root}/served"\ncp "${release}/$p" "$d/$p"\n`,
      );
      yield* fs.chmod(path.join(bin, "gh"), 0o755);
      const env = {
        PATH: `${bin}:${process.env["PATH"]}`,
        GITHUB_REPOSITORY: "o/r",
      };
      const fetch = (file: string, release = "bun-runtime-x") =>
        run("bash", [path.join(scripts, "fetch.sh"), release, file, path.join(root, "out")], env);

      expect((yield* fetch("bun-linux-x64")).exitCode).toBe(0);
      expect((yield* fs.stat(path.join(root, "out", "bun-linux-x64"))).mode & 0o111).not.toBe(0);
      const changed = yield* fetch("bun-darwin-arm64");
      expect(changed.exitCode).toBe(1);
      expect(changed.output).toContain("does not match its pinned digest");
      expect(yield* fs.readDirectory(path.join(root, "out"))).toEqual(["bun-linux-x64"]);
      const unpinned = yield* fetch("bun-linux-x64", "bun-runtime-y");
      expect(unpinned.exitCode).toBe(1);
      expect(unpinned.output).toContain("pin.sh bun-runtime-y");
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
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "executor-bun-pin-",
        });
        const git = (...args: ReadonlyArray<string>) =>
          run("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {});
        const here = path.join(root, "scripts/releases/bun-runtime");
        yield* fs.makeDirectory(here, { recursive: true });
        yield* fs.makeDirectory(path.join(root, ".github/workflows"), {
          recursive: true,
        });
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
          assets: ReadonlyArray<{
            name: string;
            digest: string;
            updated: string;
          }>,
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
        const sums = {
          name: "SHA256SUMS",
          digest: "0",
          updated: "2026-01-01T00:00:05Z",
        };

        const changed = yield* pin(
          release([sums, { name: "bun-linux-x64", digest, updated: "2026-01-02T00:00:00Z" }]),
        );
        expect(changed.exitCode).toBe(1);
        expect(changed.output).toContain("after the release was published");
        const other = yield* pin(
          release([
            sums,
            {
              name: "bun-linux-x64",
              digest: "f".repeat(64),
              updated: sums.updated,
            },
          ]),
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
  it.effect(
    "the release image is built, tested and pushed only on an empty Docker store of its job's own",
    () =>
      Effect.gen(function* () {
        const files = yield* workflowFiles;
        expect(sharedStoreUses(files)).toEqual([]);
        const release = files.find(({ file }) => file === releaseWorkflow)!;
        const collector = files.find(({ file }) => file === collectorAction)!;
        const restart = `      - name: Restart Docker on an empty store of this job's own\n        run: ${ownDockerStore}\n        env:\n          PUBLISHES: "no"\n`;
        const restore = `      - name: Put Docker back on the runner's own store\n        if: always()\n        run: ${restoreDockerStore}\n        env:\n          PUBLISHES: "no"\n          RELEASE_PUBLISH: \${{ needs.metadata.outputs.publish }}\n          DIGEST_UPLOAD: \${{ steps.digest.outcome }}\n`;
        const upload = "      - id: digest\n        uses: actions/upload-artifact@";
        expect(release.text).toContain(restart);
        expect(release.text).toContain(restore);
        expect(release.text).toContain(upload);
        const docker = stepsOf(release).filter((step) => step.job === "docker");
        expect(field(docker.at(-1)!, "run")).toBe(restoreDockerStore);
        const pull = /^ {6}- name: Pull the image's base images.*\n(?: {8}.*\n)+/m.exec(
          release.text,
        )?.[0];
        expect(pull).toContain("pull-image-bases.sh");
        const push = /^ {6}- name: Push the tested architecture.*\n(?: {8}.*\n)+/m.exec(
          release.text,
        )?.[0];
        expect(push).toContain("docker push");
        const changed = (text: string, extra: ReadonlyArray<File> = []) =>
          sharedStoreUses([
            ...files.filter(
              (file) => file !== release && !extra.some((each) => each.file === file.file),
            ),
            { file: release.file, text },
            ...extra,
          ]);
        const job = (name: string, steps: string) =>
          release.text.replace(
            "\n  publish:\n",
            `\n  ${name}:\n    runs-on: x\n    steps:\n${steps}\n  publish:\n`,
          );
        const before = "docker: uses Docker before restarting it on an empty store of its own";

        expect(changed(release.text.replace(restart, ""))).toEqual([before]);
        expect(changed(release.text.replace(restart, "").replace(pull!, pull! + restart))).toEqual([
          before,
        ]);
        expect(
          changed(
            release.text.replace(
              restart,
              restart.replace("        run:", "        if: false\n        run:"),
            ),
          ),
        ).toEqual(["docker: restarts Docker on its own store only if false"]);
        expect(
          changed(release.text.replace(restart, restart + "        continue-on-error: true\n")),
        ).toEqual(["docker: carries on when Docker does not restart on its own store"]);

        expect(changed(release.text.replace(restore, ""))).toEqual([
          "docker: leaves Docker on its own store at the end",
        ]);
        expect(changed(release.text.replace(restore, "").replace(push!, restore + push!))).toEqual([
          "docker: uses Docker after putting it back",
        ]);
        expect(
          changed(release.text.replace(restore, restore.replace("always()", "success()"))),
        ).toEqual(["docker: puts Docker back only if success()"]);
        expect(
          changed(release.text.replace(restore, restore.replace("        if: always()\n", ""))),
        ).toEqual(["docker: puts Docker back only if the job has passed"]);
        expect(
          changed(release.text.replace(restore, restore + "        continue-on-error: true\n")),
        ).toEqual(["docker: carries on when Docker is not put back"]);
        const outcome = "          DIGEST_UPLOAD: ${{ steps.digest.outcome }}\n";
        const flag = "          RELEASE_PUBLISH: ${{ needs.metadata.outputs.publish }}\n";
        const withoutOutcome = "docker: puts Docker back without the digest upload's outcome";
        const withoutFlag = "docker: puts Docker back without the publish flag";
        expect(changed(release.text.replace(outcome, ""))).toEqual([withoutOutcome]);
        expect(
          changed(release.text.replace(outcome, outcome.replace("steps.digest", "steps.other"))),
        ).toEqual([withoutOutcome]);
        expect(
          changed(release.text.replace(outcome, "          DIGEST_UPLOAD: success\n")),
        ).toEqual([withoutOutcome]);
        expect(changed(release.text.replace(flag, ""))).toEqual([withoutFlag]);
        expect(changed(release.text.replace(flag, "          RELEASE_PUBLISH: true\n"))).toEqual([
          withoutFlag,
        ]);
        expect(
          changed(release.text.replace(upload, "      - uses: actions/upload-artifact@")),
        ).toEqual(["docker: puts Docker back after a push with no digest upload it can name"]);
        expect(
          changed(
            release.text.replace(
              upload,
              "      - id: other\n        uses: actions/upload-artifact@",
            ),
          ),
        ).toEqual([withoutOutcome]);

        expect(
          changed(job("rebuild", '      - run: docker build --tag "$IMAGE:$VERSION" .\n')),
        ).toEqual([
          "rebuild: builds or pushes an image outside the docker job",
          "rebuild: uses Docker before restarting it on an empty store of its own",
          "rebuild: leaves Docker on its own store at the end",
        ]);
        const hidden: File = {
          file: ".github/actions/case/action.yml",
          text: "runs:\n  using: composite\n  steps:\n    - name: Start a container\n      shell: bash\n      run: docker run --rm node:24-bookworm-slim true\n",
        };
        expect(changed(job("hidden", "      - uses: ./.github/actions/case\n"), [hidden])).toEqual([
          "hidden: uses Docker before restarting it on an empty store of its own",
          "hidden: leaves Docker on its own store at the end",
        ]);
        expect(
          changed(release.text, [
            {
              file: collector.file,
              text: collector.text.replace(
                "- name: Smoke-test the collector on Ubuntu 22.04",
                "- name: Smoke-test the collector in a container",
              ),
            },
          ]),
        ).toEqual([
          "collector: uses Docker before restarting it on an empty store of its own",
          "collector: leaves Docker on its own store at the end",
        ]);
        expect(
          changed(
            job(
              "manifest",
              '      - run: docker buildx imagetools inspect "$IMAGE:$VERSION" --raw\n',
            ),
          ),
        ).toEqual([]);
        for (const { at } of sharedStoreAllowed) {
          const [name, file, ...step] = at.split(" ");
          const action = files.find((each) => each.file === file)!;
          const found = stepsOf(action).find((each) => field(each, "name") === step.join(" "));
          expect(found?.text, at).toMatch(imageCommand);
          expect(release.text, at).toMatch(new RegExp(`^  ${name}:$`, "m"));
        }
      }),
  );

  it.effect("Docker moves to an empty store of the job's own and back, or the step fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "executor-docker-store-",
      });
      const bin = path.join(root, "bin");
      const temp = path.join(root, "temp");
      const state = path.join(root, "state");
      const config = path.join(root, "etc/docker/daemon.json");
      const own = path.join(temp, "docker-store");
      const shared = "/var/lib/docker";
      const stub = (name: string, body: string) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
          yield* fs.chmod(path.join(bin, name), 0o755);
        });
      yield* fs.makeDirectory(bin);
      yield* stub("sudo", 'exec "$@"');
      yield* stub("journalctl", "echo journal");
      yield* stub(
        "systemctl",
        [
          `state="${state}"`,
          `echo "$*" >> "$state/systemctl"`,
          `case "$1" in`,
          `  stop) rm -f "$state/running";;`,
          `  start) case "$(cat "$state/start")" in`,
          `      fail) exit 1;;`,
          `      hang) exec sleep 30;;`,
          `    esac`,
          `    if [[ -s "$state/start-root" ]]; then cat "$state/start-root" > "$state/running"`,
          `    else configured=$(jq -r '.["data-root"] // empty' "${config}" 2>/dev/null || true)`,
          `      echo "\${configured:-${shared}}" > "$state/running"; fi;;`,
          `esac`,
        ].join("\n"),
      );
      yield* stub(
        "docker",
        [
          `state="${state}"`,
          `[[ -s "$state/running" ]] || exit 1`,
          `running=$(cat "$state/running")`,
          `case "$1 $2" in`,
          `  "info --format") case "$3" in`,
          `      *DockerRootDir*) echo "$running";;`,
          `      *DriverStatus*) cat "$state/status";;`,
          `      *Driver*) cat "$state/driver";;`,
          `    esac;;`,
          `  "info ") n=$(cat "$state/unready"); if ((n > 0)); then echo $((n - 1)) > "$state/unready"; exit 1; fi;;`,
          `  "image ls") if [[ "$running" == "${shared}" ]]; then cat "$state/shared-images"; fi;;`,
          `  "system df") cat "$state/df";;`,
          `esac`,
        ].join("\n"),
      );
      const reset = (
        options: {
          readonly config?: string;
          readonly mode?: number;
          readonly status?: string;
          readonly df?: string;
        } = {},
      ) =>
        Effect.gen(function* () {
          yield* fs.remove(state, { recursive: true, force: true });
          yield* fs.remove(temp, { recursive: true, force: true });
          yield* fs.remove(path.dirname(config), {
            recursive: true,
            force: true,
          });
          yield* fs.makeDirectory(state, { recursive: true });
          yield* fs.makeDirectory(temp, { recursive: true });
          yield* fs.makeDirectory(path.dirname(config), { recursive: true });
          if (options.config !== undefined) {
            yield* fs.writeFileString(config, options.config);
            yield* fs.chmod(config, options.mode ?? 0o644);
          }
          yield* fs.writeFileString(path.join(state, "running"), `${shared}\n`);
          yield* fs.writeFileString(path.join(state, "shared-images"), "sha256:a\nsha256:b\n");
          yield* fs.writeFileString(path.join(state, "driver"), "overlay2\n");
          yield* fs.writeFileString(
            path.join(state, "status"),
            `${options.status ?? '[["Backing Filesystem","extfs"]]'}\n`,
          );
          yield* fs.writeFileString(
            path.join(state, "df"),
            options.df ?? "Images=0\nContainers=0\nLocal Volumes=0\nBuild Cache=0\n",
          );
          yield* fs.writeFileString(path.join(state, "start"), "ok");
          yield* fs.writeFileString(path.join(state, "unready"), "0");
          yield* fs.writeFileString(path.join(state, "systemctl"), "");
        });
      const set = (name: string, value: string) =>
        fs.writeFileString(path.join(state, name), value);
      const script = (mode: string, env: Record<string, string> = {}) =>
        run("bash", ["scripts/releases/own-docker-store.sh", mode, config], {
          PATH: `${bin}:${process.env["PATH"]}`,
          RUNNER_TEMP: temp,
          ...env,
        });
      const systemctl = () => fs.readFileString(path.join(state, "systemctl"));
      const mode = () => fs.stat(config).pipe(Effect.map((info) => info.mode & 0o777));
      const restart = "stop docker.socket docker.service\nstart docker.service\n";

      const original =
        '{\n  "registry-mirrors": ["https://mirror.test"],\n  "data-root": "/var/lib/docker"\n}\n';
      yield* reset({ config: original, mode: 0o640 });
      const moved = yield* script("own");
      expect(moved.exitCode, moved.output).toBe(0);
      expect(moved.output).toContain(`Docker ran on ${shared} with 2 images`);
      expect(moved.output).toContain(`Restarted on an empty ${own} in`);
      expect(JSON.parse(yield* fs.readFileString(config))).toEqual({
        "registry-mirrors": ["https://mirror.test"],
        "data-root": own,
      });
      expect(yield* mode()).toBe(0o640);
      expect(yield* systemctl()).toBe(restart);
      expect((yield* fs.readDirectory(path.dirname(config))).sort()).toEqual(["daemon.json"]);
      const back = yield* script("restore");
      expect(back.exitCode, back.output).toBe(0);
      expect(back.output).toContain(`Put back ${config} as this job found it`);
      expect(back.output).toContain(
        `Docker is back on ${shared} with the 2 images it had before this job`,
      );
      expect(yield* fs.readFileString(config)).toBe(original);
      expect(yield* mode()).toBe(0o640);
      expect(yield* systemctl()).toBe(restart + restart);

      yield* reset();
      const created = yield* script("own");
      expect(created.exitCode, created.output).toBe(0);
      expect(JSON.parse(yield* fs.readFileString(config))).toEqual({
        "data-root": own,
      });
      const removed = yield* script("restore");
      expect(removed.exitCode, removed.output).toBe(0);
      expect(removed.output).toContain(`Removed ${config}, which this job created`);
      expect(yield* fs.exists(config)).toBe(false);

      yield* reset({ config: " \n" });
      const blank = yield* script("own");
      expect(blank.exitCode, blank.output).toBe(0);
      expect(JSON.parse(yield* fs.readFileString(config))).toEqual({
        "data-root": own,
      });
      expect((yield* script("restore")).exitCode).toBe(0);
      expect(yield* fs.readFileString(config)).toBe(" \n");

      for (const malformed of ['{"debug": true', '{"debug": true}\n{"debug": false}', "[]"]) {
        yield* reset({ config: malformed });
        const refused = yield* script("own");
        expect(refused.exitCode, malformed).toBe(1);
        expect(refused.output).toContain(
          `::error::${config} is not one JSON object; it is left as it is and Docker is not restarted`,
        );
        expect(yield* fs.readFileString(config)).toBe(malformed);
        expect(yield* systemctl()).toBe("");
        const untouched = yield* script("restore");
        expect(untouched.exitCode, untouched.output).toBe(0);
        expect(untouched.output).toContain("nothing to restore");
        expect(yield* fs.readFileString(config)).toBe(malformed);
        expect(yield* systemctl()).toBe("");
      }

      yield* reset({ config: "{}" });
      yield* set("unready", "3");
      const slow = yield* script("own");
      expect(slow.exitCode, slow.output).toBe(0);
      expect(slow.output).toContain(`Restarted on an empty ${own} in`);

      yield* reset({ config: "{}" });
      yield* set("unready", "1000");
      const silent = yield* script("own", { DOCKER_START_TIMEOUT: "2" });
      expect(silent.exitCode).toBe(1);
      expect(silent.output).toContain(
        `::error::Docker started on ${own} but did not answer within 2 s`,
      );

      yield* reset({ config: "{}" });
      yield* set("start", "hang");
      const hung = yield* script("own", { DOCKER_START_TIMEOUT: "1" });
      expect(hung.exitCode).toBe(1);
      expect(hung.output).toContain(`::error::Docker did not start on ${own} within 1 s`);
      expect(hung.output).toContain("journal");

      for (const refusal of [
        { start: shared },
        { status: '[["driver-type","io.containerd.snapshotter.v1"]]' },
        { df: "Images=3\nContainers=0\nLocal Volumes=0\nBuild Cache=0\n" },
        { df: "Images=0\nContainers=0\nLocal Volumes=0\nBuild Cache=12\n" },
        { df: "" },
      ]) {
        yield* reset({ config: "{}", ...refusal });
        if (refusal.start !== undefined) yield* set("start-root", refusal.start);
        const refused = yield* script("own");
        expect(refused.exitCode, JSON.stringify(refusal)).toBe(1);
        expect(refused.output).toContain(
          "::error::Docker does not run on an empty store of this job's own",
        );
      }

      yield* reset({ config: '{"debug": true}' });
      yield* set("start", "fail");
      const stopped = yield* script("own");
      expect(stopped.exitCode).toBe(1);
      expect(stopped.output).toContain(
        `::error::Docker did not start on ${own} (systemctl exited 1)`,
      );
      expect(JSON.parse(yield* fs.readFileString(config))).toEqual({
        debug: true,
        "data-root": own,
      });
      yield* set("start", "ok");
      const recovered = yield* script("restore");
      expect(recovered.exitCode, recovered.output).toBe(0);
      expect(recovered.output).toContain(`Docker is back on ${shared} with the 2 images`);
      expect(yield* fs.readFileString(config)).toBe('{"debug": true}');

      yield* reset({ config: "{}" });
      expect((yield* script("own")).exitCode).toBe(0);
      const build = yield* run(
        "bash",
        ["-c", 'docker info >/dev/null && echo "the build failed" && exit 1'],
        { PATH: `${bin}:${process.env["PATH"]}` },
      );
      expect(build.exitCode).toBe(1);
      const afterFailure = yield* script("restore");
      expect(afterFailure.exitCode, afterFailure.output).toBe(0);
      expect(afterFailure.output).toContain(`Docker runs on ${shared} again with 2 images`);
      expect(yield* fs.readFileString(config)).toBe("{}");

      yield* reset({ config: "{}" });
      expect((yield* script("own")).exitCode).toBe(0);
      yield* set("start-root", own);
      const stuck = yield* script("restore");
      expect(stuck.exitCode).toBe(1);
      expect(stuck.output).toContain(
        `::error::Docker runs on ${own}, not on its original data directory ${shared}`,
      );

      yield* reset({ config: "{}" });
      expect((yield* script("own")).exitCode).toBe(0);
      yield* set("shared-images", "sha256:a\nsha256:b\nsha256:built\n");
      const grown = yield* script("restore");
      expect(grown.exitCode).toBe(1);
      expect(grown.output).toContain(
        `::error::Docker on ${shared} holds other images than it did before this job`,
      );

      const published = { RELEASE_PUBLISH: "true", DIGEST_UPLOAD: "success" };
      const notRestored =
        "::warning title=Runner Docker store not restored::Putting Docker back on the runner's own store failed (own-docker-store.sh restore exited 1), so the runner's Docker store was not restored. This architecture's image is pushed and its digest uploaded, so the release continues.";
      const failedRestores = [
        {
          break: () => set("start", "fail"),
          says: `Docker did not start on ${shared} (systemctl exited 1)`,
        },
        {
          break: () => set("shared-images", "sha256:a\nsha256:b\nsha256:built\n"),
          says: `Docker on ${shared} holds other images than it did before this job`,
        },
      ];
      for (const failed of failedRestores) {
        yield* reset({ config: "{}" });
        expect((yield* script("own")).exitCode).toBe(0);
        yield* failed.break();
        const warned = yield* script("restore", published);
        expect(warned.exitCode, warned.output).toBe(0);
        expect(warned.output).toContain(`::warning::${failed.says}`);
        expect(warned.output).toContain(notRestored);
        expect(warned.output).not.toContain("::error::");

        for (const env of [
          {},
          { RELEASE_PUBLISH: "false", DIGEST_UPLOAD: "skipped" },
          { RELEASE_PUBLISH: "", DIGEST_UPLOAD: "" },
          { RELEASE_PUBLISH: "false", DIGEST_UPLOAD: "success" },
          { RELEASE_PUBLISH: "true", DIGEST_UPLOAD: "failure" },
          { RELEASE_PUBLISH: "true", DIGEST_UPLOAD: "skipped" },
          { RELEASE_PUBLISH: "true", DIGEST_UPLOAD: "cancelled" },
          { RELEASE_PUBLISH: "true", DIGEST_UPLOAD: "" },
        ]) {
          const strict = yield* script("restore", env);
          expect(strict.exitCode, JSON.stringify(env)).toBe(1);
          expect(strict.output).toContain(`::error::${failed.says}`);
          expect(strict.output).not.toContain("::warning");
        }
      }

      yield* reset({ config: '{"debug": true}' });
      expect((yield* script("own", published)).exitCode).toBe(0);
      const restored = yield* script("restore", published);
      expect(restored.exitCode, restored.output).toBe(0);
      expect(restored.output).toContain(`Put back ${config} as this job found it`);
      expect(restored.output).toContain(
        `Docker is back on ${shared} with the 2 images it had before this job`,
      );
      expect(restored.output).not.toContain("::warning");
      expect(restored.output).not.toContain("::error::");
      expect(yield* fs.readFileString(config)).toBe('{"debug": true}');
      expect(yield* systemctl()).toBe(restart + restart);
    }).pipe(Effect.scoped),
  );
});
