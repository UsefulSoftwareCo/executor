import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Option, Path, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { matchesAny, shippedSources } from "../../e2e/release-lanes.ts";
import { compareReleaseVersions, release, ReleaseVersion } from "./config.ts";
import {
  cloudNoteDays,
  kindOfNote,
  type NoteKind,
  type NoteProduct,
  noteProductNames,
  noteProducts,
  refusal,
} from "@executor-js/utils/release-notes";
import { notDeployInputs } from "../../apps/hosted/cloud/src/infrastructure/deploy-inputs.ts";
import { type NotesHistory, notesHistoryProblem } from "./notes-history.ts";
import { cloudLead } from "./cloud-lead.ts";
import { noteAudience, noteHash } from "./note-audiences.ts";
import { earlierNoteKind } from "./note-kinds.ts";

class ReleaseNotesFailed extends Schema.TaggedError<ReleaseNotesFailed>()("ReleaseNotesFailed", {
  message: Schema.String,
}) {}

const selfHostOnly = ["apps/hosted/self-host/**"];

const documents = ["apps/docs/**", "**/*.mdx", ".changeset/**"];

const notShipped = ["**/scripts/**", "**/test/**", "**/tests/**", "**/fixtures/**", "**/*.md"];

const automatedTitle = /\[skip ci\]$/u;

const maxNotesLength = 10_000;
const maxHistory = 20;
const cloudWindowDays = cloudNoteDays;
const cloudMaxNotes = 10;

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

const earlierReleases = (version: typeof ReleaseVersion.Type, publicRepo: string, count: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
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
  readonly date: string;
  readonly title: string;
  readonly message: string;
  readonly files: ReadonlyArray<string>;
}

const commitsBetween = (from: string | undefined, to: string) =>
  gitOk([
    "log",
    "--first-parent",
    "--diff-merges=first-parent",
    "--no-renames",
    "--reverse",
    "--name-only",
    "--format=%x1e%H%x1f%cI%x1f%s%x1f%B%x1f",
    from === undefined ? to : `${from}..${to}`,
  ]).pipe(
    Effect.map((log) =>
      log
        .split("\x1e")
        .slice(1)
        .map((entry): Commit => {
          const [sha = "", date = "", title = "", message = "", files = ""] = entry.split("\x1f");
          return {
            sha,
            date,
            title,
            message,
            files: files.split("\n").filter((file) => file !== ""),
          };
        }),
    ),
  );

const bareTitle = (title: string) => title.replace(/\s*\(#\d+\)$/u, "").trim();

const hiding = ["<", "[", "$", "```", "~~~"];

const trailerParts = /<[A-Za-z0-9._+-]+(?:\[bot\])?@[A-Za-z0-9.-]+>|(?<=[A-Za-z0-9-])\[bot\]/gu;

const coAuthor =
  /^Co-authored-by: [^<>[\]$`\p{Cc}]+?(?:(?<=[A-Za-z0-9-])\[bot\])? <(?<address>[A-Za-z0-9._+-]+(?:\[bot\])?@[A-Za-z0-9.-]+)> *$/iu;

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

const notesOf = (message: string) => {
  const notes: Array<{ readonly text: string; readonly kind: NoteKind }> = [];
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
    if (note[1] === "" || note[1]!.toLowerCase() === "none") continue;
    const { kind, text } = kindOfNote(note[1]!);
    const reason =
      text === "" || text.toLowerCase() === "none"
        ? `names its kind, ${kind}, but no note after it`
        : refusal(text);
    if (reason !== undefined) refused.push({ line: index + 1, reason });
    else if (!notes.some((listed) => listed.text === text)) notes.push({ kind, text });
  }
  return { notes, ignored, refused, hiddenBy };
};

const escapedRepository = release.repository.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
const publicPr = new RegExp(
  `^Public-PR: ${escapedRepository}#([1-9][0-9]{0,8}) [0-9a-f]{40}[ \\t]*$`,
  "u",
);

const noreply =
  /^(?:[0-9]+\+)?(?<handle>(?=[A-Za-z0-9-]{1,39}@)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)@users\.noreply\.github\.com$/u;

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

const squashed = (title: string, commits: ReadonlyArray<{ subject: string; body: string }>) =>
  commits.length === 1
    ? `${commits[0]!.subject}\n\n${commits[0]!.body}`
    : [title, ...commits.map(({ subject, body }) => `* ${subject}\n\n${body}`)].join("\n\n");

const audienceText = (audience: ReadonlyArray<NoteProduct>) =>
  audience.map((product) => noteProductNames[product]).join(", ");

const someFiles = (files: ReadonlyArray<string>) =>
  files.length <= 3
    ? files.join(", ")
    : `${files.slice(0, 3).join(", ")} and ${files.length - 3} more`;

const checkBranch = (
  base: string,
  title: string,
  reachOf: (files: ReadonlyArray<string>) => Readonly<Record<NoteProduct, ReadonlyArray<string>>>,
) =>
  Effect.gen(function* () {
    const log = yield* gitOk(["log", "--reverse", "--format=%x1e%s%x1f%b", `${base}..HEAD`]);
    const commits = log
      .split("\x1e")
      .slice(1)
      .map((entry) => {
        const [subject = "", body = ""] = entry.split("\x1f");
        return { subject, body: body.trimEnd() };
      });
    if (commits.length === 0) {
      yield* Console.log(`No commits since ${base}.`);
      return [];
    }
    const message = squashed(title, commits);
    const { notes, ignored, refused, hiddenBy } = notesOf(message);
    const ported = port(message).number !== undefined;
    const reaching = reachOf(
      (yield* gitOk(["diff", "--no-renames", "--name-only", `${base}...HEAD`]))
        .split("\n")
        .filter((file) => file !== ""),
    );
    const reached = noteProducts.filter((product) => reaching[product].length > 0);
    const problems = [
      ...(hiddenBy === undefined
        ? []
        : [
            `the squashed message holds ${JSON.stringify(hiddenBy)}, which can hide text when GitHub renders it, so none of its Release-note: lines would be counted`,
          ]),
      ...ignored.map(
        ({ line, reason }) => `line ${line} of the squashed message has Release-note: ${reason}`,
      ),
      ...refused.map(
        ({ line, reason }) =>
          `line ${line} of the squashed message has a Release-note: line that ${reason}`,
      ),
    ];
    for (const note of notes) {
      const audience = noteAudience(note.text);
      const hash = noteHash(note.text);
      const change =
        "to change that, add an entry with its hash and the products it is for to scripts/releases/note-audiences.ts";
      const why = reached
        .map((product) => `${noteProductNames[product]}: ${someFiles(reaching[product])}`)
        .join("; ");
      const unreached = (audience ?? []).filter((product) => !reached.includes(product));
      const portLine =
        ported &&
        audience === undefined &&
        !reached.includes("local") &&
        !reached.includes("self-host")
          ? [
              "  As a port of a public pull request, it is also listed in the public release under Other, with its credit.",
            ]
          : [];
      const shown =
        audience !== undefined
          ? [
              `  Shown to: ${audienceText(audience)}, as scripts/releases/note-audiences.ts says for its hash. ${
                reached.length === 0
                  ? "By its files this change reaches no product."
                  : `By its files this change reaches ${audienceText(reached)} (${why}).`
              }`,
              ...(unreached.length === 0
                ? []
                : [
                    `  The entry names ${audienceText(unreached)}, which this change's files do not reach: keep that only if their users will notice the change.`,
                  ]),
            ]
          : reached.length === 0
            ? [
                "  Shown to: no product, since this change touches only scripts, tests, fixtures, documents, CI or tooling, which no product ships.",
                `  If users will notice it, ${change}.`,
              ]
            : [
                `  Shown to: ${audienceText(reached)}, the products this change reaches (${why}).`,
                `  If the users of one of them would not notice it, ${change}.`,
              ];
      yield* Console.log(
        [
          `Release-note accepted: ${note.text}`,
          `  Kind: ${note.kind}${
            note.kind === "fix"
              ? ", so Cloud's what's new never leads with it (write Feature: or Improvement: before a note that is one)"
              : ""
          }`,
          ...shown,
          `  Hash: ${hash}`,
          ...portLine,
        ].join("\n"),
      );
    }
    if (notes.length > 0)
      yield* Console.log(
        'Who a note is for is the writer\'s call: see "Release notes" in RELEASING.md.',
      );
    if (problems.length > 0)
      return yield* new ReleaseNotesFailed({
        message: [
          'These Release-note: lines would be left out of the release notes (RELEASING.md, "Release notes"):',
          ...problems.map((problem) => `- ${problem}`),
        ].join("\n"),
      });
    if (notes.length === 0) yield* Console.log("No Release-note: line in the branch's commits.");
    return notes
      .filter(({ text }) => (noteAudience(text) ?? reached).includes("cloud"))
      .map(({ text }) => text);
  });

const parseArguments = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const options: Record<string, string> = {};
    for (let index = 0; index < argv.length; index += 2) {
      const name = argv[index]!;
      const value = argv[index + 1];
      if (
        ![
          "--version",
          "--to",
          "--output",
          "--json",
          "--history",
          "--cloud",
          "--check",
          "--title",
        ].includes(name) ||
        value === undefined
      )
        return yield* new ReleaseNotesFailed({
          message: `Usage: release-notes.ts [--version <version>] [--to <commit>] [--output <file>] [--json <file> [--history <releases>]], or release-notes.ts --cloud <file or -> [--to <commit>], or release-notes.ts --check <base> [--title <pull request title>]; got ${argv.join(" ")}`,
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
    const shipped = yield* shippedSources;
    const localOnly = shipped.local.filter((glob) => !shipped.image.includes(glob));
    const reachesCloud = (file: string) =>
      !notDeployInputs.some((entry) => entry.path.test(file)) &&
      !matchesAny([...notShipped, ...documents], file) &&
      !matchesAny([...localOnly, ...selfHostOnly], file);
    const reachOf = (files: ReadonlyArray<string>): Record<NoteProduct, ReadonlyArray<string>> => {
      const builtFrom = (globs: ReadonlyArray<string>) =>
        files.filter((file) => matchesAny(globs, file) && !matchesAny(notShipped, file));
      return {
        cloud: files.filter(reachesCloud),
        local: builtFrom(shipped.local),
        "self-host": builtFrom(shipped.image),
      };
    };
    const version = yield* Schema.decodeUnknownEffect(ReleaseVersion)(
      options.version ?? release.version,
    ).pipe(
      Effect.mapError(
        () => new ReleaseNotesFailed({ message: `${options.version} is not a release version.` }),
      ),
    );
    const to = (yield* gitOk(["rev-parse", "--verify", `${options.to ?? "HEAD"}^{commit}`])).trim();
    const areaOf = (audience: ReadonlyArray<NoteProduct>): Area | undefined =>
      audience.includes("local") && audience.includes("self-host")
        ? "All installs"
        : audience.includes("local")
          ? "CLI and desktop"
          : audience.includes("self-host")
            ? "Self-host"
            : undefined;

    const warn = (sha: string, message: string) =>
      Console.warn(`::warning title=Release notes::${sha} ${message}`);
    const listChanges = (
      from: string | undefined,
      to: string,
      warn: (sha: string, message: string) => Effect.Effect<void>,
      reach: "release" | "cloud" = "release",
    ) =>
      Effect.gen(function* () {
        const commits = yield* commitsBetween(from, to);
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
        const plain: Array<{
          readonly area: Area;
          readonly text: string;
          readonly kind: NoteKind;
          readonly date: string;
          readonly sha: string;
        }> = [];
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
          const reaching = reachOf(commit.files);
          const reached = noteProducts.filter((product) => reaching[product].length > 0);
          const addressed = notes.map((note) => {
            const audience = noteAudience(note.text);
            return { ...note, stated: audience !== undefined, audience: audience ?? reached };
          });
          const shown = addressed.flatMap((note) => {
            if (reach === "cloud")
              return note.audience.includes("cloud")
                ? [{ ...note, area: areaOf(note.audience) ?? "Other" }]
                : [];
            const area =
              areaOf(note.audience) ?? (ported !== undefined && !note.stated ? "Other" : undefined);
            return area === undefined ? [] : [{ ...note, area }];
          });
          if (
            reach === "release" &&
            ported === undefined &&
            areaOf(reached) === undefined &&
            addressed.some((note) => !note.stated)
          )
            yield* warn(
              commit.sha,
              "has a Release-note: line on a change to nothing a release ships (Cloud-only, CI, tests or tooling), so the notes leave it out.",
            );
          if (shown.length === 0) {
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
          const credit =
            ported === undefined
              ? ""
              : ` ([#${ported}](https://github.com/${release.repository}/pull/${ported})${
                  handles.length > 0
                    ? `, thanks ${handles.map((handle) => `@${handle}`).join(", ")}`
                    : ""
                })`;
          const lines = shown.map((note) => ({ area: note.area, line: `- ${note.text}${credit}` }));
          const added = lines.reduce((total, { line }) => total + line.length, 0);
          if (reach === "release" && length + added > maxNotesLength) {
            length = maxNotesLength;
            yield* warn(
              commit.sha,
              `has a Release-note: line past the ${maxNotesLength.toLocaleString("en-US")} characters the notes hold, so the notes leave it out.`,
            );
            other += 1;
            continue;
          }
          length += added;
          if (ported !== undefined) credited.add(ported);
          for (const { area, line } of lines) listed.get(area)!.push(line);
          plain.push(
            ...shown.map(({ area, text, kind }) => ({
              area,
              text,
              kind: kind === "fix" ? (earlierNoteKind(commit.title, text) ?? kind) : kind,
              date: commit.date,
              sha: commit.sha,
            })),
          );
        }
        return { listed, plain, other, length };
      });

    const pin =
      process.env.EXECUTOR_CLOUD_LEAD === undefined
        ? cloudLead[0]?.hash
        : process.env.EXECUTOR_CLOUD_LEAD || undefined;
    const cloudWindow = (end: string, report: typeof warn) =>
      Effect.gen(function* () {
        const endDate = new Date((yield* gitOk(["log", "-1", "--format=%cI", end])).trim());
        const start = new Date(endDate.getTime() - cloudWindowDays * 24 * 60 * 60 * 1000);
        const grafts = (yield* gitOk(["rev-parse", "--git-path", "info/grafts"])).trim();
        const replaced = (yield* gitOk(["replace", "--list"])).trim();
        if ((yield* fs.exists(grafts)) || replaced !== "")
          return yield* new ReleaseNotesFailed({
            message: `This checkout ${replaced !== "" ? "replaces commits (git replace)" : `grafts its history (${grafts})`}, so it cannot show main's history as it is. Write Cloud's notes from a checkout without them.`,
          });
        const before = (yield* gitOk([
          "rev-list",
          "-1",
          "--first-parent",
          `--before=${start.toISOString()}`,
          end,
        ])).trim();
        if (before === "") {
          const oldest = (yield* gitOk(["rev-list", "--first-parent", end]))
            .trim()
            .split("\n")
            .at(-1)!;
          return yield* new ReleaseNotesFailed({
            message: `This checkout's history holds no commit of main from before ${start.toISOString()}, the start of the ${cloudWindowDays} days before ${endDate.toISOString()} that Cloud's notes cover; its oldest is from ${(yield* gitOk(["log", "-1", "--format=%cI", oldest])).trim()}. Write them from a checkout with main's whole history (fetch-depth: 0).`,
          });
        }
        const { plain } = yield* listChanges(before, end, report, "cloud");
        const changes: Array<typeof plain> = [];
        for (const note of plain)
          if (changes.at(-1)?.[0]?.sha === note.sha) changes.at(-1)!.push(note);
          else changes.push([note]);
        return changes.toReversed().flat();
      });

    if (options.check !== undefined) {
      const branch = yield* checkBranch(
        options.check,
        options.title ?? "Pull request title",
        reachOf,
      );
      if (pin === undefined) return;
      const window = yield* cloudWindow(options.check, () => Effect.void).pipe(
        Effect.map((notes) => notes.map(({ text }) => text)),
        Effect.catchTag("ReleaseNotesFailed", (error) => Effect.succeed(error.message)),
      );
      if (typeof window === "string")
        return yield* Console.log(
          `Warning: cannot tell whether the note pinned in scripts/releases/cloud-lead.ts (hash ${pin}) is among Cloud's notes: ${window}`,
        );
      const found = [...window, ...branch].some((text) => noteHash(text) === pin);
      return yield* Console.log(
        found
          ? `Cloud's What's new leads with the note pinned in scripts/releases/cloud-lead.ts (hash ${pin}).`
          : `Warning: the note pinned in scripts/releases/cloud-lead.ts (hash ${pin}) is not among Cloud's notes of the ${cloudWindowDays} days before ${options.check} or this branch's notes for Cloud, so What's new leads with its newest feature or improvement. Remove the pin.`,
      );
    }

    const cloudFile = options.cloud;
    if (cloudFile !== undefined) {
      const newest = yield* cloudWindow(to, warn);
      const pinned = newest.find((note) => noteHash(note.text) === pin);
      if (pin !== undefined && pinned === undefined)
        yield* Console.warn(
          `::warning title=Release notes::The note pinned in scripts/releases/cloud-lead.ts (hash ${pin}) is not among Cloud's notes of the ${cloudWindowDays} days before ${to}, so What's new leads with its newest feature or improvement. Remove the pin.`,
        );
      const shown = newest.slice(0, cloudMaxNotes);
      const kept =
        pinned === undefined || shown.includes(pinned)
          ? shown
          : [...shown.slice(0, cloudMaxNotes - 1), pinned];
      const notes = kept.map((note) => ({
        date: new Date(note.date).toISOString().slice(0, 10),
        text: note.text,
        kind: note.kind,
        ...(note === pinned ? { lead: true as const } : {}),
      }));
      const json = `${JSON.stringify({ notes }, null, 2)}\n`;
      if (cloudFile === "-") return yield* Effect.sync(() => process.stdout.write(json));
      yield* fs.makeDirectory(path.dirname(cloudFile), { recursive: true });
      return yield* fs.writeFileString(cloudFile, json);
    }
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
    const textByArea = (notes: ReadonlyArray<{ readonly area: Area; readonly text: string }>) =>
      notes.map(({ area, text }) => ({ area, text }));
    const plain: Array<NotesHistory["releases"][number]> = [
      {
        version,
        notes: textByArea((yield* listChanges(previous.source, to, () => Effect.void)).plain),
      },
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
      plain.push({ version: current.version, notes: textByArea(listed) });
      since = before.version;
    }
    const written: NotesHistory = { since, releases: plain };
    const problem = notesHistoryProblem(written, version);
    if (problem !== undefined)
      return yield* new ReleaseNotesFailed({ message: `The JSON history ${problem}.` });
    yield* fs.makeDirectory(path.dirname(options.json), { recursive: true });
    yield* fs.writeFileString(options.json, `${JSON.stringify(written, null, 2)}\n`);
  }).pipe(Effect.provide(NodeServices.layer)),
);
