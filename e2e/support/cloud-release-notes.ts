/**
 * The notes every scenario's local Cloud builds its dashboard with, as its notes input
 * (`EXECUTOR_CLOUD_RELEASE_NOTES`, read by apps/hosted/cloud/web/release-notes.ts), newest first as
 * `scripts/releases/release-notes.ts --cloud` writes them, each with the kind its writer gave it.
 * The newest is a feature the release notes' allow-list refuses, which the dashboard must leave out
 * whatever its build holds. The newest accepted one is a fix, and a feature is older still, so the
 * block must lead with the feature, not the newest note. The oldest is more than 30 days before
 * the day the scenario sets the browser's clock to: the build's notes are all shown whatever that
 * clock says, since a deploy writes only the 30 days before its commit.
 */
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { CloudMode } from "../test-plan.ts";

export const cloudTestNotes = {
  notes: [
    { date: "2026-11-14", text: "<b>Refused</b> by the allow-list.", kind: "feature" },
    { date: "2026-11-14", text: "The apps page no longer shows a blank list first.", kind: "fix" },
    { date: "2026-11-14", text: "Apps open from the sidebar in one click.", kind: "feature" },
    { date: "2026-11-12", text: "Search finds apps by the tools they offer.", kind: "improvement" },
    { date: "2026-11-03", text: "Members can leave an organization themselves.", kind: "feature" },
  ],
} as const;

/**
 * The notes file a deploy writes when no change in its window has a note: it holds none. The local
 * Cloud of `e2e:cloud --release-notes empty` builds its dashboard with it.
 */
export const emptyCloudNotes = { notes: [] } as const;

/** One squashed change on main, as the deploy's notes script reads it. */
interface CloudChange {
  readonly title: string;
  readonly body?: string;
  readonly file: string;
}

/**
 * Main's changes for the notes the deploy's own script writes (`release-notes.ts --cloud`), oldest
 * first, after a change from before the 30-day window: so the kind words are read from commit
 * messages and cut off there, as on a deploy, not given in a file.
 *
 * - `fixes`: only fixes, the newest marked `Fix:` and the other unmarked, so neither may lead and
 *   the block shows its plain line.
 * - `feature`: an improvement, a fix and, newest, a feature, which the block leads with.
 */
export const cloudChanges = {
  fixes: [
    {
      title: "Keep search's last result (#2)",
      body: "Release-note: Search no longer drops the last result.",
      file: "apps/hosted/cloud/src/search.ts",
    },
    {
      title: "Fix the apps page (#3)",
      body: "Release-note: Fix: The apps page no longer shows a blank list first.",
      file: "apps/hosted/cloud/web/src/apps.ts",
    },
  ],
  feature: [
    {
      title: "Search by tool (#2)",
      body: "Release-note: Improvement: Search finds apps by the tools they offer.",
      file: "apps/hosted/cloud/src/search.ts",
    },
    {
      title: "Fix the apps page (#3)",
      body: "Release-note: Fix: The apps page no longer shows a blank list first.",
      file: "apps/hosted/cloud/web/src/apps.ts",
    },
    {
      title: "Open apps from the sidebar (#4)",
      body: "Release-note: Feature: Apps open from the sidebar in one click.",
      file: "apps/hosted/cloud/web/src/sidebar.ts",
    },
  ],
} as const satisfies Record<string, ReadonlyArray<CloudChange>>;

/** The notes a Cloud's dashboard can be built with other than `cloudTestNotes`. */
export const cloudNotesSources = ["empty", "fixes", "feature"] as const;
export type CloudNotesSource = (typeof cloudNotesSources)[number];

/** The Cloud mode of the run that builds the dashboard with each source (e2e/test-plan.ts). */
export const cloudNotesModes = {
  empty: "empty-release-notes",
  fixes: "fix-release-notes",
  feature: "feature-release-notes",
} as const satisfies Record<CloudNotesSource, CloudMode>;

/** Each source, as the run's report describes its Cloud. */
export const cloudNotesDescriptions = {
  empty: "an empty notes file",
  fixes: "notes that are all fixes, written from commit messages",
  feature: "notes whose newest is a feature, written from commit messages",
} as const satisfies Record<CloudNotesSource, string>;

class CloudNotesFailed extends Schema.TaggedError<CloudNotesFailed>()("CloudNotesFailed", {
  message: Schema.String,
}) {}

const identity = {
  GIT_AUTHOR_NAME: "Maintainer",
  GIT_AUTHOR_EMAIL: "maintainer@example.com",
  GIT_COMMITTER_NAME: "Maintainer",
  GIT_COMMITTER_EMAIL: "maintainer@example.com",
};

/**
 * The notes input for `source` (`cloudTestNotes` when none), as JSON. For `cloudChanges`, a
 * repository in `directory` holds them as main would, and the deploy's notes script writes the
 * notes from it, as the deploy does.
 */
export const cloudNotesFile = (source: CloudNotesSource | undefined, directory: string) =>
  Effect.gen(function* () {
    if (source === undefined) return JSON.stringify(cloudTestNotes);
    if (source === "empty") return JSON.stringify(emptyCloudNotes);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const script = path.resolve("scripts/releases/release-notes.ts");
    const main = path.join(directory, `release-notes-${source}`);
    yield* fs.remove(main, { recursive: true, force: true });
    yield* fs.makeDirectory(main, { recursive: true });
    const run = (command: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const child = yield* processes.spawn(
          ChildProcess.make(command, args, {
            cwd: main,
            env: { ...process.env, ...identity, ...env },
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
        if (Number(exitCode) !== 0)
          return yield* new CloudNotesFailed({
            message: `${command} ${args.join(" ")} exited ${exitCode} writing the ${source} notes: ${stderr}`,
          });
        return stdout;
      }).pipe(Effect.scoped);
    const commit = (change: CloudChange, date?: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(path.join(main, change.file)), { recursive: true });
        yield* fs.writeFileString(path.join(main, change.file), `${change.title}\n`);
        yield* run("git", ["add", "--all"]);
        const message = path.join(directory, `release-notes-${source}-message`);
        yield* fs.writeFileString(
          message,
          change.body === undefined ? `${change.title}\n` : `${change.title}\n\n${change.body}\n`,
        );
        yield* run(
          "git",
          ["commit", "--quiet", "--file", message],
          date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        );
      });
    yield* run("git", ["init", "--quiet", "--initial-branch=main"]);
    // From before the window, so the script sees the whole of it.
    yield* commit(
      { title: "Start Cloud (#1)", file: "apps/hosted/cloud/src/start.ts" },
      new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    );
    for (const change of cloudChanges[source]) yield* commit(change);
    return yield* run("node", [script, "--cloud", "-"]);
  });
