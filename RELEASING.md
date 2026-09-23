# Releasing Executor

`apps/cli/package.json` owns the product version. `scripts/releases/config.ts`
derives the npm channel, native targets, Docker tags, desktop identity and exact
public download URLs. Build scripts and the website consume that configuration.
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
Windows installers are currently unsigned. Automatic desktop updates remain
unconfigured; use the manual installer to update Executor 2.

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

The npm `latest` tag, Docker `latest`, and Executor 1 desktop updater stay
unchanged. A draft public release blocks accidental repeat publication of the
same version. After a partial failure, inspect registry availability and the
existing draft before recovery. Never republish an accepted immutable npm
version merely because its registry entry is still propagating.

Merge site install-link changes only after the referenced public assets exist.
Verify the public npm install, GitHub assets, Docker manifest and rendered site.
A successful upload alone does not establish public availability.

## Stable cutover

Get explicit approval for the v2 stable release. Change the version to `2.0.0`
and dispatch the same workflow with **latest**. The version, tags, filenames
and links change together. The fixed desktop identity `com.usefulsoftware.executor.v2`,
product name **Executor 2**, profile **Executor v2**, and CLI data directory
`~/.executor/v2/cli` remain unchanged. This does not enable an updater feed.

Changesets still orchestrates separately published workspace packages. The
product archive includes private workspace packages and uses the CLI manifest
as its single release version; the removed v1 release script is not a second
publishing route.

## Release infrastructure

`apps/hosted/cloud/alchemy.releases.ts` owns the seven required secrets in the existing `release`
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
The public release token needs Contents write on `UsefulSoftwareCo/executor`.
The release stack requires `NPM_TOKEN`, `PUBLIC_RELEASE_TOKEN`,
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
