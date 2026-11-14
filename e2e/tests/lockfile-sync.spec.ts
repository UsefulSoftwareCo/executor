/**
 * `scripts/check-lockfile.ts` fails a pull request that leaves bun.lock stale itself, and only
 * that one; `scripts/releases/lock-repair.sh`, which the beta workflow runs on main, refreshes a
 * stale lock that reached main and pushes it. These cases run both in scratch Bun workspaces whose
 * packages have no dependencies, with the registry pointed at a closed port, so they also show that
 * neither needs the network.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const run = (
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
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
  const check = path.resolve("scripts/check-lockfile.ts");
  const repair = path.resolve("scripts/releases/lock-repair.sh");
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-lockfile-" });
  const gitConfig = path.join(root, "gitconfig");
  yield* fs.writeFileString(
    gitConfig,
    "[init]\n\tdefaultBranch = main\n[user]\n\tname = Maintainer\n\temail = maintainer@example.com\n",
  );
  const env = {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    BUN_CONFIG_REGISTRY: "http://127.0.0.1:9/",
    NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/",
    BUN_INSTALL_CACHE_DIR: path.join(root, "bun-cache"),
    RUNNER_TEMP: root,
  };
  const ok = (cwd: string, command: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const result = yield* run(cwd, command, args, env);
      expect(result.exitCode, `${command} ${args.join(" ")}: ${result.output}`).toBe(0);
      return result.output.trim();
    });
  const manifest = (name: string, version: string) =>
    `${JSON.stringify({ name, version }, null, 2)}\n`;
  const setVersion = (checkout: string, name: string, version: string) =>
    fs.writeFileString(
      path.join(checkout, "packages", name, "package.json"),
      manifest(name, version),
    );
  const lock = (checkout: string) => fs.readFileString(path.join(checkout, "bun.lock"));
  /** Records the version in package.json, and so bun.lock, as `bun install` would. */
  const install = (checkout: string) => ok(checkout, "bun", ["install", "--lockfile-only"]);
  const commit = (checkout: string, message: string) =>
    Effect.gen(function* () {
      yield* ok(checkout, "git", ["add", "--all"]);
      yield* ok(checkout, "git", ["commit", "--quiet", "-m", message]);
    });

  /** A workspace with packages `a` and `b` at 1.0.0 and a fresh lock, committed in a new repository. */
  const checkout = (name: string) =>
    Effect.gen(function* () {
      const directory = path.join(root, name);
      for (const pkg of ["a", "b"])
        yield* fs.makeDirectory(path.join(directory, "packages", pkg), { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "package.json"),
        `${JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, 2)}\n`,
      );
      yield* fs.writeFileString(path.join(directory, ".gitignore"), "node_modules\n");
      yield* setVersion(directory, "a", "1.0.0");
      yield* setVersion(directory, "b", "1.0.0");
      yield* ok(directory, "git", ["init", "--quiet"]);
      yield* install(directory);
      yield* commit(directory, "Start");
      return directory;
    });

  /** The pull request check with `head` as the pull request's tree and `base` as its base. */
  const checkPullRequest = (head: string, base: string) =>
    Effect.gen(function* () {
      const before = [yield* lock(head), yield* lock(base)];
      const result = yield* run(head, "node", [check, "--base", base], env);
      // The check never edits either checkout.
      expect([yield* lock(head), yield* lock(base)]).toEqual(before);
      return result;
    });

  /** A bare remote holding `main`'s history, as GitHub does. */
  const remoteFor = (main: string) =>
    Effect.gen(function* () {
      const remote = path.join(root, `${path.basename(main)}.git`);
      yield* ok(root, "git", ["clone", "--quiet", "--bare", main, remote]);
      return remote;
    });
  /** Reads a GITHUB_OUTPUT file into its keys and values. */
  const outputsOf = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) =>
        Object.fromEntries(
          text
            .split("\n")
            .filter(Boolean)
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
        ),
      ),
    );
  /** Runs one step of the repair, as beta.yml does, with its own output file. */
  const repairStep = (
    main: string,
    args: ReadonlyArray<string>,
    extra: Record<string, string> = {},
  ) =>
    Effect.gen(function* () {
      const output = path.join(root, `repair-output-${args[0]}`);
      const summary = path.join(root, `repair-summary-${args[0]}`);
      yield* fs.writeFileString(output, "");
      yield* fs.writeFileString(summary, "");
      const result = yield* run(main, repair, args, {
        ...env,
        ...extra,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      });
      return {
        ...result,
        outputs: yield* outputsOf(output),
        summary: yield* fs.readFileString(summary),
      };
    });
  /**
   * The workflow's two steps: `prepare`, then `push` when `prepare` made a refresh. `between` runs
   * in between, as anything else in the job could.
   */
  const repairMain = (
    main: string,
    remote: string,
    between: Effect.Effect<void, never, FileSystem.FileSystem> = Effect.void,
  ) =>
    Effect.gen(function* () {
      // Each tick is a new job, with an empty RUNNER_TEMP.
      yield* fs.remove(path.join(root, "lock-repair-refused.md"), { force: true });
      const prepared = yield* repairStep(main, ["prepare"]);
      expect(prepared.exitCode, prepared.output).toBe(0);
      if (prepared.outputs.ready !== "true")
        return { prepared, pushed: undefined, summary: prepared.summary, output: prepared.output };
      yield* between;
      const pushed = yield* repairStep(main, [
        "push",
        prepared.outputs.start ?? "",
        prepared.outputs.commit ?? "",
        remote,
      ]);
      expect(pushed.exitCode, pushed.output).toBe(0);
      return {
        prepared,
        pushed,
        summary: prepared.summary + pushed.summary,
        output: prepared.output + pushed.output,
      };
    });
  const remoteHead = (remote: string) => ok(remote, "git", ["rev-parse", "main"]);
  /** Rewrites the committed lock's text, as a hand edit or a bad merge would. */
  const editLock = (checkout: string, edit: (text: string) => string) =>
    Effect.gen(function* () {
      const text = yield* lock(checkout);
      const edited = edit(text);
      expect(edited).not.toBe(text);
      yield* fs.writeFileString(path.join(checkout, "bun.lock"), edited);
    });
  /**
   * Repairs `main` and checks that nothing was pushed or left behind: the remote and the checkout
   * are where they were, bun.lock is as committed, and the run warned and wrote `found` to the
   * run summary.
   */
  const refused = (main: string, found: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const remote = yield* remoteFor(main);
      const before = yield* remoteHead(remote);
      const committed = yield* lock(main);
      const result = yield* repairMain(main, remote);
      expect(result.output).toContain("::warning::");
      expect(result.prepared.outputs).toEqual({ refused: "true" });
      expect(result.pushed).toBeUndefined();
      expect(yield* remoteHead(remote)).toBe(before);
      expect(yield* ok(main, "git", ["rev-parse", "HEAD"])).toBe(before);
      expect(yield* ok(main, "git", ["status", "--porcelain"])).toBe("");
      expect(yield* lock(main)).toBe(committed);
      expect(result.summary).toContain("### bun.lock not refreshed");
      for (const line of found) expect(result.summary).toContain(line);
      return result;
    });

  /**
   * A stub `gh` that holds at most one open issue in $FAKE_GH: `open` has its number, `body` its
   * body, `calls` every command. It also stubs the `bun` that a case may wrap.
   */
  const bin = path.join(root, "bin");
  const gh = path.join(root, "gh");
  yield* fs.makeDirectory(bin, { recursive: true });
  yield* fs.makeDirectory(gh, { recursive: true });
  yield* fs.writeFileString(
    path.join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> "$FAKE_GH/calls"
case "$1 $2" in
  "issue list") [ -f "$FAKE_GH/open" ] && cat "$FAKE_GH/open" || true ;;
  "issue view") cat "$FAKE_GH/body" ;;
  "issue edit") while [ "$1" != --body-file ]; do shift; done; cp "$2" "$FAKE_GH/body" ;;
  "issue close") rm "$FAKE_GH/open" ;;
  "issue create") while [ "$1" != --body-file ]; do shift; done; cp "$2" "$FAKE_GH/body"; echo 7 > "$FAKE_GH/open"; echo "https://github.com/example/repo/issues/7" ;;
  "label create") ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`,
  );
  yield* fs.chmod(path.join(bin, "gh"), 0o755);
  const issue = path.resolve("scripts/releases/lock-repair-issue.sh");
  /** Runs the workflow's issue step after a tick, with the steps' outcomes and outputs. */
  const issueStep = (
    main: string,
    tick: {
      readonly prepared?: { readonly outputs: Record<string, string> };
      readonly pushed?: { readonly outputs: Record<string, string> } | undefined;
    },
    outcomes: { readonly lock?: string; readonly push?: string } = {},
  ) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(path.join(gh, "calls"), "");
      const p = tick.prepared?.outputs ?? {};
      const q = tick.pushed?.outputs ?? {};
      const result = yield* run(main, issue, [], {
        ...env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        FAKE_GH: gh,
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_RUN_ID: "100",
        LOCK_OUTCOME: outcomes.lock ?? "success",
        PUSH_OUTCOME: outcomes.push ?? (tick.pushed ? "success" : "skipped"),
        REFUSED: p.refused || q.refused || "",
        FRESH: p.fresh ?? "",
        PUSHED: q.pushed ?? "",
      });
      expect(result.exitCode, result.output).toBe(0);
      const read = (name: string) =>
        fs.readFileString(path.join(gh, name)).pipe(Effect.orElseSucceed(() => ""));
      return {
        ...result,
        calls: (yield* read("calls")).split("\n").filter(Boolean),
        open: (yield* read("open")).trim(),
        body: yield* read("body"),
      };
    });

  return {
    bin,
    check,
    checkout,
    checkPullRequest,
    commit,
    env,
    install,
    lock,
    ok,
    editLock,
    issueStep,
    refused,
    remoteFor,
    remoteHead,
    repairMain,
    repairStep,
    root,
    setVersion,
  };
});

layer(NodeServices.layer, { excludeTestServices: true })("bun.lock stays in sync", (it) => {
  it.effect("a pull request that bumps a workspace version without the lock fails", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const base = yield* w.checkout("base");
      const head = yield* w.checkout("head");
      yield* w.setVersion(head, "a", "1.0.1");
      const result = yield* w.checkPullRequest(head, base);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(
        "::error file=bun.lock::This pull request changes packages/a/package.json but leaves bun.lock different from what `bun install` writes",
      );
      expect(result.output).toContain("Run `bun install` and commit bun.lock.");
      expect(result.output).toMatch(/^\+ +"version": "1\.0\.1",$/m);
    }).pipe(Effect.scoped),
  );

  it.effect("the same bump passes once `bun install` records it", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const base = yield* w.checkout("base");
      const head = yield* w.checkout("head");
      yield* w.setVersion(head, "a", "1.0.1");
      yield* w.install(head);
      const result = yield* w.checkPullRequest(head, base);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("bun.lock is what `bun install` writes.");
    }).pipe(Effect.scoped),
  );

  it.effect("a stale lock on main fails no pull request that leaves the lock alone", () =>
    Effect.gen(function* () {
      const w = yield* world;
      // Main took a bump of `a` without the lock, from a pull request that passed earlier.
      const base = yield* w.checkout("base");
      yield* w.setVersion(base, "a", "1.0.1");
      const head = yield* w.checkout("head");
      yield* w.setVersion(head, "a", "1.0.1");
      const unrelated = yield* w.checkPullRequest(head, base);
      expect(unrelated.exitCode).toBe(0);
      expect(unrelated.output).toContain(
        "This pull request changes no package.json, bun.lock, bunfig.toml or the Bun version",
      );

      // A pull request that bumps `b` properly on top of that main passes too: the drift left in
      // its tree is main's.
      yield* w.setVersion(head, "b", "1.0.1");
      const bLock = (yield* w.lock(head)).replace(
        /("packages\/b": \{\s*"name": "b",\s*"version": )"1\.0\.0"/,
        '$1"1.0.1"',
      );
      yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.writeFileString(`${head}/bun.lock`, bLock),
      );
      const own = yield* w.checkPullRequest(head, base);
      expect(own.output).toContain("bun.lock is stale only where the base's is");
      expect(own.exitCode).toBe(0);

      // One that bumps `b` again without the lock still fails.
      yield* w.setVersion(head, "b", "1.0.2");
      const stale = yield* w.checkPullRequest(head, base);
      expect(stale.exitCode).toBe(1);
      expect(stale.output).toContain(
        "This pull request changes bun.lock, packages/b/package.json but leaves bun.lock different",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("an upper stack layer is checked against where the stack meets main", () =>
    Effect.gen(function* () {
      const w = yield* world;
      // Main went stale (a bumped without the lock), the stack was cut there, then main was
      // repaired. Each tree is a worktree of one repository, as GitHub's history is.
      const repo = yield* w.checkout("repo");
      yield* w.setVersion(repo, "a", "1.0.1");
      yield* w.commit(repo, "Bump a without the lock (#1)");
      const cut = yield* w.ok(repo, "git", ["rev-parse", "HEAD"]);
      yield* w.ok(repo, "git", ["branch", "lower"]);
      yield* w.install(repo);
      yield* w.commit(repo, "Refresh bun.lock [skip ci]");
      const repaired = yield* w.ok(repo, "git", ["rev-parse", "HEAD"]);
      const tree = (name: string, commit: string) =>
        Effect.gen(function* () {
          const directory = `${w.root}/${name}`;
          yield* w.ok(repo, "git", ["worktree", "add", "--quiet", "--detach", directory, commit]);
          return directory;
        });

      // The upper layer bumps b and records it in the lock; the a line it inherits is the cut's.
      const upper = yield* tree("upper", "lower");
      yield* w.ok(upper, "git", ["switch", "--quiet", "-c", "upper"]);
      yield* w.setVersion(upper, "b", "1.0.1");
      yield* w.editLock(upper, (text) =>
        text.replace(/("packages\/b": \{\s*"name": "b",\s*"version": )"1\.0\.0"/, '$1"1.0.1"'),
      );
      yield* w.commit(upper, "Bump b (#3)");
      const mergeBase = yield* w.ok(repo, "git", ["merge-base", repaired, "upper"]);
      expect(mergeBase).toBe(cut);

      // Against main's tip it would be blamed for the a line main has since repaired.
      const tip = yield* tree("tip", repaired);
      const againstTip = yield* w.checkPullRequest(upper, tip);
      expect(againstTip.exitCode).toBe(1);
      // Against the merge base it passes.
      const base = yield* tree("merge-base", mergeBase);
      const passed = yield* w.checkPullRequest(upper, base);
      expect(passed.output).toContain("bun.lock is stale only where the base's is");
      expect(passed.exitCode).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("a lower stack layer's drift still fails the stack at its top layer", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const repo = yield* w.checkout("repo");
      const main = yield* w.ok(repo, "git", ["rev-parse", "HEAD"]);
      // The lower layer bumps a without the lock; the upper layer changes no package file.
      yield* w.ok(repo, "git", ["switch", "--quiet", "-c", "lower"]);
      yield* w.setVersion(repo, "a", "1.0.1");
      yield* w.commit(repo, "Bump a without the lock (#2)");
      yield* w.ok(repo, "git", ["switch", "--quiet", "-c", "upper"]);
      yield* w.ok(repo, "git", [
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "Change the product (#3)",
      ]);
      const mergeBase = yield* w.ok(repo, "git", ["merge-base", main, "upper"]);
      expect(mergeBase).toBe(main);
      const base = `${w.root}/merge-base`;
      yield* w.ok(repo, "git", ["worktree", "add", "--quiet", "--detach", base, mergeBase]);
      const result = yield* w.checkPullRequest(repo, base);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(
        "This pull request changes packages/a/package.json but leaves bun.lock different",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a pull request that changes Bun's settings or version is checked, not skipped", () =>
    Effect.gen(function* () {
      const w = yield* world;
      for (const file of ["bunfig.toml", ".github/actions/setup/action.yml"]) {
        const base = yield* w.checkout(`base-${file.length}`);
        yield* w.setVersion(base, "a", "1.0.1");
        const head = yield* w.checkout(`head-${file.length}`);
        yield* w.setVersion(head, "a", "1.0.1");
        yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(`${head}/${file}`.replace(/\/[^/]+$/, ""), { recursive: true });
            yield* fs.writeFileString(`${head}/${file}`, "# changed\n");
          }).pipe(Effect.orDie),
        );
        yield* w.commit(head, `Change ${file} (#1)`);
        const result = yield* w.checkPullRequest(head, base);
        // It compared the two installs instead of passing for changing no install input.
        expect(result.output, file).toContain("bun.lock is stale only where the base's is");
        expect(result.exitCode, file).toBe(0);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("without --base the check fails on a stale lock and leaves it as committed", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      const fresh = yield* run(main, "node", [w.check], w.env);
      expect(fresh.exitCode).toBe(0);
      yield* w.setVersion(main, "a", "1.0.1");
      const before = yield* w.lock(main);
      const stale = yield* run(main, "node", [w.check], w.env);
      expect(stale.exitCode).toBe(1);
      expect(stale.output).toContain("bun.lock is not what `bun install` writes");
      expect(yield* w.lock(main)).toBe(before);
    }).pipe(Effect.scoped),
  );

  it.effect("the repair prepares without pushing, then pushes a fresh lock to a stale main", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      yield* w.setVersion(main, "a", "1.0.1");
      yield* w.commit(main, "Bump a without the lock (#1)");
      const remote = yield* w.remoteFor(main);
      const before = yield* w.remoteHead(remote);

      // `prepare`, which runs without the key, commits on the checkout and pushes nothing.
      const prepared = yield* w.repairStep(main, ["prepare"]);
      expect(prepared.exitCode, prepared.output).toBe(0);
      const commit = yield* w.ok(main, "git", ["rev-parse", "HEAD"]);
      expect(prepared.outputs).toEqual({ ready: "true", start: before, commit });
      expect(yield* w.remoteHead(remote)).toBe(before);
      expect(prepared.output).toContain('"packages/a": "1.0.0" -> "1.0.1"');

      const pushed = yield* w.repairStep(main, ["push", before, commit, remote]);
      expect(pushed.exitCode, pushed.output).toBe(0);
      expect(pushed.outputs).toEqual({ pushed: "true", repaired: commit });
      expect(yield* w.remoteHead(remote)).toBe(commit);
      expect(yield* w.ok(remote, "git", ["log", "-1", "--format=%s|%an|%ae", "main"])).toBe(
        "Refresh bun.lock [skip ci]|github-actions[bot]|41898282+github-actions[bot]@users.noreply.github.com",
      );
      expect(yield* w.ok(remote, "git", ["log", "-1", "--format=%b", "main"])).toBe(
        '"packages/a": "1.0.0" -> "1.0.1"',
      );
      expect(yield* w.ok(remote, "git", ["diff", "--name-only", before, "main"])).toBe("bun.lock");
      expect(yield* w.ok(remote, "git", ["rev-parse", "main^"])).toBe(before);
      // The pushed lock is fresh: the check passes on it and a second repair prepares nothing.
      expect((yield* run(main, "node", [w.check], w.env)).exitCode).toBe(0);
      const again = yield* w.repairMain(main, remote);
      expect(again.output).toContain("bun.lock is what `bun install` writes.");
      expect(again.prepared.outputs).toEqual({ fresh: "true" });
      expect(again.pushed).toBeUndefined();
      expect(yield* w.remoteHead(remote)).toBe(commit);
    }).pipe(Effect.scoped),
  );

  it.effect("after a push the checkout holds main exactly, for the version bump after it", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      yield* w.setVersion(main, "a", "1.0.1");
      yield* w.commit(main, "Bump a without the lock (#1)");
      const remote = yield* w.remoteFor(main);
      // Something else in the job changes a tracked file between the two steps.
      const result = yield* w.repairMain(
        main,
        remote,
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString(`${main}/package.json`, "{}\n").pipe(Effect.orDie),
        ),
      );
      expect(result.pushed?.outputs.pushed).toBe("true");
      expect(result.output).toContain("reset them");
      expect(yield* w.ok(main, "git", ["status", "--porcelain"])).toBe("");
      expect(yield* w.ok(main, "git", ["rev-parse", "HEAD"])).toBe(yield* w.remoteHead(remote));
    }).pipe(Effect.scoped),
  );

  it.effect("the push step pushes only the commit the prepare step made", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      yield* w.setVersion(main, "a", "1.0.1");
      yield* w.commit(main, "Bump a without the lock (#1)");
      const remote = yield* w.remoteFor(main);
      const before = yield* w.remoteHead(remote);
      const prepared = yield* w.repairStep(main, ["prepare"]);
      const commit = prepared.outputs.commit ?? "";
      // A different commit on the checkout when the push step starts.
      yield* w.ok(main, "git", ["commit", "--quiet", "--allow-empty", "-m", "Something else"]);
      const pushed = yield* w.repairStep(main, ["push", before, commit, remote]);
      expect(pushed.exitCode, pushed.output).toBe(0);
      expect(pushed.output).toContain("::warning::The checkout is not the bun.lock refresh");
      expect(pushed.outputs).toEqual({ refused: "true" });
      expect(yield* w.remoteHead(remote)).toBe(before);
      expect(yield* w.ok(main, "git", ["rev-parse", "HEAD"])).toBe(before);
    }).pipe(Effect.scoped),
  );

  it.effect("when main moved after the checkout, the repair pushes nothing and exits 0", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      yield* w.setVersion(main, "a", "1.0.1");
      yield* w.commit(main, "Bump a without the lock (#1)");
      const read = yield* w.ok(main, "git", ["rev-parse", "HEAD"]);
      const remote = yield* w.remoteFor(main);
      // Another merge lands on GitHub's main after this checkout read it.
      const other = `${w.root}/other`;
      yield* w.ok(w.root, "git", ["clone", "--quiet", remote, other]);
      yield* w.ok(other, "git", [
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "Change the product (#2)",
      ]);
      yield* w.ok(other, "git", ["push", "--quiet", "origin", "HEAD:main"]);
      const moved = yield* w.remoteHead(remote);

      const result = yield* w.repairMain(main, remote);
      expect(result.output).toContain("so the bun.lock refresh was not pushed");
      expect(result.pushed?.outputs).toEqual({});
      expect(yield* w.remoteHead(remote)).toBe(moved);
      // The checkout is back on the main it read, for the steps after it.
      expect(yield* w.ok(main, "git", ["rev-parse", "HEAD"])).toBe(read);
      expect(yield* w.ok(main, "git", ["status", "--porcelain"])).toBe("");
    }).pipe(Effect.scoped),
  );

  it.effect("a refused push while main is unchanged warns and leaves main as it was", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      yield* w.setVersion(main, "a", "1.0.1");
      yield* w.commit(main, "Bump a without the lock (#1)");
      const read = yield* w.ok(main, "git", ["rev-parse", "HEAD"]);
      const remote = yield* w.remoteFor(main);
      yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
        Effect.gen(function* () {
          const hook = `${remote}/hooks/pre-receive`;
          yield* fs.writeFileString(
            hook,
            "#!/bin/sh\necho 'push declined by a ruleset' >&2\nexit 1\n",
          );
          yield* fs.chmod(hook, 0o755);
        }),
      );
      const result = yield* w.repairMain(main, remote);
      expect(result.output).toContain(
        "::warning::Pushing the bun.lock refresh to main was refused",
      );
      expect(result.pushed?.outputs).toEqual({ refused: "true" });
      expect(yield* w.remoteHead(remote)).toBe(read);
      // The commit it made is gone, so the version bump after it cannot carry it.
      expect(yield* w.ok(main, "git", ["rev-parse", "HEAD"])).toBe(read);
      expect(yield* w.ok(main, "git", ["status", "--porcelain"])).toBe("");
    }).pipe(Effect.scoped),
  );

  it.effect("a push that cannot reach main at all warns and leaves main as it was", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      yield* w.setVersion(main, "a", "1.0.1");
      yield* w.commit(main, "Bump a without the lock (#1)");
      const read = yield* w.ok(main, "git", ["rev-parse", "HEAD"]);
      // As with a deploy key GitHub rejects: neither the push nor reading main gets through.
      const result = yield* w.repairMain(main, `${w.root}/no-such-remote.git`);
      expect(result.output).toContain("::warning::Pushing the bun.lock refresh to main failed");
      expect(result.pushed?.outputs).toEqual({ refused: "true" });
      expect(yield* w.ok(main, "git", ["rev-parse", "HEAD"])).toBe(read);
      expect(yield* w.ok(main, "git", ["status", "--porcelain"])).toBe("");
    }).pipe(Effect.scoped),
  );

  it.effect("the push step refuses a prepared commit that changes more than bun.lock", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      yield* w.setVersion(main, "a", "1.0.1");
      yield* w.commit(main, "Bump a without the lock (#1)");
      const start = yield* w.ok(main, "git", ["rev-parse", "HEAD"]);
      const remote = yield* w.remoteFor(main);
      // A commit on the main it read, as `prepare` makes, that also changes a second file.
      yield* w.install(main);
      yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.writeFileString(`${main}/.gitignore`, "node_modules\ndist\n").pipe(Effect.orDie),
      );
      yield* w.commit(main, "Refresh bun.lock [skip ci]");
      const commit = yield* w.ok(main, "git", ["rev-parse", "HEAD"]);
      const pushed = yield* w.repairStep(main, ["push", start, commit, remote]);
      expect(pushed.exitCode, pushed.output).toBe(0);
      expect(pushed.output).toContain("::warning::The checkout is not the bun.lock refresh");
      expect(pushed.outputs).toEqual({ refused: "true" });
      expect(yield* w.remoteHead(remote)).toBe(start);
      expect(yield* w.ok(main, "git", ["rev-parse", "HEAD"])).toBe(start);
    }).pipe(Effect.scoped),
  );

  it.effect("a refresh that a second install changes again is not committed", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      yield* w.setVersion(main, "a", "1.0.1");
      yield* w.commit(main, "Bump a without the lock (#1)");
      const start = yield* w.ok(main, "git", ["rev-parse", "HEAD"]);
      const committed = yield* w.lock(main);
      // A `bun` whose second run writes a different lock, as a Bun that is not deterministic would.
      const state = `${w.root}/bun-calls`;
      yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(
            `${w.bin}/bun`,
            `#!/bin/sh
n=$(cat "${state}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${state}"
PATH=\${PATH#*:} bun "$@"; status=$?
if [ "$n" -ge 2 ]; then printf '\\n' >> bun.lock; fi
exit $status
`,
          );
          yield* fs.chmod(`${w.bin}/bun`, 0o755);
        }).pipe(Effect.orDie),
      );
      const prepared = yield* w.repairStep(main, ["prepare"], {
        PATH: `${w.bin}:${process.env.PATH ?? ""}`,
      });
      expect(prepared.exitCode, prepared.output).toBe(0);
      expect(prepared.output).toContain(
        "::warning::A second `bun install --lockfile-only` changed bun.lock again",
      );
      expect(prepared.outputs).toEqual({ refused: "true" });
      expect(yield* w.ok(main, "git", ["rev-parse", "HEAD"])).toBe(start);
      expect(yield* w.ok(main, "git", ["status", "--porcelain"])).toBe("");
      expect(yield* w.lock(main)).toBe(committed);
    }).pipe(Effect.scoped),
  );

  it.effect("a refusal opens one issue, a later refusal updates it, a fresh lock closes it", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      yield* w.editLock(main, (text) =>
        text.replace('"a": ["a@workspace:packages/a"]', '"a": ["a@workspace:packages/b"]'),
      );
      yield* w.commit(main, "Resolve a from the wrong place (#1)");
      const first = yield* w.ok(main, "git", ["rev-parse", "HEAD"]);
      const remote = yield* w.remoteFor(main);

      const opened = yield* w.issueStep(main, yield* w.repairMain(main, remote));
      expect(opened.calls.filter((call) => /^(label|issue) create/.test(call))).toHaveLength(2);
      expect(opened.calls.find((call) => call.startsWith("issue create"))).toContain(
        "--title The bun.lock repair on main needs a person --label lock-repair-refused",
      );
      expect(opened.open).toBe("7");
      expect(opened.body).toContain("~~~text\nbun.lock on main is not what `bun install` writes");
      expect(opened.body).toContain('+    "a": ["a@workspace:packages/a"],');
      expect(opened.body).toContain(
        `- Latest: https://github.com/example/repo/actions/runs/100 on ${first}`,
      );
      expect(opened.body).toContain(
        `<!-- first-seen: ${first} https://github.com/example/repo/actions/runs/100 -->`,
      );
      expect(opened.calls.some((call) => call.includes("comment"))).toBe(false);

      // A later tick refuses again: the same issue is rewritten and keeps its first tick.
      yield* w.ok(main, "git", ["commit", "--quiet", "--allow-empty", "-m", "Change (#2)"]);
      const later = yield* w.ok(main, "git", ["rev-parse", "HEAD"]);
      const updated = yield* w.issueStep(main, yield* w.repairMain(main, remote));
      expect(updated.calls.filter((call) => call.includes("create"))).toEqual([]);
      expect(updated.calls.some((call) => call.startsWith("issue edit 7"))).toBe(true);
      expect(updated.body).toContain(
        `- Latest: https://github.com/example/repo/actions/runs/100 on ${later}`,
      );
      expect(updated.body).toContain(`<!-- first-seen: ${first} `);

      // Someone commits the refresh in a pull request; the next tick finds main fresh.
      yield* w.install(main);
      yield* w.commit(main, "Refresh bun.lock (#3)");
      const closed = yield* w.issueStep(main, yield* w.repairMain(main, remote));
      expect(closed.calls.filter((call) => call.startsWith("issue close 7"))).toHaveLength(1);
      expect(closed.open).toBe("");
      expect(closed.body).toContain("is what `bun install` writes again");
      // With no issue open, a fresh tick does nothing more than look.
      const quiet = yield* w.issueStep(main, yield* w.repairMain(main, remote));
      expect(quiet.calls.map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual([
        "issue list",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("a repair step that fails or times out opens the issue; a moved main leaves it", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      const crashed = yield* w.issueStep(main, {}, { lock: "failure" });
      expect(crashed.open).toBe("7");
      expect(crashed.body).toContain("The step that refreshes bun.lock failed or ran out of time.");
      // A tick whose push found main moved neither refused nor found the lock fresh.
      const moved = yield* w.issueStep(main, {
        prepared: { outputs: { ready: "true" } },
        pushed: { outputs: {} },
      });
      expect(moved.output).toContain("the issue stays as it is");
      expect(moved.calls.map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual([
        "issue list",
      ]);
      expect(moved.open).toBe("7");
    }).pipe(Effect.scoped),
  );

  it.effect("a reason holding a fence or a mention cannot leave the issue's text block", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.writeFileString(`${w.root}/lock-repair-refused.md`, "line one\n~~~\nping @someone\n"),
      );
      const result = yield* w.issueStep(main, { prepared: { outputs: { refused: "true" } } });
      const body = result.body;
      const fence = body.indexOf("~~~text\n");
      const end = body.indexOf("\n~~~\n", fence);
      expect(body.slice(fence, end)).toContain("~ ~ ~\nping @someone");
      expect(body.slice(0, fence)).not.toContain("@");
      expect(body.slice(end + 1)).not.toContain("@");
    }).pipe(Effect.scoped),
  );

  it.effect("a refresh that resolves a dependency differently is not pushed", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      // `bun install --frozen-lockfile` accepts this lock; `bun install` writes the resolution back.
      yield* w.editLock(main, (text) =>
        text.replace('"a": ["a@workspace:packages/a"]', '"a": ["a@workspace:packages/b"]'),
      );
      yield* w.commit(main, "Resolve a from the wrong place (#1)");
      const result = yield* w.refused(main, [
        '-    "a": ["a@workspace:packages/b"],',
        '+    "a": ["a@workspace:packages/a"],',
      ]);
      expect(result.summary).toContain("no workspace version: these lines are a dependency change");
    }).pipe(Effect.scoped),
  );

  it.effect("a refresh that adds a dependency is not pushed", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      // `b` now depends on `a`, and the lock does not say so. `--frozen-lockfile` accepts it.
      yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.writeFileString(
          `${main}/packages/b/package.json`,
          `${JSON.stringify({ name: "b", version: "1.0.0", dependencies: { a: "workspace:*" } }, null, 2)}\n`,
        ),
      );
      yield* w.commit(main, "Use a from b (#1)");
      yield* w.refused(main, ['+        "a": "workspace:*",']);
    }).pipe(Effect.scoped),
  );

  it.effect("a refresh that bumps a version and changes a resolution is not pushed", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      yield* w.setVersion(main, "a", "1.0.1");
      yield* w.editLock(main, (text) =>
        text.replace('"b": ["b@workspace:packages/b"]', '"b": ["b@workspace:packages/a"]'),
      );
      yield* w.commit(main, "Bump a and resolve b from the wrong place (#1)");
      const result = yield* w.refused(main, ['+    "b": ["b@workspace:packages/b"],']);
      expect(result.summary).toContain(
        'Besides "packages/a": "1.0.0" -> "1.0.1", the refresh changes',
      );
      // The version line it would have explained is not among the lines it reports.
      expect(result.summary).not.toContain('"version": "1.0.1"');
    }).pipe(Effect.scoped),
  );

  it.effect("a workspace whose package.json is gone is out of scope, named by its path", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      yield* w.ok(main, "git", ["rm", "--quiet", "packages/b/package.json"]);
      yield* w.commit(main, "Drop b's manifest (#1)");
      const result = yield* w.refused(main, []);
      expect(result.summary).toContain(
        '"packages/b/package.json", which bun.lock lists as a workspace, could not be read',
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a version that holds a newline is quoted, so it cannot start a workflow command", () =>
    Effect.gen(function* () {
      const w = yield* world;
      const main = yield* w.checkout("main");
      yield* w.setVersion(main, "a", "1.0.1\n::error::forged");
      yield* w.commit(main, "Bump a to a strange version (#1)");
      // Bun drops a version it cannot read from the lock, so the refresh is out of scope too.
      const result = yield* w.refused(main, [
        'Besides "packages/a": "1.0.0" -> "1.0.1\\n::error::forged"',
      ]);
      expect(result.output.split("\n").filter((line) => line.startsWith("::error::"))).toEqual([]);
      expect(result.summary.split("\n").filter((line) => line.startsWith("::error::"))).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
