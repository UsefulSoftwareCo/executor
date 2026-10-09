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
It uses the 12-vCPU Mac runner to give emulation more capacity while preserving
the same startup and scenario deadlines; Apple Silicon uses the 6-vCPU runner.
The pinned Bun installer patch keeps its selected binary architecture under
Rosetta, matching the optional dependencies installed by the package manager.
Windows installers are currently unsigned.

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

Set the version to an unused `2.0.0-beta.N`, merge the reviewed release changes,
and dispatch **Executor releases** from `main` with channel **beta**.
The workflow refuses a channel that does not match the committed version.

1. Build and test every native runtime, desktop installer and Docker architecture.
2. Export the filtered source snapshot to the public repository's `v2-releases`
   branch. Create `executor@<version>` on that public commit, never a private SHA.
3. Publish native npm variants, then the launcher with exact optional aliases.
   Poll each public registry archive and compare its integrity before continuing.
4. Verify a clean `executor@<version>` installation from npm.
5. Upload installers, native packages, bundled Git source and SHA256SUMS.
6. Publish the tested Docker manifest as `:<version>` and `:beta`, then make the
   GitHub prerelease public with `latest=false`.
7. Point the desktop `beta` update channel at the public release assets.

The npm `latest` tag, Docker `latest`, and Executor 1 desktop updater stay
unchanged. A draft public release blocks accidental repeat publication of the
same version. After a partial failure, re-run the failed publish job. It resumes
only its own draft, whose target is this source's unchanged public snapshot, and
skips npm versions whose registry integrity matches the local archive. Any other
existing release or npm version stops publication for inspection. Never
republish an accepted immutable npm version merely because its registry entry is
still propagating.

The homepage resolves desktop downloads in the browser from GitHub's public
release list, choosing the newest published release with this major version's
tag prefix. A merged version bump keeps linking to the previous release until
this one is public; without JavaScript, or when the lookup fails, the buttons
open the releases page. Verify the public npm install, GitHub assets, Docker
manifest and rendered site.
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
Public release notes come from the product README, not private PR titles or
GitHub's generated changelog.
