# Releasing Executor

`apps/cli/package.json` owns the product version. `scripts/releases/config.ts`
derives the npm channel, native targets, Docker tags, desktop identity and
installer names. Build scripts and the website consume that configuration.
Source workspaces remain private; only staged runtime packages are published.

## Build and verify

Use the pinned Node and Bun versions in `.github/actions/setup/action.yml`.

```sh
bun run release:cli
bun run release:wrapper
bun run release:desktop
```

Outside CI, `release:cli` first removes the workspace's `.local/releases` builds for the same
platform at other versions (`scripts/releases/prune-builds.ts`), keeping any that a running
process has open. `release:cli` and `release:desktop` do not start below the free-space floor
described in `e2e/README.md` (`EXECUTOR_DISK_FLOOR_GB`, 20 GB by default).

These commands never publish. macOS public installers require
`bun run release:desktop --notarize`, with the five `EXECUTOR_MAC_*` credentials
from the Agents vault. The signing helper owns a temporary keychain and an
in-memory notary key file and removes them after the build.

The **Executor releases** workflow (`release-artifacts.yml`) defaults to
**build**. It reads the committed version, builds all five native platforms,
tests installed CLI archives and desktop restart behavior, checks OS credential
setup and key-loss refusal, and runs the native Docker scenarios on amd64 and
arm64. It also produces the checksum-pinned Git companion source archive.
Every job runs on Blacksmith. macOS builds use Apple Silicon runners; the Intel
job uses x64 Node and Bun under Rosetta and tests the x64 runtime and desktop.
Both macOS targets run on the 6-vCPU Mac runner (`scripts/releases/config.ts`).
The pinned Bun installer patch keeps its selected binary architecture under
Rosetta, matching the optional dependencies installed by the package manager.
Windows installers are currently unsigned.

Each run also builds the Rust telemetry collector (`packages/telemetry/collector`) once per
target in its `collector (<target>)` job, on that target's `local` runner. Every job that packages
the CLI runtime (`local`, `checks`, `cli` and the `recovery` parts) starts with the run, waits for
its own target's collector job at "Wait for the telemetry collector"
(`scripts/releases/collector-job.ts`), and downloads that one build as the `collector-<target>`
artifact, so the archives the `archives` job compares hold the same bytes. A collector job that
fails or is cancelled stops its target's packaging jobs at once, and `releases` names it. Runs
that publish build the collector without restoring from the cache, because an entry in main's
cache scope is not proof of what built it; the cache rules judge restores by workflow file, so the
paced check and `build` runs build it too (`.github/actions/collector`). A narrowed build runs a
collector job only for the targets its packaging jobs run on, and none when it runs only the image.
Every packaging job packages the collector it fetched, executable before anything is signed, and
builds the viewer the CLI and desktop serve from it; the image builds its own collector in its
Dockerfile's `collector` stage.

A Bun runtime release built from a pull request's branch, as one that changes the
lockdown patch needs, is the one main's publishing runs use from then on. If that
branch's `scripts/releases/bun-runtime/` changed after the build and before merge,
delete the release before merging so main builds it again; see
[the release scripts](scripts/releases/README.md).

## Desktop update channels

Executor 2 desktop installs update from their own channel feed. The channel is
fixed at build time from the version: `2.0.0-beta.N` builds follow `beta` and
stable builds follow `latest`. There is no in-app channel switch. Install a stable
build to leave beta.

Executor 1 reads GitHub's release list in the same public repository, so v2
never uses the GitHub provider or electron-updater's default `latest*.yml`
names. `scripts/releases/config.ts` defines a generic feed in the published
prerelease `executor-v2-desktop-updates`:

| Platform    | Beta file                          | Stable file                          |
| ----------- | ---------------------------------- | ------------------------------------ |
| macOS       | `executor-v2-beta-mac.yml`         | `executor-v2-latest-mac.yml`         |
| Windows     | `executor-v2-beta.yml`             | `executor-v2-latest.yml`             |
| Linux x64   | `executor-v2-beta-linux.yml`       | `executor-v2-latest-linux.yml`       |
| Linux arm64 | `executor-v2-beta-linux-arm64.yml` | `executor-v2-latest-linux-arm64.yml` |

Each file lists absolute URLs to the versioned release assets and their
blockmaps. The feed release never becomes GitHub's latest release, so v1 installs
never see it. Its first publication creates it on the release's public commit.

The desktop build writes `app-update.yml` for Windows, Linux and signed macOS
builds. Unsigned macOS review builds have no feed because Squirrel.Mac only
installs signed updates. Linux checks only inside the AppImage; `.deb` installs
update from the download page.

Publishing updates the channel last, after the versioned release is public.
`scripts/releases/desktop-feed.ts` checks every platform's metadata against the
installer bytes, merges the macOS arm64 and x64 entries, and writes the files.
A stable release writes `latest` and moves `beta` forward unless `beta` already
holds a newer version. Rerunning the upload replaces the same files. To roll a
channel back, publish a newer fixed version; installs never downgrade.

The app checks 15 seconds after launch and every four hours, downloads quietly,
then offers **Restart** or **Later** once per version. **Updates → Check for
updates…** checks at once and offers a version declined earlier. The backend
stops before installation. Updates never install on quit.

## The apps framework release

New apps pin the `apps` version in `packages/apps/package.json`, so every host
must ship a version that npm holds with exactly the content this checkout
builds. Every change to the framework, including the workspace libraries
bundled into it, bumps that version in its PR (and the host protocol when the
host boundary changes). Merging allocates the numbers and the deploy from
`main` publishes them. Never publish `apps` from a branch or by hand; see
[publishing apps](notes/apps-publishing.md).

`scripts/releases/apps-published.ts` runs after `bun run apps:build`. It packs
the staged package and compares every file with the published archive of the
same version:

- The deploy workflow's `apps` job runs it with `--publish` in the `release`
  environment before the production deploy job. An unpublished version is
  published with `--tag beta`; a published one is only compared.
- Publishing runs of **Executor releases** run it without a flag, so the
  version must already be on npm unchanged.
- Pull request checks run it with `--allow-unpublished`: an unpublished bump
  only warns, while a published version with different content fails.

Pull requests also run `scripts/releases/apps-bumped.ts`, which builds the base
commit's package and fails when the staged package changed but the version did
not.

## Publish beta

The **Beta** workflow (`.github/workflows/beta.yml`) publishes betas. It checks
on every push to `main`, when CI passes on a push to `main`, and on a schedule
at minutes 8 and 38, and
`scripts/releases/beta-due.ts` decides from npm, the release runs and main's
history. Before deciding, each tick runs `scripts/releases/lock-repair.sh`, which
pushes `Refresh bun.lock [skip ci]` when main's bun.lock is not what
`bun install` writes and the only difference is workspace packages' own versions.
Any other difference is only reported: a warning in the run summary and one open
issue labelled `lock-repair-refused` (`scripts/releases/lock-repair-issue.sh`),
which a later tick closes when it finds the lock fresh. The repair never holds a
beta. That commit follows the merge that left the lock stale, so it
never makes a beta due by itself, and its `[skip ci]` starts no Executor releases
run. A push and a scheduled tick decide alike:

- While any build or publication of **Executor releases** is queued or running,
  it waits. A check, which publishes nothing, does not hold it.
- It starts no beta and no further attempt while the release matrix on `main` is
  red. The matrix runs are the checks, the **Executor releases** runs that the
  **Release check** workflow starts with a repository dispatch after main
  changed what a release lane builds or runs, paced to one build every two
  hours, and the runs titled `(build)`, dispatched from `main` by hand. Checks
  list apart from builds and publications, so they never crowd the publishing
  attempts out of what the decision reads. The newest finished one must have
  passed its `releases` job. A run that tested nothing is skipped: a cancelled
  one, and a check whose `pace` job did not pass or whose matrix did not run. A push that changed
  nothing a release lane reads starts no check, so it neither holds a beta nor
  lets one through. A failed run holds every beta, with a warning, until a later
  run passes. To clear a hold once the cause is fixed, merge the fix, or run
  `gh workflow run release-artifacts.yml --ref main -f channel=build`. A run still
  pacing or building holds nothing, since the publishing run tests every platform
  on the commit it publishes and publishes only when all pass.
- **Release check** also starts the installed CLI suite on Windows, a narrowed
  build (`jobs=cli`, `targets=win32-x64`, about USD 1.40 and 13 minutes), on a
  decision of its own (`e2e/release-check.ts`, `windows`): it compares main with
  the last commit a Windows check tested, or will, never with the Linux check's, so
  a commit the Linux check already covers still gets its Windows run. It starts at
  most once every four hours; a decision inside that wait skips it and keeps the
  comparison where it was, so the first push or hourly backstop after the four
  hours starts it for every commit since. A decision that fails starts it. It runs
  from the `ci/windows-check` branch, which the step sets to main's commit, so it
  never shares a concurrency group with a publication from `main`, and Beta
  neither waits for it nor counts it. A red one shows a Windows-only failure hours
  before a publishing run would; the red-main issue reports it.
- A build run can be narrowed, to prove one job on one platform without paying
  for the whole matrix (a full build costs about USD 7; the installed CLI suite
  on Windows alone about USD 1.40):
  `gh workflow run release-artifacts.yml --ref <branch> -f channel=build -f targets=win32-x64 -f jobs=cli`.
  `targets` takes `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` and
  `win32-x64`; `jobs` takes `local`, `checks`, `cli`, `recovery` and `docker`;
  both are comma-separated, and empty means all. Its `releases` job requires only
  what it ran, and `archives` checks the parts it ran but skips the comparison of
  tested and published archives, which needs every packaging job. It is titled
  `(build, <jobs> on <targets>)`, so Beta and the red-matrix issue, which read a
  `(build)` run as the whole matrix, never count it; wait for it with that title
  (`ci-wait --workflow "Executor releases (build, cli on win32-x64)" --dispatched`).
  Checks, publications and notarizing builds always run everything, and refuse
  to be narrowed.
- When npm lists the committed version, main has commits after that version's
  `Release 2.0.0-beta.N` commit, and npm published it at least six hours ago,
  it commits `Release 2.0.0-beta.N+1` to `main` and dispatches **Executor
  releases** with channel **beta**.
- When npm lacks the committed version, it publishes it again instead of
  skipping it. At most five publishing attempts a day fail: once five failed in
  the last 24 hours, counting each re-run of a run as an attempt of its own, no
  tick starts or re-runs another, a manual dispatch of Beta
  included, until enough of them are a day old that fewer than five remain
  (dispatch **Executor releases** with
  channel **beta** by hand to publish sooner, after inspecting them). It finds
  them by when they ran: the release runs of the last month (GitHub re-runs a
  run only within 30 days), and the earlier attempts of those re-run in the last
  day, stopping once five are known. When ten requests cannot tell, the tick
  holds. Within that
  bound, an attempt that failed before publishing is dispatched again on the next
  tick. After two failures in a row, the next attempt waits six hours after the
  last one and for a new commit on `main`, or a day, unless CI has passed on a
  `main` commit after the last attempt's: a failure that a merge fixed is retried
  as soon as `main` is green again. Beta also ticks when CI finishes green on a
  push to `main`, so that retry starts within minutes.
- An attempt that failed in a step that publishes anything is never retried that
  way: it has its failed jobs re-run once from its own artifacts (bar the kind
  below); after that, inspect it as below. It is judged by the step, not the job's name: every step
  of `release-artifacts.yml` and `bun-runtime.yml` declares in its `env` whether
  it publishes, `PUBLISHES: "yes"` (every step of the `publish` job, the docker
  job's architecture push, the dispatch of Deploy and the Bun runtime's release)
  or `PUBLISHES: "no"`, and `e2e/tests/beta-due.spec.ts` fails a step that
  declares neither, so give every new step one. A run's job is found by the job id
  at the start of its name, which GitHub cuts short for a long matrix job; a job or
  step that cannot be found counts as publishing
  (`scripts/releases/publishing-steps.ts`). Each skipped retry leaves a warning
  on the Beta run, and the failed release runs stay red.
- One kind of publish failure is held for inspection instead of re-run, because
  its re-run cannot publish `main`'s version. All of these must show: the run is
  on its first attempt and failed; its `publish` job failed at "Export source
  and create or resume the public draft release", every earlier step of that
  job succeeded and every later one was skipped (bar the report, `Post` and
  runner steps); no other step that publishes failed; and npm listed the
  version that the run's commit records in `apps/cli/package.json` before the
  run was created. Evidence it cannot read leaves the ordinary decision in
  place: when the run's `apps/cli/package.json` cannot be read (within 30
  seconds) or npm lists no time for the version it records, Beta re-runs the
  run as above, and so it does when it cannot work out the hold's age for the
  `held` output. A failed read of the run's jobs still fails the tick, as it
  always has. The hold is the one Beta uses for any publish
  failure to inspect: nothing is dispatched or re-run, the day's count is
  unchanged, and the warning names the run, its commit and the version it
  built. Beta does not recover from this by itself. Inspect the run; if it is a
  dispatch that started on the commit before a version bump, check that npm
  lacks `main`'s version and no release run is active, then dispatch
  **Executor releases** from `main` with channel **beta** by hand. The step can
  also fail for a transient reason (the app token, the export, the release
  lookup) on a run whose source matches the release it resumes; that run is
  held too, and once the cause is fixed, re-run its failed publish job when the
  partial-failure checks below allow it ("After a partial failure" in this
  section).

  Why: on 2026-11-26 Beta pushed `Release 2.0.0-beta.80` (`1e846c84a9`) and
  dispatched with `--ref main` about 20 ms later (its log). The run it started,
  45761840264, was created on `47f49bf240`, the commit before the bump, which
  records beta.79, and failed at that step because beta.79 was already public
  (the run record). That GitHub resolved `main` before it saw the push is
  inferred from those times. Before this check Beta would have re-run 45761840264,
  which records beta.79 and so would have failed at that step again, and held
  only on the second failure. The race itself is not fixed: such a run still
  builds the old version for about 17 minutes and costs one of the day's five.
  Three fixes were tried and set aside. Passing the pushed commit to **Executor
  releases** and refusing a run on any other commit changes both workflows, is
  skipped wherever an older revision of either sends or receives the dispatch,
  and can only cancel a run after it exists. Dropping release runs that built
  another version from Beta's history let Beta dispatch through holds it keeps
  today, such as a publish failure whose commit cannot be read. Passing over
  only a run of the shape above and deciding on the runs before it let Beta
  dispatch or re-run another run on evidence that cannot show that is safe: the
  passed-over run may have been resumable, a recovery run may lie beyond the 30
  runs Beta reads, and the run exposed may be for a version the channel has
  moved past. A fix has to make the release run build the exact commit Beta
  pushed.

- Only publishing runs count as attempts. A dispatch with channel **build**
  does not publish, so it neither adds to a failure streak nor counts as a
  success, though it still makes the tick wait while it runs.
- When the last publishing run for the committed version (its commit contains
  the `Release` commit) succeeded but npm still lacks the version, every tick
  fails red instead of dispatching again: another run would succeed the same
  way without publishing. Inspect that run's publish job and the registry, fix
  the cause, then dispatch **Executor releases** with channel **beta** by hand.

GitHub delivers this repository's schedules hours late and drops the ticks in
between: in the 30 days to 2026-11-11 a `*/5` cron ran about five times a day and
an hourly one about four and a half. So merges drive publishing, and the schedule
is a backstop. Without merges, a beta that waits out the six hours, or a retry
after a failed attempt, waits for the next merge or the next scheduled run, which
has come up to 11 hours apart.

Ticks never overlap. While one runs, one more waits; a newer tick replaces the
waiting one, and it reads main afresh, so a burst of merges costs a few runs. When
a merge lands between a tick's checkout and its bump push, the push is refused;
the tick pushes nothing and passes with a notice, because that merge started a
tick of its own, which decides again. A refusal while main has not moved fails
the tick.

Dispatching **Beta** by hand publishes new commits at once, skipping the six
hours and the retry back-off. A merge that lands while a manual dispatch
waits behind a running tick replaces it; dispatch it again. The bump commit is pushed over SSH with the
deploy key in the `beta` environment's `BETA_PUSH_KEY` secret, the one actor
the `main` ruleset lets push without a pull request (see
[CI configuration](notes/ci.md)). Its message ends in `[skip ci]`, so it starts
no CI, Deploy, public export, Cloud tests or Beta run; the next merge carries it.

To publish a beta by hand instead, set the version to an unused
`2.0.0-beta.N`, merge the reviewed release changes, and dispatch **Executor
releases** from `main` with channel **beta**. The workflow refuses a channel
that does not match the committed version.

1. Build and test every native runtime, desktop installer and Docker architecture.
2. Export the filtered source snapshot to the public repository's `v2-releases`
   branch. Create `executor@<version>` on that public commit, never a private SHA.
3. Upload installers, native archives, the npm launcher, bundled Git source and
   SHA256SUMS to the draft.
4. Publish the tested Docker manifest as `:<version>` and `:beta`, then make the
   GitHub prerelease public with `latest=false`.
5. Publish the npm launcher, which downloads the native archives from that public
   release. It records each archive's SHA-256; publication checks them against
   the build and the release's SHA256SUMS, then polls the registry archive and
   compares its integrity.
6. Verify a clean `executor@<version>` installation from npm, including its first
   download.
7. Point the Homebrew formula and the desktop `beta` update channel at the public
   release assets.

The npm `latest` tag, Docker `latest`, and Executor 1 desktop updater stay
unchanged. A draft public release blocks accidental repeat publication of the
same version. After a partial failure, re-run the failed publish job. It resumes
only its own release, whose target is this source's unchanged public snapshot:
a draft gets its assets again, and a release already public keeps them, which
npm publication then checks. It skips an npm launcher whose registry integrity
matches the local archive. Any other
existing release or npm version stops publication for inspection. Never
republish an accepted immutable npm version merely because its registry entry is
still propagating.

No publish step moves a channel backwards. The job's first step after setup
reads every channel (npm's tag, the image's channel tag, the published formula,
the desktop feed) and refuses a release older than any of them, and each step
that moves a channel checks its own again just before it moves it
(`scripts/releases/channel-guard.ts`). After a failure the job summary says what
the release made public and what it did not, read from the public surfaces, and
whether re-running the failed jobs would finish it
(`scripts/releases/publication-report.ts`).

A re-run uses the workflow file of the run's own commit, so runs started before
those checks were added carry none. Never re-run the publish job of an older
release once a newer one exists: beta.51's run (43640118286) and beta.52's,
re-run after a newer beta, would point the image's `beta` tag back at it.

The homepage resolves desktop downloads in the browser from GitHub's public
release list, choosing the newest published release with this major version's
tag prefix. A merged version bump keeps linking to the previous release until
this one is public; without JavaScript, or when the lookup fails, the buttons
open the releases page. The documentation's install commands name the newest
release npm's dist-tags list, read when the site builds (`scripts/releases/published.ts`),
so they too keep the previous version until publication moves the tag and the
next deploy from `main` rebuilds the site. Verify the public npm install, GitHub
assets, Docker manifest and rendered site.
A successful upload alone does not establish public availability.

## Stable cutover

Get explicit approval for the v2 stable release. Change the version to `2.0.0`
and dispatch the same workflow with **latest**. npm already serves `executor@2.0.0`:
it was published on 2026-03-16 from a stale historical tag and is deprecated.
npm never accepts a version twice, so a release numbered `2.0.0` cannot be
published, and the publish job's preflight refuses it before anything moves. The
first stable release needs a number above the betas that npm does not hold; the
choice is the owner's. The version, tags, filenames
and links change together. The fixed desktop identity `com.usefulsoftware.executor.v2`,
product name **Executor 2**, profile **Executor v2**, and CLI data directory
`~/.executor/v2/cli` remain unchanged. Stable publication writes the desktop
`latest` channel and moves beta installs forward. Marking v2 as GitHub's latest
release also changes what Executor 1's updater reads; decide v1's path before cutover.

Changesets still orchestrates separately published workspace packages. The
product archive includes private workspace packages and uses the CLI manifest
as its single release version; the removed v1 release script is not a second
publishing route.

## Release infrastructure

`apps/hosted/cloud/alchemy.releases.ts` owns the eight required secrets in the existing `release`
environment. It is separate from the unapplied broad CI stack, so
applying releases does not change production credentials, repository policy or
Cloudflare deployment tokens. Missing credentials fail the apply.

From the cloud package, use `alchemy deploy alchemy.releases.ts --stage ci
--dry-run --no-input` to review, then `--no-input --yes` to apply. Resolve an
ignored Agents reference file through `agent-vault run --env-file`.

The environment is created once by a repository administrator with a bare
`PUT /repos/UsefulSoftwareCo/executor-next/environments/release`. It already exists.
Secret providers require it to exist and never change its protection rules.
The IaC token needs Environments read/write and Metadata read on
`UsefulSoftwareCo/executor-next`. GitHub cannot restrict it to one environment.
Public releases use a GitHub App installed on `UsefulSoftwareCo/executor` with
Contents read/write. Its installation tokens have their own rate limit, so a
release cannot fail because a person's token is busy elsewhere.
The release stack requires `NPM_TOKEN`, `PUBLIC_RELEASE_APP_CLIENT_ID`,
`PUBLIC_RELEASE_APP_PRIVATE_KEY`,
`EXECUTOR_MAC_SIGNING_KEY`, `EXECUTOR_MAC_SIGNING_CERTIFICATE`,
`EXECUTOR_MAC_NOTARY_KEY`, `EXECUTOR_MAC_NOTARY_KEY_ID`, and
`EXECUTOR_MAC_NOTARY_ISSUER`, plus GitHub and Cloudflare state credentials.

## Public source

Normal main pushes continue exporting to public `v2` through
`scripts/export-public.sh`. Release snapshots use `v2-releases` so a release
cannot race or replace a newer main export. Both use
`scripts/export-public.exclude`; private history and internal notes stay private.
A main export also merges the public pull requests that main ports, named by
`Public-PR` lines in its commit messages; a release export merges none, because
no pull request targets `v2-releases`.

## Release notes

Each public release's notes list what changed since the release before it, then
the install instructions at the top of
[the release scripts' README](scripts/releases/README.md). The metadata job of a
publishing run writes them with `scripts/releases/release-notes.ts`, before any
build, and the publish job creates the release with them. They are not GitHub's
generated changelog, which would list private pull requests and their titles.

The notes list only changes whose squashed commit on main has a line
`Release-note: <text>`, and that text is all they say about the change. Pull
request titles stay private: the notes never print one, nor does any warning
the script writes. `Release-note: none` is the same as no line.

A line counts only when `Release-note:` starts a line of the message's body:
not indented, not quoted with `>` (as a revert may quote the message it
reverts) and not inline. A commit message that holds `<`, `[`, `$`, ` ``` ` or
`~~~` anywhere, title included, has no notes at all, because HTML, a link
definition, math or a code fence can hide a line from whoever reads the message
rendered; the job log warns with the commit and the character. The one
exception is a line that is a co-author trailer and nothing else, anywhere in
the message, since a squash joins its commits' messages and a port's own
trailers sit in the middle: `Co-authored-by: <name> <address>` (the key in any
case), then only spaces, where the name holds no `<`, `>`, `[`, `]`, `$`,
backtick or control character but may end `[bot]`, and the address, the line's
only `<...>`, is `<local@host>` with a local part of letters, digits and
`._+-` (a bot's ending `[bot]`) and a host of letters, digits, dots and hyphens.
Any other `<` or `[`, even on a line that only starts like a trailer, still
drops the notes. So write an
example note in words, not in a code block or comment. Any other line that
holds `Release-note:` is not counted, and the job log warns with its commit and
line number. When a change has several lines that count, each is listed, once,
in the order written; `none` among them is skipped. A line cannot be withdrawn
by a later one, so reword or drop the commit before merging instead.

A note may start with the kind of change it is: `Feature: `, `Improvement: `
or `Fix: ` (the word in any case, then a colon and exactly one space, not a
tab or two spaces, which leave the note refused), as in
`Release-note: Improvement: Search answers faster.` The kind is not part of the
note: it is cut off first, and the rules below apply to the text after it,
which must itself start with a letter or a digit and is counted against the
300 characters without the kind. It is never published, in the release, the
desktop feed, Cloud's notes or anywhere else. A note without one is a fix. A
kind with no note after it, or with `none`, is refused. Cloud's What's new
leads with the newest feature or improvement of its notes, never a fix; with
neither it shows a plain line, and its panel lists every note, fixes included,
in order. So write `Feature: ` for something new and `Improvement: ` for
something that already worked and now works better, and `Fix: ` or nothing
for something that was broken. Mark a note for what it is, and never reword a
fix to sound like a feature. `--check` prints the kind it counted for each
line. `scripts/releases/note-kinds.ts` gives one note merged before kinds
could be written its kind by hand, since a commit message on main cannot change;
it is a stopgap, so never add to it, and delete it once that commit leaves
Cloud's 30 days (the file says when).

`scripts/releases/cloud-lead.ts` can pin the note What's new leads with, by the
hash `--check` prints, whatever its kind and however many newer notes there are;
the pinned note stays in the panel, in its dated place, while it is pinned. When
the pinned note is not among Cloud's notes of the last 30 days, the lead falls
back to the rule above, and `--check` and the deploy warn. Delete the pin's line
to remove it.

A note is published only when it is plain prose, and then exactly as written.
It may hold only ASCII letters, digits, spaces and these punctuation marks:
`.` `,` `;` `:` `!` `?` `'` `"` `(` `)` `-`. It must also:

- start with a letter or a digit, and not like a numbered list (`1.`, `1)`);
- have a colon only before a space or at its end, so no `:emoji:` or `scheme:`;
- have a dot only at the end of a sentence or between digits (`1.5`), never
  inside a word as in a host name (`example.com`, `www.x`);
- join no letters to digits with a hyphen (`GH-123`, `ABC-123`);
- hold no whole word of 7 or more hex characters or digits, which GitHub links
  when it names a commit (so `deadbeef`, `defaced` and `1234567` are refused,
  and a number is written `1,000,000`); a word that only holds such a run, such
  as `feedback`, is fine, because GitHub links a commit only as a whole word;
- name no `GHSA-` advisory and no private repository;
- be at most 300 characters.

So a note holds no `@`, `#`, `/`, `<`, `>`, `[`, `]`, `&`, `*`, `_`, `~`, `|`,
backslash, backtick, typographic quote or dash, accented or non-Latin letter,
emoji or invisible character: no mention, issue or pull request reference,
`owner/repo`, URL, email address, code, HTML or Markdown. Write a command or a
name in words. Any other note is left out whole, never rewritten or cut, and
the job log warns with its commit, its line number and the first rule it
breaks. All listed lines together hold at most 10,000 characters: once a
change's lines would pass that, it and every later change are left out and
counted, with a warning. Neither stops the release, because a commit message on
main cannot be changed.

`e2e/tests/release-notes-render.spec.ts` (CI's tooling-release job, with the job's
token) sends a corpus of accepted notes, as the script writes them, to GitHub's
Markdown API and checks that each comes back as its text alone, inside nothing
but the notes' headings, list and paragraph. It also renders the refused corpus
and checks that the forms review found active still render as links, mentions,
an emoji image or markup. The corpora are in `e2e/release-notes-repositories.ts`.

A note is shown to every product its change reaches: Cloud when it changed a
file a Cloud deploy reads that is not only another product's, and the CLI and
desktop app or the self-host image when it changed a package that one is built
from, other than its scripts, tests, fixtures and Markdown. When the users of a
product it reaches would not notice the change, or users of one it does not
reach would, add an entry to `scripts/releases/note-audiences.ts` in the same
pull request: the note's hash and the products it is for. `--check`, which
`bun run pr:check` runs, prints each note's audience, why, its hash and how to
change it.

A release lists a line under All installs, CLI and desktop, or Self-host by that
audience. A line on a change to nothing a release ships, such as Cloud-only
code, CI or tooling, that no entry names is not listed, and the job log warns
with the commit. A port of a public pull request with a line is listed whatever
it changed, unless an entry names an audience without the CLI and desktop app or
the self-host image, and it links it and thanks its contributors by GitHub
handle. That credit is the one place the notes hold a link and a mention, and it
is safe because it is built only from a `Public-PR:` line that names
`UsefulSoftwareCo/executor#<number>` exactly and from handles in
`users.noreply.github.com` co-author addresses that match GitHub's handle rule,
never from free text, so it can only point at a public pull request and the
people who wrote it. Anything else gets no credit and a warning in the job log,
and the note is listed as if the change were no port. A revert and the change it
reverts cancel when both are in the release, newest first, so a reverted revert
cancels nothing and the change it restored is listed. Every change not listed is
counted in one line. A release with no line at all says "No release notes were
written for this release." and still publishes. The notes link nothing else: no
compare view, commit or private pull request.

Warnings go to the publishing run's job log and its annotations in this
private repository, and name commits only, never a title or a note's text. The
notes themselves reach the public repository only as the release's body: the
`release-notes` artifact is downloaded outside `.local/publish`, so it is never
uploaded as a release asset.

Write the line for a change a user of Cloud, the CLI, the desktop app or the
self-host image would notice: one plain sentence saying what changed for them,
in the words above. Name no customer, organization or reporter, use no internal
names, and say nothing about a security problem not yet fixed and disclosed. Put
it in the body of a commit message on the pull request's branch, not only in the
pull request's description: this repository squashes with the commits' messages
as the body (`squash_merge_commit_message: COMMIT_MESSAGES`), so the description
never reaches main.

To see a release's notes without publishing, run
`node scripts/releases/release-notes.ts --version <version> --to <its Release commit>`
from a checkout of main.
