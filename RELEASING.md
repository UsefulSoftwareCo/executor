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

User-facing release notes live at `apps/cli/release-notes/next.md` —
one rolling file. **This is the single source of truth users see.** Edit
it whenever you ship a user-visible change.

`apps/cli/src/release.ts` reads `next.md` and uses its contents as the
GitHub Release body. If the file is missing or empty it falls back to
`gh release create --generate-notes` (auto-generated from PR titles).

There's no per-version archive in the repo — historical release bodies
live on GitHub Releases (durable, indexed, linkable). When you start a
new release cycle, replace the existing `next.md` content with your new
entries; the previous cycle's content is already preserved on the
matching `vX.Y.Z` release page.

### Authoring rules

Use this section structure (mirrors what's already in `next.md`):

```markdown
## Highlights

### <user-facing story>

bullets of concrete user value

## Fixes

## Breaking changes

### <specific surface>

before / after code blocks for migrations
```

Lead with **user-visible stories**, not commit subjects. Group related
commits into one story. Keep bullets single-line so diffs and dedupe
tooling stay simple.

### Attribution

For external contributors, end the bullet with `Thanks @<user>` and the
PR ref:

```markdown
- OAuth2 client-credentials flow end-to-end. Thanks @octocat (#456)
```

Don't `Thanks` maintainers, bots, or the repo owner. The lint script
(`bun run lint:release-notes`) rejects `Thanks @claude`,
`Thanks @rhyssullivan`, `Thanks @github-actions`, etc. — the full list
is in `scripts/check-release-notes.ts`. Run it before pushing release
notes.

### When you ship a change

If your PR adds a `.changeset/*.md` for the `executor` package, also
edit `apps/cli/release-notes/next.md`. The changeset describes the
version bump; the release-notes file describes the user impact. They're
different audiences and shouldn't be conflated.

The `.changeset/*.md` body is fine as a one-liner pointing at the
release-notes section it expands.

## Notes

- Changesets owns the published CLI version via `apps/cli/package.json`.
- Only `apps/cli/package.json` should change during release versioning; the rest of the workspace is not version-synced for release PRs.
- Changesets changelog file generation is disabled (`changelog: false`
  in `.changeset/config.json`), but per-package `CHANGELOG.md` stubs are
  still committed. The `changesets/action@v1` GitHub Action (the wrapper
  around the CLI used in `release.yml`) reads each bumped package's
  `CHANGELOG.md` to build the Version Packages PR description and crashes
  with `ENOENT` if any are missing. The stubs satisfy that read; the
  changesets CLI alone doesn't need them.
- The publish workflow supports either npm trusted publishing or an `NPM_TOKEN` secret.
- Re-running the publish workflow for the same tag is safe for packages that are already on npm; existing versions are skipped.
