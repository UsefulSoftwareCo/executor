/**
 * The public notes of an Executor release: what changed for users since the release before it,
 * then the install instructions at the top of scripts/releases/README.md. The metadata job of
 * `.github/workflows/release-artifacts.yml` writes them before any build, so a failure here costs
 * no matrix, and the publish job creates the GitHub release with them.
 *
 *   node scripts/releases/release-notes.ts [--version <version>] [--to <commit>] [--output <file>]
 *
 * `--version` defaults to apps/cli/package.json and `--to` to HEAD, so the notes of an earlier
 * release can be written again from main with its version and its `Release` commit. Without
 * `--output` they go to stdout.
 *
 * `--json <file>` also writes the notes as plain text, `{ since, releases }`: this release's and,
 * with `--history <n>`, those of the releases before it, newest first, each against the release
 * before it. `since` says how far back it is whole: every release after `since`, up to this one, is
 * listed, and none before it. The list stops at the newest earlier release this checkout cannot
 * place, which `since` is then, so it has no gaps. The desktop update feed reads the file under the
 * same rule (notes-history.ts), and this script checks it so before writing it.
 *
 * The release before is the highest `executor@<version>` tag below this version in the public
 * repository (`PUBLIC_REPO`, by default UsefulSoftwareCo/executor). That tag's commit exports a
 * commit of this repository, which its subject names (`Export <sha>`, scripts/export-public.sh),
 * and the changes are main's commits after that one, up to `--to`: each a squashed pull request.
 * The checkout needs that history.
 *
 * Only a commit whose message has a line `Release-note: <text>` is listed, and its text is the
 * line, as written. A line counts only when `Release-note:` starts a line of the message's body, so
 * not indented, quoted or inline. A message that holds `<`, `[`, `$`, "```" or `~~~` anywhere,
 * title included, other than in the address `<name@host>` and a name's closing `[bot]`
 * (`trailerParts`) of a line that is, whole, a `Co-authored-by: <name> <address>` trailer
 * (`coAuthor`), anywhere in the message, has no notes at all (`hiding`):
 * GitHub's Markdown can hide a line from whoever reads it rendered with HTML, a link definition,
 * math or a code fence, and this script does not try to tell where. Any line that holds
 * `Release-note:` and is not counted gets a warning that names its commit and line. A commit's
 * title is private and never printed, here or in a warning. `Release-note: none` is the same as no
 * line.
 *
 * A note is accepted only when it is plain prose that GitHub renders as nothing but its text
 * (`refusal`): at most `maxNoteLength` characters of ASCII letters, digits, spaces and
 * . , ; : ! ? ' " ( ) -, starting with a letter or digit, with no colon before anything but a
 * space, no dot inside a word (a host name), no letters joined to digits by a hyphen (`GH-123`), no
 * whole word of 7 or more hex characters or digits (a commit hash), no `GHSA-` advisory and no
 * private repository's name. Any other note is left out whole, never rewritten, with a warning that
 * names its commit, line and the reason. Each accepted line of a commit is listed, once, in order.
 *
 * A commit with an accepted line is listed when it changes a file the release ships
 * (`shippedSources` in e2e/release-lanes.ts: the packages the CLI, the desktop app and the
 * self-host image are built from), other than scripts, tests, fixtures and Markdown: under
 * `CLI and desktop` when it changes only the CLI's and the desktop app's own packages, under
 * `Self-host` when only the self-host image's own, and under `All installs` otherwise. A line on a
 * change to nothing a release ships (Cloud, CI, tests, tooling) is not listed, with a warning that
 * names the commit. Once the listed lines hold `maxNotesLength` characters, later changes are left
 * out, with a warning. Every commit not listed is counted in one line. A revert and the commit it
 * reverts cancel when both are in the release, newest first, so a reverted revert cancels nothing
 * and the change it reverted is listed. When nothing is listed, the notes say no release notes were
 * written. Warnings go to the job log, which is private, and name commits only.
 *
 * A commit with a line that ports an outside contributor's public pull request (its `Public-PR:`
 * line, as scripts/export-public.sh reads them) is listed whatever it changed, once for each public
 * pull request (the first of its commits with a line), with a link to it and the
 * GitHub handle of each of its `Co-Authored-By` trailers with a users.noreply.github.com address,
 * bots aside. That credit is the only link and mention in the notes, and it is built only from a
 * marker that names this public repository and a number (`publicPr`) and from handles that match
 * GitHub's rule (`noreply`), so it can point only at a public pull request and its contributors.
 * Anything else credits nothing, with a warning that names the commit and line, and the note is
 * listed as if the change were no port. No other trailer, name or email appears.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Option, Path, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { matchesAny, shippedSources } from "../../e2e/release-lanes.ts";
import { compareReleaseVersions, release, ReleaseVersion } from "./config.ts";
import { refusal } from "@executor-js/utils/release-notes";
import { type NotesHistory, notesHistoryProblem } from "./notes-history.ts";

class ReleaseNotesFailed extends Schema.TaggedError<ReleaseNotesFailed>()("ReleaseNotesFailed", {
  message: Schema.String,
}) {}

/** Files in a shipped package that change nothing a user installs. */
const notShipped = ["**/scripts/**", "**/test/**", "**/tests/**", "**/fixtures/**", "**/*.md"];

/** The commits Beta and the bun.lock repair push to main, which change no source. */
const automatedTitle = /\[skip ci\]$/u;

/** The most characters the listed lines may hold together; later changes are left out. */
const maxNotesLength = 10_000;
/** The most releases `--json` lists, this one included. */
const maxHistory = 20;

const areas = ["All installs", "CLI and desktop", "Self-host", "Other"] as const;
type Area = (typeof areas)[number];

const git = (args: ReadonlyArray<string>, cwd?: string) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("git", ["-c", "core.quotePath=false", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr: stderr.trim(), exitCode: Number(exitCode) };
  }).pipe(Effect.scoped);

const gitOk = (args: ReadonlyArray<string>, cwd?: string) =>
  git(args, cwd).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(
            new ReleaseNotesFailed({
              message: `git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr}`,
            }),
          ),
    ),
  );

/**
 * The `count` releases before `version` in the public repository, oldest first, each with the
 * commit of this one it exports, or why it has none. The last, the release before this one, must
 * have one; an earlier release without one is only left out of the history (`--json`).
 */
const earlierReleases = (version: typeof ReleaseVersion.Type, publicRepo: string, count: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // A short outage of the public repository should not fail a publishing run.
    const patient = <A, E, R>(read: Effect.Effect<A, E, R>) =>
      read.pipe(Effect.retry({ schedule: Schedule.exponential(2_000), times: 4 }));
    const tags = (yield* patient(
      gitOk(["ls-remote", "--tags", "--refs", publicRepo, "executor@*"]),
    ))
      .split("\n")
      .flatMap((line) => {
        const tag = line.split("\t")[1]?.replace(/^refs\/tags\//u, "");
        const parsed = Schema.decodeUnknownOption(ReleaseVersion)(tag?.replace(/^executor@/u, ""));
        return Option.isSome(parsed) && compareReleaseVersions(parsed.value, version) < 0
          ? [parsed.value]
          : [];
      })
      .sort(compareReleaseVersions)
      .slice(-count);
    const previous = tags.at(-1);
    if (previous === undefined)
      return yield* new ReleaseNotesFailed({
        message: `${publicRepo} has no executor@ release tag below ${version}.`,
      });
    // A scratch repository, so this checkout gets no shallow public commit.
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "executor-release-notes-" });
    yield* gitOk(["init", "--quiet"], scratch);
    yield* patient(
      gitOk(
        [
          "fetch",
          "--quiet",
          "--depth=1",
          "--filter=tree:0",
          publicRepo,
          ...tags.map((tag) => `refs/tags/executor@${tag}:refs/tags/executor@${tag}`),
        ],
        scratch,
      ),
    );
    // Each release has a source, or why it has none.
    const releases: Array<
      { readonly version: typeof ReleaseVersion.Type } & (
        | { readonly source: string; readonly missing?: undefined }
        | { readonly source?: undefined; readonly missing: string }
      )
    > = [];
    for (const tag of tags) {
      const subject = (yield* gitOk(
        ["log", "-1", "--format=%s", `refs/tags/executor@${tag}`],
        scratch,
      )).trim();
      const exported = /^Export ([0-9a-f]{7,40})$/u.exec(subject)?.[1];
      if (exported === undefined) {
        releases.push({
          version: tag,
          missing: `executor@${tag} in ${publicRepo} is "${subject}", not the "Export <sha>" commit scripts/export-public.sh makes, so its source is unknown.`,
        });
        continue;
      }
      const source = yield* git(["rev-parse", "--verify", "--quiet", `${exported}^{commit}`]);
      releases.push(
        source.exitCode === 0
          ? { version: tag, source: source.stdout.trim() }
          : {
              version: tag,
              missing: `executor@${tag} exports ${exported}, which this checkout does not hold. It needs main's history (fetch-depth: 0).`,
            },
      );
    }
    const last = releases.at(-1)!;
    if (last.source === undefined) return yield* new ReleaseNotesFailed({ message: last.missing });
    return { previous: { version: last.version, source: last.source }, releases };
  }).pipe(Effect.scoped);

interface Commit {
  readonly sha: string;
  /** Private: used only to match a revert to its target, never printed. */
  readonly title: string;
  readonly message: string;
  readonly files: ReadonlyArray<string>;
}

/**
 * Main's commits after `from` up to `to`, oldest first, with the files each changed. Without rename
 * detection, which reads file contents: the metadata job's checkout has none, and no credentials to
 * fetch them, and a renamed file's two paths classify it as well as one.
 */
const commitsBetween = (from: string, to: string) =>
  gitOk([
    "log",
    "--first-parent",
    "--diff-merges=first-parent",
    "--no-renames",
    "--reverse",
    "--name-only",
    "--format=%x1e%H%x1f%s%x1f%B%x1f",
    `${from}..${to}`,
  ]).pipe(
    Effect.map((log) =>
      log
        .split("\x1e")
        .slice(1)
        .map((entry): Commit => {
          const [sha = "", title = "", message = "", files = ""] = entry.split("\x1f");
          return {
            sha,
            title,
            message,
            files: files.split("\n").filter((file) => file !== ""),
          };
        }),
    ),
  );

/** A title without its private pull request number. */
const bareTitle = (title: string) => title.replace(/\s*\(#\d+\)$/u, "").trim();

/**
 * What lets GitHub's Markdown hide a line from whoever reads the message rendered: HTML (a comment,
 * `<details>` or an attribute), a link definition's title, math, and code fences. A message that
 * holds any of them has no notes.
 */
const hiding = ["<", "[", "$", "```", "~~~"];

/**
 * What a `Co-authored-by:` trailer writes: an email address, `<name@host>`, and a bot's name ending
 * `[bot]` right after a letter or digit. No tag, comment or link definition starts this way, so
 * these are the only places `hiding` allows `<` or `[`, and only on a `coAuthor` line, which holds
 * one address, at its end, and no other `<`, `>`, `[` or `]`.
 */
const trailerParts = /<[A-Za-z0-9._+-]+(?:\[bot\])?@[A-Za-z0-9.-]+>|(?<=[A-Za-z0-9-])\[bot\]/gu;

/**
 * A line that is, whole, a `Co-authored-by: <name> <address>` trailer (the key in any case, as git
 * reads it), the only trailer main's messages give an address, with nothing after it but spaces: a
 * name with no `<`, `>`, `[`, `]`, `$`, backtick or control character but a closing `[bot]`, and an
 * address `<local@host>` of letters, digits and `._+-` (a bot's local part ending `[bot]`), and
 * letters, digits, dots and hyphens. It may be any line of a message: a squash joins its commits'
 * messages, so a port's own trailers sit in the middle.
 */
const coAuthor =
  /^Co-authored-by: [^<>[\]$`\p{Cc}]+?(?:(?<=[A-Za-z0-9-])\[bot\])? <(?<address>[A-Za-z0-9._+-]+(?:\[bot\])?@[A-Za-z0-9.-]+)> *$/iu;

/**
 * The `coAuthor` lines of a message's trailer block, by index: its last paragraph, after the
 * title's, when every line of it is a trailer (`Key: value`). A port's credit reads only these.
 */
const coAuthors = (lines: ReadonlyArray<string>) => {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  let start = end;
  while (start > 0 && lines[start - 1]!.trim() !== "") start -= 1;
  const block = lines.slice(start, end);
  if (start === 0 || !block.every((line) => /^[A-Za-z0-9][A-Za-z0-9-]*: \S/u.test(line))) return [];
  return block.flatMap((line, offset) => {
    const address = coAuthor.exec(line)?.groups?.address;
    return address === undefined ? [] : [{ index: start + offset, address }];
  });
};

/**
 * A commit message's notes: each line of its body that starts with `Release-note: <text>`, in order
 * and once each, `none` and empty ones aside, and accepted by `refusal`. A message that holds any
 * of `hiding` outside the `trailerParts` of its `coAuthor` lines has none, and `hiddenBy` says which.
 * Any other line that holds `Release-note:` is returned as ignored, and a note `refusal` refuses as
 * refused, both by line number.
 */
const notesOf = (message: string) => {
  const notes: Array<string> = [];
  const ignored: Array<{ readonly line: number; readonly reason: string }> = [];
  const refused: Array<{ readonly line: number; readonly reason: string }> = [];
  const lines = message.split("\n").map((line) => line.replace(/\r$/u, ""));
  const mentioned = lines.some((line) => /release-note:/iu.test(line));
  const bare = lines
    .map((line) => (coAuthor.test(line) ? line.replace(trailerParts, " ") : line))
    .join("\n");
  const hiddenBy = mentioned ? hiding.find((marker) => bare.includes(marker)) : undefined;
  if (!mentioned || hiddenBy !== undefined) return { notes, ignored, refused, hiddenBy };
  for (const [index, line] of lines.entries()) {
    if (!/release-note:/iu.test(line)) continue;
    // The title: private, and never a note.
    if (index === 0) {
      ignored.push({ line: 1, reason: "in the title" });
      continue;
    }
    const note = /^Release-note:[ \t]*(.*?)[ \t]*$/iu.exec(line);
    if (note === null) {
      ignored.push({
        line: index + 1,
        reason: /^\s*>/u.test(line)
          ? "quoted"
          : /^\s/u.test(line)
            ? "indented"
            : "other than at the start of its line",
      });
      continue;
    }
    const text = note[1]!;
    if (text === "" || text.toLowerCase() === "none") continue;
    const reason = refusal(text);
    if (reason !== undefined) refused.push({ line: index + 1, reason });
    else if (!notes.includes(text)) notes.push(text);
  }
  return { notes, ignored, refused, hiddenBy };
};

/**
 * A port's marker, as scripts/export-public.sh reads it: the public repository, exactly, a pull
 * request number of at most nine digits and the 40-hex head it ported.
 */
const escapedRepository = release.repository.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
const publicPr = new RegExp(
  `^Public-PR: ${escapedRepository}#([1-9][0-9]{0,8}) [0-9a-f]{40}[ \\t]*$`,
  "u",
);

/**
 * A users.noreply.github.com address and the GitHub handle it names, without its `id+` prefix:
 * letters, digits and single hyphens between them, at most 39 characters.
 */
const noreply =
  /^(?:[0-9]+\+)?(?<handle>(?=[A-Za-z0-9-]{1,39}@)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)@users\.noreply\.github\.com$/u;

/**
 * The public pull request a commit ports, from its first `publicPr` line, and the handles of its
 * `coAuthors`, bots aside. The credit is built from these alone. `unread` are the lines that start
 * `Public-PR:` but are no marker, and `unnamed` the co-authors with no `noreply` handle, by line.
 */
const port = (message: string) => {
  const lines = message.split("\n").map((line) => line.replace(/\r$/u, ""));
  const markers = lines.flatMap((line, index) =>
    /^\s*public-pr:/iu.test(line) ? [{ line: index + 1, number: publicPr.exec(line)?.[1] }] : [],
  );
  const number = markers.find((marker) => marker.number !== undefined)?.number;
  const unread = markers.filter((marker) => marker.number === undefined).map(({ line }) => line);
  const handles: Array<string> = [];
  const unnamed: Array<number> = [];
  for (const { index, address } of coAuthors(lines)) {
    if (/\[bot\]@/u.test(address)) continue;
    const handle = noreply.exec(address)?.groups?.handle;
    if (handle === undefined) unnamed.push(index + 1);
    else if (!handles.includes(handle)) handles.push(handle);
  }
  return {
    number: number === undefined ? undefined : Number(number),
    handles,
    unread,
    unnamed,
  };
};

const parseArguments = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const options: Record<string, string> = {};
    for (let index = 0; index < argv.length; index += 2) {
      const name = argv[index]!;
      const value = argv[index + 1];
      if (
        !["--version", "--to", "--output", "--json", "--history"].includes(name) ||
        value === undefined
      )
        return yield* new ReleaseNotesFailed({
          message: `Usage: release-notes.ts [--version <version>] [--to <commit>] [--output <file>] [--json <file> [--history <releases>]]; got ${argv.join(" ")}`,
        });
      options[name.slice(2)] = value;
    }
    return options;
  });

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const options = yield* parseArguments(process.argv.slice(2));
    const version = yield* Schema.decodeUnknownEffect(ReleaseVersion)(
      options.version ?? release.version,
    ).pipe(
      Effect.mapError(
        () => new ReleaseNotesFailed({ message: `${options.version} is not a release version.` }),
      ),
    );
    const to = (yield* gitOk(["rev-parse", "--verify", `${options.to ?? "HEAD"}^{commit}`])).trim();
    const publicRepo = process.env.PUBLIC_REPO || `https://github.com/${release.repository}.git`;
    const history = Number(options.history ?? "1");
    if (!Number.isInteger(history) || history < 1 || history > maxHistory)
      return yield* new ReleaseNotesFailed({
        message: `--history takes a whole number from 1 to ${maxHistory}; got ${options.history}.`,
      });
    const { previous, releases } = yield* earlierReleases(version, publicRepo, history);
    const ancestor = yield* git(["merge-base", "--is-ancestor", previous.source, to]);
    if (ancestor.exitCode !== 0)
      return yield* new ReleaseNotesFailed({
        message: `executor@${previous.version} was built from ${previous.source}, which is not in the history of ${to}.`,
      });

    const shipped = yield* shippedSources;
    const everything = [...new Set([...shipped.local, ...shipped.image])];
    const localOnly = shipped.local.filter((glob) => !shipped.image.includes(glob));
    const imageOnly = shipped.image.filter((glob) => !shipped.local.includes(glob));

    // The job log is private: a warning names a commit, and never its title or its note.
    const warn = (sha: string, message: string) =>
      Console.warn(`::warning title=Release notes::${sha} ${message}`);
    /**
     * The changes main's commits after `from` up to `to` list: as the notes' Markdown lines by area,
     * with a port's credit, and as plain notes, each its area and text alone. `warn` reports what
     * is left out, and why.
     */
    const listChanges = (
      from: string,
      to: string,
      warn: (sha: string, message: string) => Effect.Effect<void>,
    ) =>
      Effect.gen(function* () {
        const commits = yield* commitsBetween(from, to);
        // A revert and the commit it reverts cancel. Newest first, so a revert that is itself reverted
        // cancels nothing, and the change it reverted stands. GitHub cuts a long reverted title with "…".
        const cancelled = new Set<string>();
        for (let index = commits.length - 1; index >= 0; index -= 1) {
          const commit = commits[index]!;
          if (cancelled.has(commit.sha)) continue;
          const reverted = /^Revert "(.+)"$/u.exec(bareTitle(commit.title))?.[1];
          if (reverted === undefined) continue;
          const wanted = bareTitle(reverted);
          const matches = (title: string) =>
            wanted.endsWith("…") ? title.startsWith(wanted.slice(0, -1)) : title === wanted;
          const target = commits
            .slice(0, index)
            .findLast(
              (earlier) => !cancelled.has(earlier.sha) && matches(bareTitle(earlier.title)),
            );
          if (target === undefined) continue;
          cancelled.add(target.sha);
          cancelled.add(commit.sha);
        }

        const listed = new Map<Area, Array<string>>(areas.map((area) => [area, []]));
        const plain: Array<{ readonly area: Area; readonly text: string }> = [];
        const credited = new Set<number>();
        let other = 0;
        let length = 0;
        for (const commit of commits) {
          if (automatedTitle.test(commit.title)) continue;
          const { notes, ignored, refused, hiddenBy } = notesOf(commit.message);
          if (hiddenBy !== undefined)
            yield* warn(
              commit.sha,
              `has a message that holds ${JSON.stringify(hiddenBy)}, which can hide text when GitHub renders it, so none of its Release-note: lines are counted.`,
            );
          for (const { line, reason } of ignored)
            yield* warn(
              commit.sha,
              `line ${line} has Release-note: ${reason}, so it is not counted.`,
            );
          for (const { line, reason } of refused)
            yield* warn(
              commit.sha,
              `line ${line} has a Release-note: line that ${reason}, so the notes leave it out.`,
            );
          if (cancelled.has(commit.sha)) {
            if (notes.length > 0)
              yield* warn(
                commit.sha,
                "has a Release-note: line, but a revert in this release cancels it, so the notes leave it out.",
              );
            continue;
          }
          if (notes.length === 0) {
            other += 1;
            continue;
          }
          const files = commit.files.filter(
            (file) => matchesAny(everything, file) && !matchesAny(notShipped, file),
          );
          const { number: ported, handles, unread, unnamed } = port(commit.message);
          for (const line of unread)
            yield* warn(
              commit.sha,
              `line ${line} has a Public-PR: line that is not Public-PR: ${release.repository}#<number> <40-hex sha>, so the notes credit nothing from it.`,
            );
          if (ported !== undefined)
            for (const line of unnamed)
              yield* warn(
                commit.sha,
                `line ${line} has a Co-authored-by: trailer without a users.noreply.github.com address that names a GitHub handle, so the notes thank no one for it.`,
              );
          if (ported === undefined && files.length === 0) {
            yield* warn(
              commit.sha,
              "has a Release-note: line on a change to nothing a release ships (Cloud-only, CI, tests or tooling), so the notes leave it out.",
            );
            other += 1;
            continue;
          }
          if (ported !== undefined && credited.has(ported)) {
            yield* warn(
              commit.sha,
              `has a Release-note: line on a port of public #${ported}, which an earlier change already lists, so the notes leave it out.`,
            );
            other += 1;
            continue;
          }
          // The one link and mention in the notes, built only from `publicPr`'s number and `noreply`'s
          // handles: both public, and neither free text.
          const credit =
            ported === undefined
              ? ""
              : ` ([#${ported}](https://github.com/${release.repository}/pull/${ported})${
                  handles.length > 0
                    ? `, thanks ${handles.map((handle) => `@${handle}`).join(", ")}`
                    : ""
                })`;
          // An accepted note renders as its text alone, so it is printed as written.
          const lines = notes.map((note) => `- ${note}${credit}`);
          const added = lines.reduce((total, line) => total + line.length, 0);
          // Once one change does not fit, later ones do not either, so the notes keep merge order.
          if (length + added > maxNotesLength) {
            length = maxNotesLength;
            yield* warn(
              commit.sha,
              `has a Release-note: line past the ${maxNotesLength.toLocaleString("en-US")} characters the notes hold, so the notes leave it out.`,
            );
            other += 1;
            continue;
          }
          length += added;
          const area: Area =
            files.length === 0
              ? "Other"
              : files.every((file) => matchesAny(localOnly, file))
                ? "CLI and desktop"
                : files.every((file) => matchesAny(imageOnly, file))
                  ? "Self-host"
                  : "All installs";
          if (ported !== undefined) credited.add(ported);
          listed.get(area)!.push(...lines);
          plain.push(...notes.map((text) => ({ area, text })));
        }
        return { listed, plain, other, length };
      });
    const { listed, other } = yield* listChanges(previous.source, to, warn);

    const sections = areas.flatMap((area) => {
      const lines = listed.get(area)!;
      return lines.length === 0 ? [] : [`### ${area}`, "", ...lines, ""];
    });
    const changes = (count: number) => (count === 1 ? "change" : "changes");
    const summary =
      sections.length > 0
        ? [
            ...sections,
            ...(other === 0 ? [] : [`Not listed: ${other} other ${changes(other)}.`, ""]),
          ]
        : other > 0
          ? [
              "No release notes were written for this release.",
              "",
              `Not listed: ${other} ${changes(other)}.`,
              "",
            ]
          : [`No changes since ${previous.version}.`, ""];
    const readme = yield* fs.readFileString(
      path.join(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))), "README.md"),
    );
    // The README's first section, the install instructions, without its own heading.
    const install = readme
      .split(/^## /mu)[0]!
      .replace(/^# .*\n/u, "")
      .trim();
    const notes = [
      `## Changes since ${previous.version}`,
      "",
      ...summary,
      "## Install",
      "",
      install,
      "",
    ].join("\n");

    if (options.output === undefined) yield* Console.log(notes);
    else {
      yield* fs.makeDirectory(path.dirname(options.output), { recursive: true });
      yield* fs.writeFileString(options.output, notes);
    }

    if (options.json === undefined) return;
    // The same notes as plain text, for the products to show: this release's, then each earlier
    // release's against the release before it, newest first, back to the newest release whose
    // source or whose predecessor's is unknown. That release and every one before it are left out,
    // so `since`, the release before the oldest listed, says how far back the list is whole. A
    // reader cannot tell a gap from the versions alone, so the list has none. The left-out
    // releases' own warnings were the job log's when they were published, so they are not repeated.
    const plain: Array<NotesHistory["releases"][number]> = [
      { version, notes: (yield* listChanges(previous.source, to, () => Effect.void)).plain },
    ];
    let since = previous.version;
    const leftOut = (version: string, reason: string) =>
      Console.warn(
        `::warning title=Release notes::executor@${version} and the releases before it are left out of the JSON history: ${reason}`,
      );
    for (let index = releases.length - 1; index >= 1; index -= 1) {
      const current = releases[index]!;
      const before = releases[index - 1]!;
      if (current.source === undefined) {
        yield* leftOut(current.version, current.missing);
        break;
      }
      if (before.source === undefined) {
        yield* leftOut(current.version, before.missing);
        break;
      }
      const ordered = yield* git(["merge-base", "--is-ancestor", before.source, current.source]);
      if (ordered.exitCode !== 0) {
        yield* leftOut(
          current.version,
          `executor@${before.version} was not built from its history.`,
        );
        break;
      }
      const { plain: listed } = yield* listChanges(
        before.source,
        current.source,
        () => Effect.void,
      );
      plain.push({ version: current.version, notes: listed });
      since = before.version;
    }
    const written: NotesHistory = { since, releases: plain };
    // The feed refuses notes that break its rule; stop here rather than write them.
    const problem = notesHistoryProblem(written, version);
    if (problem !== undefined)
      return yield* new ReleaseNotesFailed({ message: `The JSON history ${problem}.` });
    yield* fs.makeDirectory(path.dirname(options.json), { recursive: true });
    yield* fs.writeFileString(options.json, `${JSON.stringify(written, null, 2)}\n`);
  }).pipe(Effect.provide(NodeServices.layer)),
);
