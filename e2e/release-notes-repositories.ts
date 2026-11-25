import { expect } from "@effect/vitest";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const identity = {
  GIT_AUTHOR_NAME: "Maintainer",
  GIT_AUTHOR_EMAIL: "maintainer@example.com",
  GIT_COMMITTER_NAME: "Maintainer",
  GIT_COMMITTER_EMAIL: "maintainer@example.com",
};

const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make(command, args, {
        cwd,
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
    return { stdout, stderr, exitCode: Number(exitCode) };
  }).pipe(Effect.scoped);

export const git = (cwd: string, ...args: ReadonlyArray<string>) => gitWith({}, cwd, ...args);

export const gitWith = (env: Record<string, string>, cwd: string, ...args: ReadonlyArray<string>) =>
  run("git", args, cwd, env).pipe(
    Effect.tap((result) =>
      Effect.sync(() => expect(result.exitCode, `git ${args.join(" ")}: ${result.stderr}`).toBe(0)),
    ),
    Effect.map((result) => result.stdout.trim()),
  );

export interface Merge {
  readonly title: string;
  readonly body?: string;
  readonly moves?: ReadonlyArray<readonly [string, string]>;
  readonly files: ReadonlyArray<string>;
  readonly date?: string;
}

export const portMarker = `Public-PR: UsefulSoftwareCo/executor#2436 ${"5".repeat(40)}`;
export const portTrailers = [
  "Co-authored-by: Daniel Example <daniel@corp.example>",
  "Co-authored-by: Danizord <1850941+danizord@users.noreply.github.com>",
  "Co-authored-by: devin-ai-integration[bot] <158243242+devin-ai-integration[bot]@users.noreply.github.com>",
].join("\n");

export const repositories = (after: ReadonlyArray<Merge>, before: ReadonlyArray<Merge> = []) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-release-notes-spec-" });
    const main = path.join(directory, "main");
    const published = path.join(directory, "public");
    yield* fs.makeDirectory(main);
    yield* fs.makeDirectory(published);
    yield* git(main, "init", "--quiet", "--initial-branch=main");
    const commit = (merge: Merge) =>
      Effect.gen(function* () {
        for (const [from, to] of merge.moves ?? []) yield* git(main, "mv", from, to);
        for (const file of [...(merge.moves ?? []).map(([, to]) => to), ...merge.files]) {
          yield* fs.makeDirectory(path.dirname(path.join(main, file)), { recursive: true });
          yield* fs.writeFileString(path.join(main, file), `${merge.title}\n`);
        }
        yield* git(main, "add", "--all");
        const message = path.join(directory, "message");
        yield* fs.writeFileString(
          message,
          merge.body === undefined ? `${merge.title}\n` : `${merge.title}\n\n${merge.body}\n`,
        );
        yield* gitWith(
          merge.date === undefined
            ? {}
            : { GIT_AUTHOR_DATE: merge.date, GIT_COMMITTER_DATE: merge.date },
          main,
          "commit",
          "--quiet",
          "--file",
          message,
        );
        return yield* git(main, "rev-parse", "HEAD");
      });
    const first = yield* commit({ title: "Start (#1)", files: ["apps/cli/src/main.ts"] });
    for (const merge of before) yield* commit(merge);
    const beta4 = yield* commit({
      title: "Release 2.0.0-beta.4 [skip ci]",
      files: ["apps/cli/package.json"],
    });
    const merged: Array<string> = [];
    for (const merge of after) merged.push(yield* commit(merge));

    yield* git(published, "init", "--quiet", "--initial-branch=v2-releases");
    const exported = (tag: string, source: string) =>
      Effect.gen(function* () {
        yield* git(published, "commit", "--quiet", "--allow-empty", "-m", `Export ${source}`);
        yield* git(published, "tag", tag);
      });
    yield* git(published, "commit", "--quiet", "--allow-empty", "-m", "Executor 1");
    yield* git(published, "tag", "v1.6.12");
    yield* exported("executor@2.0.0-beta.3", first.slice(0, 7));
    yield* exported("executor@2.0.0-beta.4", beta4.slice(0, 9));
    yield* exported("executor@2.0.0-beta.6", "abcdef0");
    return { main, publicRepo: `file://${published}`, first, beta4, merged };
  });

export const notes = (
  repos: { readonly main: string; readonly publicRepo: string },
  args: ReadonlyArray<string>,
  cloudLead = "",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const option = (name: string) =>
      args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    const json =
      option("--json") ??
      path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "executor-notes-json-" }),
        "notes.json",
      );
    const feedNotes = !args.includes("--cloud") && !args.includes("--check");
    const written = feedNotes
      ? [
          ...args,
          ...(option("--json") === undefined ? ["--json", json] : []),
          ...(option("--history") === undefined ? ["--history", "20"] : []),
        ]
      : args;
    const child = yield* processes.spawn(
      ChildProcess.make("node", [path.resolve("scripts/releases/release-notes.ts"), ...written], {
        cwd: repos.main,
        env: { ...process.env, PUBLIC_REPO: repos.publicRepo, EXECUTOR_CLOUD_LEAD: cloudLead },
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
    if (feedNotes && Number(exitCode) === 0) {
      const version = option("--version");
      const feed = yield* run(
        "node",
        [
          path.resolve("scripts/releases/desktop-feed.ts"),
          "--check-notes",
          json,
          ...(version === undefined ? [] : ["--version", version]),
        ],
        process.cwd(),
      );
      expect(
        feed.exitCode,
        `the desktop feed refuses the notes release-notes.ts ${written.join(" ")} wrote: ${feed.stdout}${feed.stderr}`,
      ).toBe(0);
    }
    return { stdout, stderr, exitCode: Number(exitCode) };
  }).pipe(Effect.scoped);

export const realisticNotes: ReadonlyArray<string> = [
  "Workspaces with many apps load in about half the time.",
  "The desktop app reopens on the workspace you used last.",
  "Signing in again after a long break no longer asks twice.",
  "The CLI explains what to do when it cannot reach the server.",
  "Self-hosted installs start again on their own after a database restart.",
  "You can stop a running tool call from its details page.",
  "Search keeps your query when you come back to it.",
  "Large uploads no longer stall on slow connections.",
  "Keyboard shortcuts work while the sidebar is hidden.",
  "Upgrading keeps the settings you saved.",
  "Each tool result names the account it used.",
  "Copying a result keeps its line breaks.",
  "The app stays responsive when a tool returns a very large answer.",
  "Clicking a notification opens the run it is about.",
  "Startup is 2.5 seconds faster on large workspaces.",
  "Proxy settings now apply to every request Executor makes.",
  "Reconnecting an account keeps its schedules.",
  "The connect screen lists the permissions each app asks for.",
  "Dark mode no longer flashes white when a page loads.",
  "Error messages say which account failed, and why.",
];

export const hexWordNotes: ReadonlyArray<string> = [
  "Send feedback from the help menu.",
  "Your feedback's status shows on the settings page.",
  "The cafe decade theme is gone.",
  "Feedback forms keep what you typed after a reload.",
  "A decade of history loads in seconds.",
  "The facade of the settings page loads first, then the details.",
  "Beaded progress bars are now smooth.",
  "The cabbage icon in the sample app is fixed.",
  "Feedback buttons work with a keyboard.",
  "Faded labels are easier to read in dark mode.",
  "Accessed files show when they were last opened.",
  "Embedded apps load faster.",
  "Added accounts appear at once.",
  "Deactivated users no longer appear in search.",
  "Decaffeinated colors make the theme easier on the eyes.",
  "Feedback from the CLI now includes the version.",
  "Faceted search filters by app and account.",
];

export const acceptedNotes: ReadonlyArray<string> = [
  "Each app's card now shows its accounts.",
  "Sign-in works again with some identity providers (Okta, for one).",
  "The upgrade command takes --rollback to go back to the version you had before.",
  "Note: a self-hosted Executor behind a proxy no longer answers 502.",
  'The "Open in desktop" button opens the desktop app; it used to open the browser.',
  "Workspaces open faster - about twice as fast on large ones...",
  "Startup is 1.5 seconds faster on Windows 11.",
  "Is sign-in faster? Yes, by about half!",
  "Waehlen Sie Ihr Konto aus, und los geht's.",
  "2 settings moved to the account page: theme and language.",
  "A run of 6 digits, 123456, is fine.",
  "Executor starts faster. ".repeat(13).slice(0, 300),
  ...realisticNotes,
  ...hexWordNotes,
];

export const refusedNotes: ReadonlyArray<{
  readonly note: string;
  readonly reason: string;
  readonly message?: true;
}> = [
  { note: "\\@someone", reason: 'holds "\\", which a note may not' },
  { note: "gh-123 is fixed", reason: "joins letters to digits with a hyphen, as in GH-123" },
  { note: "HTTP://example.invalid", reason: 'holds "/", which a note may not' },
  { note: "UsefulSoftwareCo/executor#123", reason: 'holds "/", which a note may not' },
  { note: "@one@two", reason: 'holds "@", which a note may not' },
  { note: "#1#2", reason: 'holds "#", which a note may not' },
  { note: ":shipit:", reason: "does not start with a letter or a digit" },
  {
    note: "Ship it :shipit: now",
    reason: "has a colon followed by something other than a space",
  },
  {
    note: "See [the guide](https://evil.example/guide)",
    reason: 'holds "["',
    message: true,
  },
  {
    note: "Logo ![logo](https://evil.example/a.png)",
    reason: 'holds "["',
    message: true,
  },
  { note: "Look <img src=x onerror=alert(1)>", reason: 'holds "<"', message: true },
  { note: "Now **bold**", reason: 'holds "*", which a note may not' },
  { note: "Read https://evil.example/bare", reason: 'holds "/", which a note may not' },
  { note: "# Executor starts faster", reason: 'holds "#", which a note may not' },
  { note: "Keep @effect/tsgo pinned", reason: 'holds "@", which a note may not' },
  { note: "Fixes #2200", reason: 'holds "#", which a note may not' },
  { note: "Write to user@example.com", reason: 'holds "@", which a note may not' },
  { note: "Read example.com now", reason: "has a dot inside a word, as in a host name" },
  { note: "Visit www.example.com", reason: "has a dot inside a word, as in a host name" },
  {
    note: "Fixed in 1a2b3c4d",
    reason: "has a whole word of 7 or more hex characters or digits, as in a commit hash",
  },
  {
    note: "Fixed in deadbeef",
    reason: "has a whole word of 7 or more hex characters or digits, as in a commit hash",
  },
  {
    note: "Counted 1000000 runs",
    reason: "has a whole word of 7 or more hex characters or digits, as in a commit hash",
  },
  {
    note: `Counted ${"1".repeat(41)} runs`,
    reason: "has a whole word of 7 or more hex characters or digits, as in a commit hash",
  },
  {
    note: "Fixed in 0000000",
    reason: "has a whole word of 7 or more hex characters or digits, as in a commit hash",
  },
  {
    note: "Fixed in 0123456789abcdef0123456789abcdef01234567",
    reason: "has a whole word of 7 or more hex characters or digits, as in a commit hash",
  },
  ...[
    "The app no longer shows a defaced icon after an upgrade.",
    "Old banners no longer look effaced on high contrast screens.",
    "Requests that were acceded to now show as approved.",
  ].map((note) => ({
    note,
    reason: "has a whole word of 7 or more hex characters or digits, as in a commit hash",
  })),
  {
    note: "ABC-123 is fixed",
    reason: "joins letters to digits with a hyphen, as in GH-123",
  },
  { note: "GHSA-abcd-efgh-ijkl is fixed", reason: "names a security advisory" },
  { note: "- nested item", reason: "does not start with a letter or a digit" },
  { note: "1. numbered item", reason: "starts like a numbered list" },
  { note: "Run `executor upgrade`", reason: 'holds "`", which a note may not' },
  { note: "Smile :)", reason: "has a colon followed by something other than a space" },
  { note: "Q&amp;A", reason: 'holds "&", which a note may not' },
  { note: "snake_case names", reason: 'holds "_", which a note may not' },
  { note: "~~gone~~", reason: 'holds "~", which a note may not' },
  { note: "Q | A", reason: 'holds "|", which a note may not' },
  { note: "Pay $5 less", reason: 'holds "$"', message: true },
  { note: "🎉 Party", reason: "holds U+1F389, which a note may not" },
  { note: "Zero​width", reason: "holds U+200B, which a note may not" },
  { note: "Tab\there", reason: "holds U+0009, which a note may not" },
  { note: "Typographic “quotes”", reason: "holds U+201C, which a note may not" },
  { note: "It’s faster", reason: "holds U+2019, which a note may not" },
  { note: "Faster — much faster", reason: "holds U+2014, which a note may not" },
  { note: "Faster…", reason: "holds U+2026, which a note may not" },
  { note: "Café opens faster", reason: "holds U+0301, which a note may not" },
  { note: "A͏hidden mark", reason: "holds U+034F, which a note may not" },
  { note: "A️variation mark", reason: "holds U+FE0F, which a note may not" },
  { note: "Wählen Sie Ihr Konto", reason: "holds U+00E4, which a note may not" },
  { note: "设置页面打开更快", reason: "holds U+8BBE, which a note may not" },
  { note: "Copy the guide from executor-next", reason: "names a private repository" },
  {
    note: "Executor starts faster. ".repeat(13).slice(0, 301),
    reason: "is longer than 300 characters",
  },
];
