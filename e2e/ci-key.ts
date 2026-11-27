import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { Console, Effect, FileSystem } from "effect";

const digest = (parts: ReadonlyArray<string>) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export const selectionKey = (outputs: string) =>
  digest([
    "selection",
    ...outputs
      .split("\n")
      .filter((line) => line !== "")
      .toSorted(),
  ]);

export const workerGrowthBlock = /^```worker-growth[ \t]*\r?\n([\s\S]*?)^```/gmu;

export const workerGrowthKey = (description: string) =>
  digest([
    "worker-growth",
    ...[...description.matchAll(workerGrowthBlock)].map(([, block]) => block!),
  ]);

export const keyedBase = (baseRef: string, defaultBranch: string, baseSha: string) =>
  baseRef === defaultBranch ? baseSha : "stacked";

export const recordKey = (tree: string, base: string, ...keys: ReadonlyArray<string>) =>
  digest(["tree", tree, "base", base, ...keys]).slice(0, 40);

export const pullRequestReads: ReadonlyArray<{
  readonly where: string;
  readonly reads: string;
  readonly covered: string;
}> = [
  {
    where: "e2e/ci-selection.ts: pulls/${input.number}",
    reads: "the description: its e2e blocks, the skip line and the deployed-stage line",
    covered:
      "The blocks and skip decide the select job's outputs, which are in the key. The deployed-stage line only decides whether select succeeds; a run whose select fails records nothing, and a run is repeated only when its select succeeded.",
  },
  {
    where: 'e2e/ci-selection.ts: "pr", "list"',
    reads: "the open pull requests based on the branch, for a skip",
    covered:
      "A skip with one writes skip=true, in the key; without one select fails and records nothing.",
  },
  {
    where: "e2e/ci-selection.ts: pulls/${pullRequest}",
    reads: "whether the pull request is a draft, read live rather than from the event",
    covered:
      "It decides the outputs draft, gate and, ready, the full suite, which are in the key, and the name of the e2e job.",
  },
  {
    where: "e2e/ci-selection.ts: pulls/${pullRequest}/commits",
    reads:
      "the title and commit messages, which the squash on main carries, for a directive that would skip main's CI",
    covered:
      "A directive fails select, which then records nothing; a run is repeated only when its select succeeded. A reworded commit is a new head, and a run on a new head is never a repeat.",
  },
  {
    where: "e2e/ci-selection.ts: commits/${compareHead}/pulls",
    reads:
      "on a push to main, the pull request that landed it, to say when it was a lower stack layer",
    covered: "Read only on a push to main, which records nothing and is never repeated.",
  },
  {
    where: "e2e/ci-selection.ts: pulls/${pullRequest}/files",
    reads: "the pull request's changed files",
    covered: "They decide the outputs, in the key.",
  },
  {
    where: "e2e/ci-selection.ts: compare/${compareBase}...${compareHead}",
    reads: "the files changed since main",
    covered: "They decide the outputs, in the key.",
  },
  {
    where: "e2e/ci-selection.ts: contents/",
    reads:
      "main's package.json, patches, test plan and guarded files, compared with the merge tree",
    covered: "They decide the outputs, in the key.",
  },
  {
    where: ".github/workflows/checks.yml: Read the pull request's description",
    reads: "the description's worker-growth blocks, read by the size gate when its job runs",
    covered:
      "The site job records the blocks it read, and a run is repeated only when that record matches the blocks this run's select read (CI_SIZED in e2e/ci-repeat.ts).",
  },
  {
    where: "scripts/ci/worker-baseline.ts: pr list --head",
    reads:
      "the stack below the pull request, the merge base with the branch it ends on, and recorded sizes, to choose what the size gate compares with",
    covered:
      "The chosen baseline (branch and commit) is in the size gate's record, which select and site each compute, so a run compared with one baseline is never reported for another.",
  },
  {
    where: ".github/workflows/checks.yml: Record what this run tests",
    reads: "the merge tree, the base commit (`keyedBase`) and the select job's two keys",
    covered: "This is the key.",
  },
  {
    where: ".github/workflows/checks.yml: github.event.pull_request.base",
    reads:
      "the base branch and commit: apps-version compares with main, and the size gate finds main's sizes at the merge base",
    covered:
      "For a pull request into main the base commit is in the key; an upper layer's selection and size baseline are keyed instead (`keyedBase`). The head commit must be the same (e2e/ci-repeat.ts).",
  },
];

export const payloadFields: Readonly<Record<string, string>> = {
  number: "The pull request is in the record's name.",
  "head.sha": "A run is repeated only from a run on the same head (e2e/ci-repeat.ts).",
  "head.ref":
    "The branch whose open pull requests decide a skip; a skip with one is the output skip=true, in the key.",
  "head.repo.full_name":
    "Whether the pull request comes from a fork, which picks the runner: the same head, so the same repository.",
  "base.sha":
    "In the key for a pull request into main (`keyedBase`); an upper layer's selection and size baseline, which it could change, are keyed instead.",
  "base.ref":
    "Whether it is main decides whether the base commit is in the key (`keyedBase`); otherwise what it decides (the selection, the size gate's baseline) is keyed itself.",
};

if (process.argv[1]?.endsWith("ci-key.ts"))
  NodeRuntime.runMain(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const [command, ...args] = process.argv.slice(2);
      if (command === "worker-growth" && args.length === 1)
        return yield* Console.log(workerGrowthKey(yield* fs.readFileString(args[0]!)));
      if (command === "record" && args.length >= 4 && args.every((arg) => arg !== ""))
        return yield* Console.log(recordKey(args[0]!, args[1]!, ...args.slice(2)));
      if (command === "key-base" && args.length === 3 && args.every((arg) => arg !== ""))
        return yield* Console.log(keyedBase(args[0]!, args[1]!, args[2]!));
      yield* Console.error(
        "Usage: node e2e/ci-key.ts worker-growth <description file>\n" +
          "       node e2e/ci-key.ts record <merge tree> <keyed base> <key>... (the selection and worker-growth keys, or sized, the worker-growth key and the baseline)\n" +
          "       node e2e/ci-key.ts key-base <base ref> <default branch> <base commit>",
      );
      process.exitCode = 2;
    }).pipe(Effect.provide(NodeServices.layer)),
  );
