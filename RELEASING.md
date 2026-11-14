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
Nothing packages the collector yet; Motel is still the bundled collector.

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
on every push to `main` and on a schedule at minutes 8 and 38, and
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
  skipping it. An attempt that failed in its build or test jobs is dispatched
  again on the next tick. After two failures in a row, the next attempt waits
  six hours after the last one and for a new commit on `main`, or a day, so a
  broken `main` costs at most five publishing runs a day. An attempt that failed
  in its publish job has its failed jobs re-run once from its own artifacts;
  after that, inspect it as below. Each skipped retry leaves a warning on the
  Beta run, and the failed release runs stay red.
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
and dispatch the same workflow with **latest**. The version, tags, filenames
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
Public release notes come from the product README, not private PR titles or
GitHub's generated changelog.
