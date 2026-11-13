/**
 * Which code can write the caches that runs on `main` restore. A run's cache entries belong to its
 * ref, and runs on `main` restore only `main`'s: so a job that runs code from another ref must never
 * run with `main`'s ref, and a run that publishes, deploys or pushes to `main` restores only caches
 * that only `main`'s own runs save. These cases read every workflow and composite action as text.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";

/** One step of a job or composite action: its lines, with the job it belongs to. */
interface Step {
  readonly file: string;
  readonly job: string;
  readonly text: string;
}

/** The steps of a workflow (`      - ` under a job) or a composite action (`    - `). */
const stepsOf = (file: string, text: string): ReadonlyArray<Step> => {
  const lines = text.split("\n");
  const action = file.startsWith(".github/actions/");
  const start = action ? /^ {4}- / : /^ {6}- /;
  const steps: Array<Step> = [];
  let job = action ? file : "";
  let current: Array<string> | undefined;
  const close = () => {
    if (current !== undefined) steps.push({ file, job, text: current.join("\n") });
    current = undefined;
  };
  for (const line of lines) {
    const named = /^ {2}([a-z0-9-]+):$/.exec(line);
    if (!action && named !== null) {
      close();
      job = named[1]!;
      continue;
    }
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

/** The caches one step restores, by name. */
const cachesOf = (step: Step): ReadonlyArray<string> => {
  const uses = field(step, "uses");
  if (uses === "./.github/actions/setup")
    return /dependencies: "false"|package-cache: "false"/.test(step.text) ? [] : ["bun-package"];
  if (uses === "./.github/actions/e2e-tools") return ["e2e-apt"];
  if (/^actions\/cache(\/restore)?@/.test(uses)) {
    const key = field(step, "key");
    return [key.startsWith("oldest-node-") ? "oldest-node" : `actions/cache ${key}`];
  }
  if (/^actions\/setup-(go|node|python)@/.test(uses) && /cache(-dependency-path)?:/.test(step.text))
    return [uses.split("@")[0]!];
  return [];
};

const workflowFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = [
    ...(yield* fs.readDirectory(".github/workflows"))
      .filter((name) => name.endsWith(".yml"))
      .map((name) => `.github/workflows/${name}`),
    ...(yield* fs.readDirectory(".github/actions")).map((name) =>
      path.join(".github/actions", name, "action.yml"),
    ),
  ];
  return yield* Effect.forEach(files, (file) =>
    fs.readFileString(file).pipe(Effect.map((text) => ({ file, text }))),
  );
});

layer(NodeServices.layer)("Workflow caches", (it) => {
  it.effect("a checkout of another ref's code runs only for that pull request's own event", () =>
    Effect.gen(function* () {
      const steps = (yield* workflowFiles).flatMap(({ file, text }) => stepsOf(file, text));
      const checkouts = steps.filter((step) => field(step, "uses").startsWith("actions/checkout@"));
      expect(checkouts.length).toBeGreaterThan(10);
      const other = checkouts.filter(
        (step) =>
          field(step, "repository") === "" && !ownRef(field(step, "ref") || "${{ github.sha }}"),
      );
      // The PR preview's checkout of the pull request's head is one; there may be others.
      expect(other.map((step) => step.job)).toContain("preview");
      for (const step of other)
        expect(field(step, "if"), `${step.file} ${step.job}`).toContain(
          "github.event_name == 'pull_request'",
        );
    }),
  );

  it.effect("the caches a run on main may restore are saved only by runs on main", () =>
    Effect.gen(function* () {
      const files = yield* workflowFiles;
      const steps = files.flatMap(({ file, text }) => stepsOf(file, text));
      // Every step that can save a cache, other than a pull request's own Go module cache in CI.
      const saving = steps.filter((step) => field(step, "uses").startsWith("actions/cache@"));
      expect(saving.length).toBeGreaterThan(2);
      for (const step of saving)
        expect(field(step, "if"), `${step.file} ${step.job}: ${field(step, "key")}`).toContain(
          "github.ref == 'refs/heads/main'",
        );
      // What each publishing, deploying or pushing workflow restores stays within its list.
      for (const [file, allowed] of Object.entries(trustedWorkflows)) {
        const restored = [
          ...new Set(steps.filter((step) => step.file === file).flatMap(cachesOf)),
        ].sort();
        expect(
          restored.filter((cache) => !allowed.includes(cache)),
          `${file} restores caches outside its list`,
        ).toEqual([]);
      }
    }),
  );
});
