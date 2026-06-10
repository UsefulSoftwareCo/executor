# Releasing

This repo uses Changesets for version orchestration and three publish paths:
the CLI (`executor` npm package plus its platform packages), the
`@executor-js/*` library packages (`core`, `sdk`, and the public plugins), and
the self-host Docker image.

## Normal release flow

1. Add a changeset in the PR that should ship:
   - `bun run changeset`
2. Merge that PR to `main`.
3. `.github/workflows/release.yml` opens or updates a `Version Packages` PR.
4. Merge the `Version Packages` PR.
5. The release workflow then does two things in parallel:
   - Publishes every `@executor-js/*` library package whose current version
     is not already on npm, via `bun run release:publish:packages`
     (see `scripts/publish-packages.ts`).
   - If `apps/cli/package.json` bumped, tags the commit and dispatches
     `.github/workflows/publish-executor-package.yml`, which:
     - runs `bun run release:check`
     - performs a full dry-run release build before publish
     - publishes the CLI npm package under the correct dist-tag
     - creates or updates the GitHub release with build artifacts
     - dispatches `.github/workflows/publish-desktop.yml`
     - dispatches `.github/workflows/publish-selfhost-docker.yml`
6. The self-host Docker workflow publishes `ghcr.io/rhyssullivan/executor-selfhost`
   for `linux/amd64` and `linux/arm64`:
   - stable releases get `vX.Y.Z`, `X.Y.Z`, and `latest`
   - prereleases get `vX.Y.Z-...`, `X.Y.Z-...`, and `beta`

## Beta releases

Enter prerelease mode before starting a beta train:

- `bun run release:beta:start`

That commits `.changeset/pre.json` into the repo and causes future release PRs to produce versions like `1.5.0-beta.0`, `1.5.0-beta.1`, and so on.

When the beta train is done:

- `bun run release:beta:stop`

Stable versions publish to npm under `latest`.
Beta versions publish to npm under `beta`.

## Local dry run

To build the full CLI release payload without publishing to npm or GitHub:

- `bun run release:publish:dry-run`

That produces:

- platform archives in `apps/cli/dist`
- the packed wrapper tarball in `apps/cli/dist/release`

To pack the `@executor-js/*` library packages without publishing:

- `bun run release:publish:packages:dry-run`

To validate the self-host Dockerfile locally without publishing:

- `docker build -f apps/host-selfhost/Dockerfile -t executor-selfhost:local .`

## Release notes

Release notes follow the standard Changesets flow: **the changeset body
IS the changelog entry.** Write the user-facing summary in the
`.changeset/*.md` you add with your PR; `changeset version` compiles
every changeset into the bumped packages' `CHANGELOG.md` files (via
`@changesets/changelog-github`, which links the PR and credits the
author), and `apps/cli/src/release.ts` uses the released version's
section of `apps/cli/CHANGELOG.md` as the GitHub Release body. If the
section is missing it falls back to `gh release create
--generate-notes`.

There is no separate release-notes file to remember to update — if your
change deserves a mention, its changeset body is the mention.

### Authoring rules

Write changeset bodies for users, not for the diff:

- Lead with the user-visible behavior, not the implementation.
- A typical fix is one sentence. A feature can be a short paragraph.
- For a large release, a changeset body can be a full markdown section
  (bold sub-headings + bullets). Avoid `#`/`##` headings inside bodies —
  they end up nested inside a changelog list item.
- For breaking changes, include the before/after surface in the body.

Contributor attribution is automatic: `@changesets/changelog-github`
prefixes each entry with the PR link and the author's handle.

## Notes

- Changesets owns the published CLI version via `apps/cli/package.json`.
- Only the Version Packages PR should change `apps/cli/package.json`; the rest of the workspace is not version-synced for release PRs.
- Per-package `CHANGELOG.md` files are seeded for every workspace package
  (`bun run lint:changelog-stubs --fix`). `changeset version` inserts
  generated sections after the H1, and the `changesets/action@v1` GitHub
  Action reads each bumped package's `CHANGELOG.md` to build the Version
  Packages PR description (it crashes with `ENOENT` if any are missing).
- `@changesets/changelog-github` needs a `GITHUB_TOKEN` when running
  `changeset version` (it resolves PR numbers and authors). CI provides
  one; locally use `GITHUB_TOKEN=$(gh auth token) bun run changeset:version`.
- The publish workflow supports either npm trusted publishing or an `NPM_TOKEN` secret.
- Re-running the publish workflow for the same tag is safe for packages that are already on npm; existing versions are skipped.
