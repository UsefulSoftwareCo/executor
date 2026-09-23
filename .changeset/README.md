# Changesets

This repo uses Changesets to drive versioning. Development workspaces remain
`"private": true`, and the `executor` CLI package
does not exist in this repo yet (tracked by #229). The `fixed` group in
`config.json` is intentionally empty until #229/#231 land a real publish
target; add packages there once they are ready to ship together. `apps` now has
a separate staged npm artifact, built by `bun run apps:build`; its development
workspace stays private. See [the release notes](../notes/apps-publishing.md).

## What to put in a changeset

Add a changeset for any change to a package that is tracked by Changesets
(not listed in `ignore`), even while nothing publishes yet. This keeps
changelogs and version history accurate from the point a package goes public.

- `bun run changeset`

Write the changeset body as the changelog entry you want to appear in the
affected package's `CHANGELOG.md` and in the eventual Version Packages PR.

## Beta releases

This repo is in prerelease mode with tag `beta` (see `.changeset/pre.json`).
Versions produced by `bun run release:version` will look like
`0.1.0-beta.0` until prerelease mode is exited with:

- `bun run release:beta:stop`

Enter prerelease mode again with:

- `bun run release:beta:start`
