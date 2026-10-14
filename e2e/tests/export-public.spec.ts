/**
 * `.github/workflows/export-public.yml` runs `scripts/export-public.sh` on every push to main. It
 * snapshots the exported files onto the public repository's `v2` branch, and merges the public
 * pull requests that commits here port. These cases copy the script and its exclude list into a
 * scratch repository and export to a local bare repository laid out as
 * `UsefulSoftwareCo/executor.git`, whose `refs/pull/<n>/head` hold contributor commits, as
 * GitHub's do. A stub `gh` first on PATH answers the script's pull request reads.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const repository = "UsefulSoftwareCo/executor";
const maintainer = "Maintainer <maintainer@example.com>";
const contributor = "Contributor <contributor@example.com>";

/** What GitHub keeps of a pull request that the export reads. */
interface PullRequest {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly base: string;
  readonly head: string;
}

/**
 * Answers `gh api [--paginate] repos/<owner>/<name>/pulls?<query> --jq <filter>` as GitHub's list
 * endpoint does, from `$FAKE_GITHUB/pulls.json`: the pull requests in the query's state whose base
 * is its base, as full objects for the filter. Other repositories are not found, and while
 * `$FAKE_GITHUB/unavailable` exists GitHub answers nothing. Every call is appended to
 * `$FAKE_GITHUB/calls`.
 */
const stubGh = `#!/bin/sh
echo "$*" >> "$FAKE_GITHUB/calls"
[ "$1" = api ] || { echo "stub gh: unsupported command: $*" >&2; exit 2; }
[ -e "$FAKE_GITHUB/unavailable" ] && { echo "gh: Service Unavailable (HTTP 503)" >&2; exit 1; }
shift
endpoint=
filter=.
while [ $# -gt 0 ]; do
  case "$1" in
    --paginate) ;;
    --jq) shift; filter=$1 ;;
    -*) echo "stub gh: unsupported flag: $1" >&2; exit 2 ;;
    *) endpoint=$1 ;;
  esac
  shift
done
case "$endpoint" in
  "repos/${repository}/pulls?"*) ;;
  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
esac
param() { printf '%s\\n' "\${endpoint#*\\?}" | tr '&' '\\n' | sed -n "s/^$1=//p"; }
jq -c --arg state "$(param state)" --arg base "$(param base)" \\
  '[.[] | select(.state == ($state | if . == "" then "open" else . end))
    | select($base == "" or .base.ref == $base)]' "$FAKE_GITHUB/pulls.json" |
  jq -r "$filter"
`;

/** Files in the scratch repository; the exclude list keeps the last two private. */
const files: Readonly<Record<string, string>> = {
  "README.md": "# Executor\n",
  "src/greeting.ts": 'export const greeting = "hello";\n',
  "notes/plan.md": "Private plan.\n",
  ".github/workflows/ci.yml": "name: CI\n",
};

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

const author = (identity: string) => {
  const [, name, email] = /^(.*) <(.*)>$/.exec(identity)!;
  return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
};

/**
 * The scratch repository with one commit, exported once to `v2` (and to `v2-releases` when
 * asked), and a contributor clone of `v2`. Git reads no user or system configuration.
 */
const world = (options: { readonly releases?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-export-public-" });
    const gitConfig = path.join(root, "gitconfig");
    yield* fs.writeFileString(gitConfig, "[init]\n\tdefaultBranch = main\n");
    const github = path.join(root, "github");
    const bin = path.join(root, "bin");
    yield* fs.makeDirectory(github);
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(path.join(bin, "gh"), stubGh);
    yield* fs.chmod(path.join(bin, "gh"), 0o755);
    yield* fs.writeFileString(path.join(github, "pulls.json"), "[]");
    const env = {
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_GITHUB: github,
      // As in the export workflow, so warnings are annotations.
      GITHUB_ACTIONS: "true",
    };
    const git = (cwd: string, ...args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const result = yield* run(cwd, "git", args, env);
        expect(result.exitCode, `git ${args.join(" ")}: ${result.output}`).toBe(0);
        return result.output.trim();
      });

    const bare = path.join(root, `${repository}.git`);
    yield* git(root, "init", "--quiet", "--bare", bare);
    // GitHub serves partial clones.
    yield* git(bare, "config", "uploadpack.allowFilter", "true");
    const url = `file://${bare}`;

    const scratch = path.join(root, "executor-next");
    for (const [file, text] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(scratch, file)), { recursive: true });
      yield* fs.writeFileString(path.join(scratch, file), text);
    }
    yield* fs.makeDirectory(path.join(scratch, "scripts"));
    for (const file of ["scripts/export-public.sh", "scripts/export-public.exclude"])
      yield* fs.copyFile(file, path.join(scratch, file));
    yield* git(scratch, "init", "--quiet");
    yield* git(scratch, "add", "--all");
    yield* git(scratch, ...author(maintainer), "commit", "--quiet", "-m", "Start");

    const commitFile = path.join(root, "public-commit");
    /** Runs the script in the scratch repository, or in this checkout of it, as the workflow does. */
    const exportPublic = (
      input: {
        readonly branch?: string;
        readonly args?: ReadonlyArray<string>;
        readonly checkout?: string;
      } = {},
    ) =>
      Effect.gen(function* () {
        yield* fs.remove(commitFile, { force: true });
        const result = yield* run(
          input.checkout ?? scratch,
          "bash",
          ["scripts/export-public.sh", ...(input.args ?? [])],
          {
            ...env,
            PUBLIC_REPO: url,
            PUBLIC_BRANCH: input.branch ?? "v2",
            PUBLIC_EXPORT_COMMIT_FILE: commitFile,
          },
        );
        const commit = yield* fs
          .readFileString(commitFile)
          .pipe(Effect.orElseSucceed(() => undefined));
        return { ...result, commit: commit?.trim() };
      });

    const first = yield* exportPublic();
    expect(first.exitCode, first.output).toBe(0);
    if (options.releases) expect((yield* exportPublic({ branch: "v2-releases" })).exitCode).toBe(0);

    const fork = path.join(root, "contributor");
    yield* git(root, "clone", "--quiet", "--branch", "v2", url, fork);

    /**
     * Commits these changes in the contributor's clone, on `v2` or on an earlier head of theirs,
     * and publishes them as pull request `number`.
     */
    const contribute = (
      number: number,
      commits: ReadonlyArray<Readonly<Record<string, string | null>>>,
      base = "origin/v2",
    ) =>
      Effect.gen(function* () {
        yield* git(fork, "checkout", "--quiet", "--detach", base);
        for (const [index, changes] of commits.entries()) {
          for (const [file, text] of Object.entries(changes)) {
            const target = path.join(fork, file);
            if (text === null) yield* fs.remove(target);
            else {
              yield* fs.makeDirectory(path.dirname(target), { recursive: true });
              yield* fs.writeFileString(target, text);
            }
          }
          yield* git(fork, "add", "--all");
          yield* git(
            fork,
            ...author(contributor),
            "commit",
            "--quiet",
            "-m",
            `#${number} ${index}`,
          );
        }
        yield* git(fork, "push", "--quiet", "--force", "origin", `HEAD:refs/pull/${number}/head`);
        return yield* git(fork, "rev-parse", "HEAD");
      });

    /** Commits these changes here, as a port's squash merge, with this message. */
    const land = (changes: Readonly<Record<string, string>>, message: string) =>
      Effect.gen(function* () {
        for (const [file, text] of Object.entries(changes)) {
          yield* fs.makeDirectory(path.dirname(path.join(scratch, file)), { recursive: true });
          yield* fs.writeFileString(path.join(scratch, file), text);
        }
        yield* git(scratch, "add", "--all");
        yield* git(scratch, ...author(maintainer), "commit", "--quiet", "-m", message);
        return yield* git(scratch, "rev-parse", "--short", "HEAD");
      });

    const pulls = (list: ReadonlyArray<PullRequest>) =>
      fs.writeFileString(
        path.join(github, "pulls.json"),
        JSON.stringify(
          list.map((pull) => ({
            number: pull.number,
            state: pull.state,
            merged_at: pull.merged ? "2026-10-01T00:00:00Z" : null,
            base: { ref: pull.base },
            head: { sha: pull.head },
          })),
        ),
      );

    /** A public commit: its parents, tree, message, identities and files. */
    const commit = (revision: string) =>
      Effect.gen(function* () {
        const [sha, parents, tree, subject, authored, committed] = (yield* git(
          bare,
          "log",
          "-1",
          "--format=%H%n%P%n%T%n%s%n%an <%ae>%n%cn <%ce>",
          revision,
        )).split("\n");
        const files = yield* git(bare, "ls-tree", "-r", "--name-only", revision);
        return {
          sha: sha!,
          parents: parents!.split(" "),
          tree,
          subject,
          authored,
          committed,
          files: files.split("\n"),
        };
      });
    /** The public branch's tip. */
    const tip = (branch: string) => commit(`refs/heads/${branch}`);

    /** A clone of the scratch repository with only its tip, as the release job checks it out. */
    const shallowCheckout = Effect.gen(function* () {
      const checkout = path.join(root, "release-checkout");
      yield* git(root, "clone", "--quiet", "--depth", "1", `file://${scratch}`, checkout);
      return checkout;
    });

    const calls = fs
      .readFileString(path.join(github, "calls"))
      .pipe(Effect.orElseSucceed(() => ""));

    /** GitHub stops answering the pulls API. */
    const unavailable = fs.writeFileString(path.join(github, "unavailable"), "");

    const hook = path.join(bare, "hooks", "pre-receive");
    /**
     * The public repository refuses pushes that bring a commit adding `file`, as GitHub's push
     * protection refuses a pushed secret, until `accept`.
     */
    const refuse = (file: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(hook), { recursive: true });
        yield* fs.writeFileString(
          hook,
          `#!/bin/sh
while read -r old new ref; do
  for commit in $(git rev-list "$old..$new"); do
    if git diff-tree --no-commit-id --name-only -r "$commit" | grep -qx '${file}'; then
      echo "push declined: secret detected in $commit" >&2
      exit 1
    fi
  done
done
`,
        );
        yield* fs.chmod(hook, 0o755);
      });
    const accept = fs.remove(hook);

    return {
      bare,
      git,
      exportPublic,
      contribute,
      land,
      pulls,
      commit,
      tip,
      shallowCheckout,
      calls,
      unavailable,
      refuse,
      accept,
    };
  });

/** A port's squash-merge message: the marker beside the contributor's trailer. */
const ported = (title: string, number: number, head: string, named = repository) =>
  `${title}\n\nPublic-PR: ${named}#${number} ${head}\nCo-Authored-By: ${contributor}\n`;

const greeted = 'export const greeting = "hello, world";\n';

/** The workflow annotations an export printed, in order. */
const warnings = (output: string) =>
  output.split("\n").filter((line) => line.startsWith("::warning"));
const warning = (text: string) => `::warning title=Public export::${text}`;

layer(NodeServices.layer, { excludeTestServices: true })("Public export", (it) => {
  it.effect(
    "a ported pull request open against v2 becomes the export's second parent, and the tree stays the exported files",
    () =>
      Effect.gen(function* () {
        const w = yield* world();
        const before = yield* w.tip("v2");
        const head = yield* w.contribute(7, [{ "src/greeting.ts": greeted }]);
        const exported = yield* w.land(
          { "src/greeting.ts": greeted, "notes/greeting.md": "Private.\n" },
          ported("Greet the world", 7, head),
        );
        yield* w.pulls([{ number: 7, state: "open", merged: false, base: "v2", head }]);

        const dry = yield* w.exportPublic({ args: ["--dry-run"] });
        expect(dry.exitCode, dry.output).toBe(0);
        expect(yield* w.tip("v2")).toEqual(before);

        const merged = yield* w.exportPublic();
        expect(merged.exitCode, merged.output).toBe(0);
        const after = yield* w.tip("v2");
        // The previous export first, so the push is a fast-forward; then the contributor's head,
        // which makes GitHub show the pull request as merged.
        expect(after.parents).toEqual([before.sha, head]);
        expect(after.subject).toBe(`Export ${exported}`);
        expect(after.authored).toBe(maintainer);
        expect(after.committed).toBe(maintainer);
        expect(after.files).toEqual(["README.md", "src/greeting.ts"]);
        expect(yield* w.git(w.bare, "show", "v2:src/greeting.ts")).toBe(greeted.trim());
        expect(merged.commit).toBe(after.sha);
        expect(dry.output).toContain(`would merge ${repository}#7 ${head}`);
        expect(merged.output).toContain(`merging ${repository}#7 ${head}`);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a re-run after the merge adds nothing, before and after GitHub marks the pull request merged",
    () =>
      Effect.gen(function* () {
        const w = yield* world();
        const head = yield* w.contribute(7, [{ "src/greeting.ts": greeted }]);
        yield* w.land({ "src/greeting.ts": greeted }, ported("Greet the world", 7, head));
        yield* w.pulls([{ number: 7, state: "open", merged: false, base: "v2", head }]);
        expect((yield* w.exportPublic()).exitCode).toBe(0);
        const merged = yield* w.tip("v2");
        expect(merged.parents).toHaveLength(2);

        // GitHub has not marked it merged yet, so it still lists the pull request as open.
        const early = yield* w.exportPublic();
        expect(early.exitCode, early.output).toBe(0);
        expect(yield* w.tip("v2")).toEqual(merged);
        expect(early.output).toContain("no changes since last export");
        expect(early.output).not.toContain("merging");
        expect(early.commit).toBe(merged.sha);
        const dry = yield* w.exportPublic({ args: ["--dry-run"] });
        expect(dry.output).toContain(`skipping ${repository}#7: ${head} is already in v2`);
        expect(dry.output).toContain("no changes since last export");

        yield* w.pulls([{ number: 7, state: "closed", merged: true, base: "v2", head }]);
        const late = yield* w.exportPublic();
        expect(late.output).toContain("no changes since last export");
        expect(yield* w.tip("v2")).toEqual(merged);

        // The next change exports on top of the merge, with no other parent.
        const exported = yield* w.land({ "README.md": "# Executor 2\n" }, "Rename the product");
        expect((yield* w.exportPublic()).exitCode).toBe(0);
        const next = yield* w.tip("v2");
        expect(next.parents).toEqual([merged.sha]);
        expect(next.subject).toBe(`Export ${exported}`);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "pull requests that moved, closed, merged or target another branch are skipped, and a marker naming another repository warns",
    () =>
      Effect.gen(function* () {
        const w = yield* world();
        const before = yield* w.tip("v2");
        const heads = new Map<number, string>();
        for (const number of [7, 8, 9, 10, 11, 12])
          heads.set(number, yield* w.contribute(number, [{ [`src/pull-${number}.ts`]: "\n" }]));
        for (const number of [7, 8, 9, 10])
          yield* w.land(
            { [`src/pull-${number}.ts`]: "\n" },
            ported(`Port ${number}`, number, heads.get(number)!),
          );
        // A slip when porting from here: the private repository's name.
        const other = `Public-PR: UsefulSoftwareCo/executor-next#11 ${heads.get(11)}`;
        const slipped = yield* w.land(
          { "src/pull-11.ts": "\n" },
          ported("Port eleven", 11, heads.get(11)!, "UsefulSoftwareCo/executor-next"),
        );
        // GitHub's names are case-insensitive, so this marker counts.
        yield* w.land(
          { "src/pull-12.ts": "\n" },
          ported("Port twelve", 12, heads.get(12)!, repository.toLowerCase()),
        );
        // The contributor pushes again after #7's port landed.
        const moved = yield* w.contribute(7, [
          { "src/pull-7.ts": "\n" },
          { "src/pull-7.ts": "more\n" },
        ]);
        yield* w.pulls([
          { number: 7, state: "open", merged: false, base: "v2", head: moved },
          { number: 8, state: "closed", merged: false, base: "v2", head: heads.get(8)! },
          { number: 9, state: "closed", merged: true, base: "v2", head: heads.get(9)! },
          { number: 10, state: "open", merged: false, base: "main", head: heads.get(10)! },
          // Open against v2 here, so only the repository in its marker keeps it out.
          { number: 11, state: "open", merged: false, base: "v2", head: heads.get(11)! },
          { number: 12, state: "open", merged: false, base: "v2", head: heads.get(12)! },
        ]);
        const refs = yield* w.git(w.bare, "for-each-ref");

        const dry = yield* w.exportPublic({ args: ["--dry-run"] });
        expect(dry.exitCode, dry.output).toBe(0);
        expect(dry.output).toContain("dry run, not pushing");
        expect(yield* w.git(w.bare, "for-each-ref")).toBe(refs);

        const exported = yield* w.exportPublic();
        expect(exported.exitCode, exported.output).toBe(0);
        const after = yield* w.tip("v2");
        expect(after.parents).toEqual([before.sha, heads.get(12)]);
        expect(warnings(exported.output)).toEqual([
          warning(
            `${slipped} has a Public-PR line that merges nothing: "${other}". A marker is Public-PR: ${repository}#<number> <40-hex head sha>, at the start of a line.`,
          ),
          warning(
            `${repository}#7 moved to ${moved}, which no port records. Port its new commits and record Public-PR: ${repository}#7 ${moved}.`,
          ),
        ]);
        // Only a dry run says why it skips the rest.
        for (const number of [8, 9, 10]) expect(exported.output).not.toContain(`#${number}`);
        expect(dry.output).toContain(`would merge ${repository}#12 ${heads.get(12)}`);
        for (const number of [8, 9, 10])
          expect(dry.output).toContain(`skipping ${repository}#${number}: not open against v2`);
        expect(dry.output).not.toContain(`${repository}#11`);
        expect(after.files).toEqual(
          [
            "README.md",
            "src/greeting.ts",
            ...[7, 8, 9, 10, 11, 12].map((number) => `src/pull-${number}.ts`),
          ].sort(),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("an export to v2-releases merges no pull request", () =>
    Effect.gen(function* () {
      const w = yield* world({ releases: true });
      const v2 = yield* w.tip("v2");
      const releases = yield* w.tip("v2-releases");
      const head = yield* w.contribute(7, [{ "src/greeting.ts": greeted }]);
      yield* w.land({ "src/greeting.ts": greeted }, ported("Greet the world", 7, head));
      yield* w.pulls([{ number: 7, state: "open", merged: false, base: "v2", head }]);

      const exported = yield* w.exportPublic({ branch: "v2-releases" });
      expect(exported.exitCode, exported.output).toBe(0);
      expect(exported.output).not.toContain("merging");
      const after = yield* w.tip("v2-releases");
      expect(after.parents).toEqual([releases.sha]);
      expect(after.files).toEqual(["README.md", "src/greeting.ts"]);
      // One read, of the pull requests open against v2-releases: none.
      const calls = (yield* w.calls).trim().split("\n");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(`repos/${repository}/pulls?state=open&base=v2-releases&`);
      expect(yield* w.tip("v2")).toEqual(v2);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a pull request with a commit that carries a workflow file stays unmerged, with a warning",
    () =>
      Effect.gen(function* () {
        const w = yield* world();
        const before = yield* w.tip("v2");
        // The workflow is gone again from the head, but its first commit still carries it.
        const head = yield* w.contribute(7, [
          { ".github/workflows/fork.yml": "name: Fork\n" },
          { ".github/workflows/fork.yml": null, "src/greeting.ts": greeted },
        ]);
        const workflow = yield* w.git(w.bare, "rev-parse", `${head}~1`);
        yield* w.land({ "src/greeting.ts": greeted }, ported("Greet the world", 7, head));
        yield* w.pulls([{ number: 7, state: "open", merged: false, base: "v2", head }]);

        const exported = yield* w.exportPublic();
        expect(exported.exitCode, exported.output).toBe(0);
        const after = yield* w.tip("v2");
        expect(after.parents).toEqual([before.sha]);
        expect(after.files).toEqual(["README.md", "src/greeting.ts"]);
        expect(exported.output).toContain(
          `::warning title=Public export::${repository}#7 is not merged: its commit ${workflow} carries .github/workflows files, which the export cannot push.`,
        );
      }).pipe(Effect.scoped),
  );

  it.effect("pull requests ported before one export all become parents of its commit", () =>
    Effect.gen(function* () {
      const w = yield* world();
      const before = yield* w.tip("v2");
      const seven = yield* w.contribute(7, [{ "src/seven.ts": "\n" }]);
      const eight = yield* w.contribute(8, [{ "src/eight.ts": "\n" }]);
      yield* w.land({ "src/seven.ts": "\n" }, ported("Port seven", 7, seven));
      yield* w.land({ "src/eight.ts": "\n" }, ported("Port eight", 8, eight));
      yield* w.pulls([
        { number: 7, state: "open", merged: false, base: "v2", head: seven },
        { number: 8, state: "open", merged: false, base: "v2", head: eight },
      ]);

      const exported = yield* w.exportPublic();
      expect(exported.exitCode, exported.output).toBe(0);
      const after = yield* w.tip("v2");
      expect(after.parents).toEqual([before.sha, seven, eight]);
      expect(after.files).toEqual(["README.md", "src/eight.ts", "src/greeting.ts", "src/seven.ts"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a marker that lands with only private changes still merges its pull request, and the tree stays the same",
    () =>
      Effect.gen(function* () {
        const w = yield* world();
        const head = yield* w.contribute(7, [{ "src/greeting.ts": greeted }]);
        // The port landed without its marker, so its export merged nothing.
        yield* w.land({ "src/greeting.ts": greeted }, "Greet the world");
        expect((yield* w.exportPublic()).exitCode).toBe(0);
        const before = yield* w.tip("v2");
        expect(before.parents).toHaveLength(1);
        // The marker follows in a commit that changes only an excluded path.
        yield* w.land({ "notes/greeting.md": "Ported.\n" }, ported("Record the port", 7, head));
        yield* w.pulls([{ number: 7, state: "open", merged: false, base: "v2", head }]);

        const exported = yield* w.exportPublic();
        expect(exported.exitCode, exported.output).toBe(0);
        const after = yield* w.tip("v2");
        expect(after.parents).toEqual([before.sha, head]);
        expect(after.tree).toBe(before.tree);
        expect(exported.commit).toBe(after.sha);
        expect(exported.output).toContain(`merging ${repository}#7 ${head}`);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "Public-PR lines that are not markers merge nothing, and the export that adds them names their commits",
    () =>
      Effect.gen(function* () {
        const w = yield* world();
        const before = yield* w.tip("v2");
        const numbers = [7, 8, 9, 10, 11, 12, 13, 14];
        const heads = new Map<number, string>();
        for (const number of numbers)
          heads.set(number, yield* w.contribute(number, [{ [`src/pull-${number}.ts`]: "\n" }]));
        const head = (number: number) => heads.get(number)!;
        const indented = `  Public-PR: ${repository}#7 ${head(7)}`;
        const quoted = `> Public-PR: ${repository}#8 ${head(8)}`;
        const lowercase = `public-pr: ${repository}#13 ${head(13)}`;
        const short = `Public-PR: ${repository}#9 ${head(9).slice(0, 12)}`;
        const uppercase = `Public-PR: ${repository}#10 ${head(10).toUpperCase()}`;
        const url = `Public-PR: https://github.com/${repository}/pull/11 ${head(11)}`;
        const unnamed = `Public-PR: #12 ${head(12)}`;
        const annotated = `Public-PR: ${repository}#14 ${head(14)}, 90% of it`;
        // Both commits land before the next export, which reads both.
        const first = yield* w.land(
          Object.fromEntries([7, 8, 9, 13].map((number) => [`src/pull-${number}.ts`, "\n"])),
          `Port seven to nine\n\n${indented}\n${quoted}\n${lowercase}\n${short}\n`,
        );
        const second = yield* w.land(
          Object.fromEntries([10, 11, 12, 14].map((number) => [`src/pull-${number}.ts`, "\n"])),
          `Port ten to fourteen\n\n${uppercase}\n${url}\n${unnamed}\n${annotated}\n`,
        );
        yield* w.pulls(
          numbers.map((number) => ({
            number,
            state: "open" as const,
            merged: false,
            base: "v2",
            head: head(number),
          })),
        );

        const exported = yield* w.exportPublic();
        expect(exported.exitCode, exported.output).toBe(0);
        expect((yield* w.tip("v2")).parents).toEqual([before.sha]);
        // Newest commit first. A quoted line is not meant as a marker, and an annotation
        // escapes `%` as `%25`.
        expect(warnings(exported.output)).toEqual(
          [
            [second, uppercase],
            [second, url],
            [second, unnamed],
            [second, annotated.replace("%", "%25")],
            [first, indented],
            [first, lowercase],
            [first, short],
          ].map(([commit, line]) =>
            warning(
              `${commit} has a Public-PR line that merges nothing: "${line}". A marker is Public-PR: ${repository}#<number> <40-hex head sha>, at the start of a line.`,
            ),
          ),
        );

        // The next export adds neither commit, so it does not warn again.
        yield* w.land({ "README.md": "# Executor 2\n" }, "Rename the product");
        const next = yield* w.exportPublic();
        expect(next.exitCode, next.output).toBe(0);
        expect(next.output).not.toContain("::warning");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a pull request whose head cannot be fetched or read stays open with a warning, and the export merges the rest",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const w = yield* world();
        const before = yield* w.tip("v2");
        const heads = new Map<number, string>();
        for (const number of [7, 8, 9]) {
          heads.set(number, yield* w.contribute(number, [{ [`src/pull-${number}.ts`]: "\n" }]));
          yield* w.land(
            { [`src/pull-${number}.ts`]: "\n" },
            ported(`Port ${number}`, number, heads.get(number)!),
          );
        }
        yield* w.pulls(
          [7, 8, 9].map((number) => ({
            number,
            state: "open" as const,
            merged: false,
            base: "v2",
            head: heads.get(number)!,
          })),
        );
        // GitHub no longer serves #7's head.
        yield* w.git(w.bare, "update-ref", "-d", "refs/pull/7/head");
        // #8's head arrives, but one of its trees cannot be fetched when the export reads it.
        const tree = yield* w.git(w.bare, "rev-parse", `${heads.get(8)}:src`);
        yield* fs.remove(path.join(w.bare, "objects", tree.slice(0, 2), tree.slice(2)));

        const exported = yield* w.exportPublic();
        expect(exported.exitCode, exported.output).toBe(0);
        const after = yield* w.tip("v2");
        expect(after.parents).toEqual([before.sha, heads.get(9)]);
        expect(after.files).toEqual(
          [
            "README.md",
            "src/greeting.ts",
            "src/pull-7.ts",
            "src/pull-8.ts",
            "src/pull-9.ts",
          ].sort(),
        );
        expect(exported.output).toContain(
          `::warning title=Public export::${repository}#7 is not merged: its head ${heads.get(7)} could not be fetched.`,
        );
        expect(exported.output).toContain(
          `::warning title=Public export::${repository}#8 is not merged: its commit ${heads.get(8)} could not be read.`,
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "when GitHub refuses one merge, v2 still gets the export and the other merges, and only that pull request waits",
    () =>
      Effect.gen(function* () {
        const w = yield* world();
        const before = yield* w.tip("v2");
        // #7's first commit holds a secret, which GitHub refuses to receive. #8 is clean.
        const secret = yield* w.contribute(7, [
          { "src/secret.ts": "token\n" },
          { "src/secret.ts": null, "src/greeting.ts": greeted },
        ]);
        const clean = yield* w.contribute(8, [{ "src/eight.ts": "\n" }]);
        yield* w.land({ "src/greeting.ts": greeted }, ported("Greet the world", 7, secret));
        const exported = yield* w.land({ "src/eight.ts": "\n" }, ported("Port eight", 8, clean));
        yield* w.pulls([
          { number: 7, state: "open", merged: false, base: "v2", head: secret },
          { number: 8, state: "open", merged: false, base: "v2", head: clean },
        ]);
        yield* w.refuse("src/secret.ts");
        const refusal = warning(
          `${repository}#7 is not merged: the push that merges it failed (see its error above). The next export tries it again.`,
        );

        // The push with both merges is refused. The export then goes without merges, and #8's
        // merge goes on top of it with the same tree.
        const refused = yield* w.exportPublic();
        expect(refused.exitCode, refused.output).toBe(0);
        expect(refused.output).toContain("push declined: secret detected");
        expect(warnings(refused.output)).toEqual([refusal]);
        const after = yield* w.tip("v2");
        expect(after.parents).toEqual([expect.any(String), clean]);
        const alone = yield* w.commit(after.parents[0]!);
        expect(alone.parents).toEqual([before.sha]);
        expect(alone.tree).toBe(after.tree);
        expect([alone.subject, after.subject]).toEqual([
          `Export ${exported}`,
          `Export ${exported}`,
        ]);
        expect(after.files).toEqual(["README.md", "src/eight.ts", "src/greeting.ts"]);
        expect(refused.commit).toBe(after.sha);

        // GitHub marks #8 merged. With nothing else to export, #7's merge is refused again and v2
        // stays as it is.
        const listed = [
          { number: 7, state: "open", merged: false, base: "v2", head: secret },
          { number: 8, state: "closed", merged: true, base: "v2", head: clean },
        ] as const;
        yield* w.pulls(listed);
        const again = yield* w.exportPublic();
        expect(again.exitCode, again.output).toBe(0);
        expect(warnings(again.output)).toEqual([refusal]);
        expect(again.output).toContain("pushed nothing, so v2 is left as it is");
        expect(yield* w.tip("v2")).toEqual(after);
        expect(again.commit).toBe(after.sha);

        // A later port still merges while #7 waits.
        const nine = yield* w.contribute(9, [{ "src/nine.ts": "\n" }]);
        yield* w.land({ "src/nine.ts": "\n" }, ported("Port nine", 9, nine));
        yield* w.pulls([
          ...listed,
          { number: 9, state: "open", merged: false, base: "v2", head: nine },
        ]);
        const later = yield* w.exportPublic();
        expect(later.exitCode, later.output).toBe(0);
        expect(warnings(later.output)).toEqual([refusal]);
        const next = yield* w.tip("v2");
        expect(next.parents).toEqual([expect.any(String), nine]);
        expect((yield* w.commit(next.parents[0]!)).parents).toEqual([after.sha]);
        expect(later.commit).toBe(next.sha);

        yield* w.accept;
        const accepted = yield* w.exportPublic();
        expect(accepted.exitCode, accepted.output).toBe(0);
        expect(warnings(accepted.output)).toEqual([]);
        const merged = yield* w.tip("v2");
        expect(merged.parents).toEqual([next.sha, secret]);
        expect(merged.tree).toBe(next.tree);
      }).pipe(Effect.scoped),
  );

  it.effect("a failure to list the open pull requests stops the export", () =>
    Effect.gen(function* () {
      const w = yield* world();
      const before = yield* w.tip("v2");
      const head = yield* w.contribute(7, [{ "src/greeting.ts": greeted }]);
      yield* w.land({ "src/greeting.ts": greeted }, ported("Greet the world", 7, head));
      yield* w.pulls([{ number: 7, state: "open", merged: false, base: "v2", head }]);
      yield* w.unavailable;

      const failed = yield* w.exportPublic();
      expect(failed.exitCode, failed.output).toBe(1);
      expect(failed.output).toContain("gh: Service Unavailable (HTTP 503)");
      expect(failed.output).toContain(
        `could not list the pull requests open against ${repository} v2`,
      );
      expect(failed.commit).toBeUndefined();
      expect(yield* w.tip("v2")).toEqual(before);
    }).pipe(Effect.scoped),
  );

  it.effect("a pull request ported again after its head moved merges once, at its new head", () =>
    Effect.gen(function* () {
      const w = yield* world();
      const seven = yield* w.contribute(7, [{ "src/pull-7.ts": "\n" }]);
      const eight = yield* w.contribute(8, [{ "src/pull-8.ts": "\n" }]);
      yield* w.land({ "src/pull-7.ts": "\n" }, ported("Port seven", 7, seven));
      /** The contributor pushes another commit onto `from`, remade until its sha sorts as asked. */
      const pushMore = (number: number, from: string, sortsBefore: boolean) =>
        Effect.gen(function* () {
          for (let attempt = 0; ; attempt++) {
            const head = yield* w.contribute(
              number,
              [{ [`src/pull-${number}.ts`]: `more ${attempt}\n` }],
              from,
            );
            if (head < from === sortsBefore) return head;
          }
        });
      // Both push again before the next export. One new head sorts before its old one and the
      // other after it, so neither order of a pull request's markers decides what merges.
      const sevenMoved = yield* pushMore(7, seven, true);
      const eightMoved = yield* pushMore(8, eight, false);
      yield* w.pulls([
        { number: 7, state: "open", merged: false, base: "v2", head: sevenMoved },
        { number: 8, state: "open", merged: false, base: "v2", head: eightMoved },
      ]);

      const moved = yield* w.exportPublic();
      expect(moved.exitCode, moved.output).toBe(0);
      expect(warnings(moved.output)).toEqual([
        warning(
          `${repository}#7 moved to ${sevenMoved}, which no port records. Port its new commits and record Public-PR: ${repository}#7 ${sevenMoved}.`,
        ),
      ]);
      const before = yield* w.tip("v2");
      expect(before.parents).toHaveLength(1);

      // #7's new commits land in a port of their own. #8's port took two rounds before it
      // landed, so its squash body holds both of its markers, the old one first.
      yield* w.land(
        { "src/pull-7.ts": "more\n" },
        ported("Port seven's new commits", 7, sevenMoved),
      );
      yield* w.land(
        { "src/pull-8.ts": "more\n" },
        [
          "Port eight (#2)",
          "",
          "* Port eight",
          "",
          `Public-PR: ${repository}#8 ${eight}`,
          `Co-Authored-By: ${contributor}`,
          "",
          "* Port eight's new commits",
          "",
          `Public-PR: ${repository}#8 ${eightMoved}`,
          `Co-Authored-By: ${contributor}`,
          "",
        ].join("\n"),
      );
      const reported = yield* w.exportPublic();
      expect(reported.exitCode, reported.output).toBe(0);
      expect(warnings(reported.output)).toEqual([]);
      expect(reported.output.split("\n").filter((line) => line.includes("merging"))).toEqual([
        `export-public: merging ${repository}#7 ${sevenMoved}`,
        `export-public: merging ${repository}#8 ${eightMoved}`,
      ]);
      expect((yield* w.tip("v2")).parents).toEqual([before.sha, sevenMoved, eightMoved]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a pull request whose head moves during the export stays unmerged, with a warning",
    () =>
      Effect.gen(function* () {
        const w = yield* world();
        const before = yield* w.tip("v2");
        const head = yield* w.contribute(7, [{ "src/greeting.ts": greeted }]);
        yield* w.land({ "src/greeting.ts": greeted }, ported("Greet the world", 7, head));
        // GitHub lists the ported head, but the contributor pushes again before the export fetches it.
        yield* w.pulls([{ number: 7, state: "open", merged: false, base: "v2", head }]);
        yield* w.contribute(7, [{ "src/pull-7.ts": "\n" }], head);

        const exported = yield* w.exportPublic();
        expect(exported.exitCode, exported.output).toBe(0);
        expect(warnings(exported.output)).toEqual([
          warning(`${repository}#7 moved during the export, away from its ported head ${head}.`),
        ]);
        const after = yield* w.tip("v2");
        expect(after.parents).toEqual([before.sha]);
        expect(after.files).toEqual(["README.md", "src/greeting.ts"]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a release export from a shallow checkout warns only about its tip's Public-PR lines",
    () =>
      Effect.gen(function* () {
        const w = yield* world({ releases: true });
        const releases = yield* w.tip("v2-releases");
        const older = `Public-PR: ${repository}#7 0123456789ab`;
        const newer = `Public-PR: ${repository}#8 0123456789ab`;
        yield* w.land({ "src/pull-7.ts": "\n" }, `Port seven\n\n${older}\n`);
        const released = yield* w.land({ "src/pull-8.ts": "\n" }, `Port eight\n\n${newer}\n`);
        // As the release job's checkout, it lacks the commit the last export names.
        const checkout = yield* w.shallowCheckout;

        const exported = yield* w.exportPublic({ branch: "v2-releases", checkout });
        expect(exported.exitCode, exported.output).toBe(0);
        expect(warnings(exported.output)).toEqual([
          warning(
            `${released} has a Public-PR line that merges nothing: "${newer}". A marker is Public-PR: ${repository}#<number> <40-hex head sha>, at the start of a line.`,
          ),
        ]);
        const after = yield* w.tip("v2-releases");
        expect(after.parents).toEqual([releases.sha]);
        expect(after.subject).toBe(`Export ${released}`);
      }).pipe(Effect.scoped),
  );
});
