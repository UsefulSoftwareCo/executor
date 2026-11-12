/**
 * The PR preview workflow's `prepare` step decides whether a pull request's preview is deployed,
 * removed because the PR closed or is a lower stack layer, or removed because the PR changes
 * nothing a preview shows. These cases run `node apps/hosted/cloud/scripts/pr-preview.ts prepare`
 * as a process with the step's environment and read the outputs file it writes, as GitHub Actions
 * does. A stub `gh` first on its PATH answers the step's reads and logs each call.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * A `gh` that answers from files beside it: the pull request (`pull`), the open pull requests based
 * on its branch (`above`) and GitHub's comparison of the default branch with its head (`compare`),
 * to which it applies the caller's `--jq` filter with the real `jq`, as `gh` does.
 */
const stubGh = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/calls"
case "$*" in
  *"/compare/"*)
    while [ $# -gt 0 ]; do
      if [ "$1" = "--jq" ]; then filter=$2; fi
      shift
    done
    exec jq -c "$filter" "$dir/compare" ;;
  *"/pulls/"*) exec cat "$dir/pull" ;;
  *) exec cat "$dir/above" ;;
esac
`;

const repository = "owner/repository";
const number = 41;
const head = "0193aee740e16d2b2f15a305e71455381d4667a5";

/** A file in GitHub's comparison, with the old path when the file was renamed. */
type Change = string | { readonly filename: string; readonly previous: string };

const prepare = (input: {
  readonly state?: "open" | "closed";
  readonly stackedAbove?: boolean;
  readonly changes?: ReadonlyArray<Change>;
  /** GitHub's whole answer to the comparison, in place of one listing `changes`. */
  readonly comparison?: unknown;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-pr-preview-" });
    const bin = path.join(directory, "bin");
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(path.join(bin, "gh"), stubGh);
    yield* fs.chmod(path.join(bin, "gh"), 0o755);
    yield* fs.writeFileString(path.join(bin, "calls"), "");
    yield* fs.writeFileString(
      path.join(bin, "pull"),
      JSON.stringify({
        state: input.state ?? "open",
        head: { sha: head, ref: "stack/top", repo: { full_name: repository } },
        base: { ref: "stack/lower", repo: { full_name: repository, default_branch: "main" } },
      }),
    );
    yield* fs.writeFileString(
      path.join(bin, "above"),
      JSON.stringify(
        input.stackedAbove === true
          ? [{ number: number + 1, head: { repo: { full_name: repository } } }]
          : [],
      ),
    );
    yield* fs.writeFileString(
      path.join(bin, "compare"),
      JSON.stringify(
        input.comparison ?? {
          status: "ahead",
          files: (input.changes ?? []).map((change) =>
            typeof change === "string"
              ? { filename: change, status: "modified" }
              : {
                  filename: change.filename,
                  previous_filename: change.previous,
                  status: "renamed",
                },
          ),
        },
      ),
    );
    const outputs = path.join(directory, "outputs");
    yield* fs.writeFileString(outputs, "");
    const child = yield* processes.spawn(
      ChildProcess.make(
        "node",
        ["apps/hosted/cloud/scripts/pr-preview.ts", "prepare", `${number}`],
        {
          env: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            GITHUB_REPOSITORY: repository,
            GITHUB_OUTPUT: outputs,
          },
        },
      ),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    const written = Object.fromEntries(
      (yield* fs.readFileString(outputs))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const calls = (yield* fs.readFileString(path.join(bin, "calls")))
      .split("\n")
      .filter((line) => line !== "");
    return { code: Number(code), stdout, stderr, outputs: written, calls };
  }).pipe(Effect.scoped);

/** The action `prepare` chose for an open, unstacked pull request with these changes. */
const action = (...changes: ReadonlyArray<Change>) =>
  prepare({ changes }).pipe(
    Effect.map((result) => {
      expect(result.code, result.stderr).toBe(0);
      return result.outputs["action"];
    }),
  );

layer(NodeServices.layer)("PR preview selection", (it) => {
  it.effect("deploys a pull request that changes the hosted product", () =>
    Effect.gen(function* () {
      const result = yield* prepare({
        changes: [
          "e2e/tests/groups.spec.ts",
          "apps/hosted/web/src/implementation/pages/groups.tsx",
        ],
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.outputs).toEqual({
        action: "deploy",
        sha: head,
        slug: `pr-${number}`,
        owner: `GitHub PR preview: ${repository}#${number}`,
        url: `https://pr-${number}.executor.engineering`,
      });
    }),
  );

  it.effect("compares a stack's top layer with the default branch, so the layers below count", () =>
    Effect.gen(function* () {
      const result = yield* prepare({
        changes: ["e2e/tests/groups.spec.ts", "apps/hosted/server/src/implementation/groups.ts"],
      });
      expect(result.outputs["action"]).toBe("deploy");
      // The pull request's base is the layer below; the comparison starts at main all the same.
      expect(result.calls).toContainEqual(expect.stringContaining(`compare/main...${head} `));
    }),
  );

  it.effect(
    "removes the preview of a pull request that changes only what a preview cannot show",
    () =>
      Effect.gen(function* () {
        expect(
          yield* action(
            "e2e/tests/groups.spec.ts",
            "e2e/ci-selection.ts",
            ".github/workflows/ci.yml",
            ".github/workflows/checks.yml",
            "notes/ci.md",
            "plans/storage.md",
            "scripts/check-patches.ts",
            "patches/alchemy.md",
            "patches/playwright-core@1.63.0.patch",
            "AGENTS.md",
            "README.md",
            "apps/hosted/cloud/AGENTS.md",
            ".agents/skills/executor-e2e/SKILL.md",
            ".oxlintrc.jsonc",
            ".gitignore",
          ),
        ).toBe("unneeded");
      }),
  );

  it.effect("leaves the self-host, local and CLI products to their own checks", () =>
    Effect.gen(function* () {
      expect(
        yield* action(
          "apps/hosted/self-host/native/main.go",
          "apps/hosted/self-host/src/mcp.ts",
          "apps/hosted/testing/self-host.ts",
          "apps/local/web/src/contracts/api.ts",
          "apps/local/desktop/src/main.ts",
          "apps/cli/src/main.ts",
        ),
      ).toBe("unneeded");
    }),
  );

  it.effect("deploys for each change a preview builds, serves or is deployed with", () =>
    Effect.gen(function* () {
      for (const file of [
        // The public site serves the built docs.
        "apps/docs/content/mcp.md",
        "apps/marketing/src/content/testimonials.ts",
        "packages/sdk/src/implementation/webhooks.ts",
        "apps/hosted/cloud/alchemy.run.ts",
        // A dependency or patch change alters what deploys.
        "bun.lock",
        "package.json",
        "patches/effect@4.0.1.patch",
        // Every stage serves the apps framework this script packs.
        "scripts/pack-test-apps.ts",
        // Only deploying a preview proves the preview workflows and the toolchain they install.
        ".github/workflows/pr-preview.yml",
        ".github/workflows/pr-previews.yml",
        ".github/actions/setup/action.yml",
        ".changeset/catalog-feed-status.md",
        "playground/demo-apps/live-inbox/app.ts",
        // A directory nobody has classified yet gets a preview.
        "services/new-product/main.ts",
        "ci-repro-layer-1.txt",
      ])
        expect(yield* action("e2e/tests/groups.spec.ts", file), file).toBe("deploy");
    }),
  );

  it.effect("deploys when a product file is renamed into a path a preview cannot show", () =>
    Effect.gen(function* () {
      expect(
        yield* action({
          filename: "e2e/support/groups.ts",
          previous: "apps/hosted/server/src/implementation/groups.ts",
        }),
      ).toBe("deploy");
    }),
  );

  it.effect("deploys when GitHub lists the most files it can, since more may be hidden", () =>
    Effect.gen(function* () {
      const files = Array.from(
        { length: 300 },
        (_, index) => `e2e/tests/generated-${index}.spec.ts`,
      );
      expect(yield* action(...files)).toBe("deploy");
      expect(yield* action(...files.slice(1))).toBe("unneeded");
    }),
  );

  it.effect("removes a closed pull request's preview without comparing its changes", () =>
    Effect.gen(function* () {
      const result = yield* prepare({ state: "closed", changes: ["apps/hosted/web/src/main.tsx"] });
      expect(result.outputs["action"]).toBe("destroy");
      expect(result.calls.filter((call) => call.includes("/compare/"))).toEqual([]);
    }),
  );

  it.effect("retires a lower stack layer's preview, whatever it changes", () =>
    Effect.gen(function* () {
      const result = yield* prepare({
        stackedAbove: true,
        changes: ["apps/hosted/web/src/main.tsx"],
      });
      expect(result.outputs["action"]).toBe("retire");
      expect(result.calls.filter((call) => call.includes("/compare/"))).toEqual([]);
    }),
  );

  it.effect("fails rather than guesses when GitHub's comparison has no file list", () =>
    Effect.gen(function* () {
      const result = yield* prepare({ comparison: { message: "Not Found" } });
      expect(result.code).not.toBe(0);
      expect(result.outputs).toEqual({});
    }),
  );
});
