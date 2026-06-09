# Changesets

This repo uses Changesets to drive releases for the published `executor` CLI.

## What to put in a changeset

Only `executor` is managed directly by Changesets.

Release PRs should only mention the published CLI package directly. Changesets
will still version the fixed release group and dependent public packages as
needed, and will update each affected package's `CHANGELOG.md`.

Write the changeset body as the package changelog entry you want to appear in
the Version Packages PR and in the affected package changelogs. Keep broader
user-facing launch notes in `apps/cli/release-notes/next.md`; those are used for
the GitHub Release body.

## Beta releases

Use prerelease mode for beta trains:

- `bun run release:beta:start`
- merge release PRs while prerelease mode is active
- `bun run release:beta:stop` when you want to return to stable releases
