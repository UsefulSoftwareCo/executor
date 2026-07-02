---
name: cli-release
description: Runbook for releasing the `executor` CLI package (stable and beta). Covers scope of what ships with the CLI, user-facing changelog conventions, Changesets + Version Packages PR flow, beta train entry/exit, and owner preferences. Use when the user asks to cut a release, prepare release notes, enter/exit a beta train, or write changesets for the CLI.
---

# Executor CLI release runbook

## Authoritative doc

`RELEASING.md` at repo root is the source of truth. This skill encodes the owner's preferences on top of it.

## What the `executor` CLI actually ships

The CLI binary bundles:

- `apps/cli/**` — CLI source + daemon
- `apps/local/**` — the web UI (embedded as a virtual module via `apps/cli/src/build.ts:178`) + drizzle migrations (`build.ts:205`)
- `packages/**` — `core`, `kernel`, `hosts/mcp`, `runtime-quickjs`, and every plugin under `packages/plugins/**`

Does **not** ship in the CLI:

- `apps/cloud/**` (Cloudflare Workers deployment)
- `apps/marketing/**`, `apps/desktop/**`
- `examples/**`, `tests/**`

**Implication for changelogs**: when asked "what changed since the last release", scope is `git log v<last>..HEAD -- apps/cli apps/local packages`, not just `apps/cli`. Skipping `apps/local` and `packages` misses the bulk of product changes (Connections UI, OAuth plugins, SDK scope, OTEL, etc.).

## Versioning preferences

- Prior convention in this repo uses **`patch`** bumps for feature-heavy releases (see `.changeset/executor-1.4.6-beta.md` for precedent). Don't push back on patch unless there are genuine SemVer-breaking API changes to a library consumer surface.
- Breaking CLI UX changes (removed flags, changed argv shape) have historically still been `patch` bumps. Follow the owner's call — ask, don't assume `minor`.
- Normal release/patch PRs must add a `.changeset/*.md` file with frontmatter like `"executor": patch`. Do **not** directly bump `apps/cli/package.json` or `bun.lock` in a feature/fix PR.
- Only the Changesets-generated `Version Packages` PR should move `apps/cli/package.json`. If a normal PR directly changes that version, merging it to `main` can make `.github/workflows/release.yml` tag the commit and dispatch `publish-executor-package.yml`, causing an immediate CLI publish.
- `@executor-js/*` library packages have their own publish path.

## Release notes: standard Changesets flow — the changeset body IS the changelog

As of v1.5.0 this repo uses the canonical Changesets pipeline. The old
`apps/cli/release-notes/next.md` rolling file is gone — do not recreate it.

### How it's wired

- Every user-visible PR adds a `.changeset/*.md`; its **body** is the
  user-facing changelog entry.
- `changeset version` (run by `changesets/action@v1` when building the
  Version Packages PR) compiles changeset bodies into each bumped
  package's `CHANGELOG.md` using `@changesets/changelog-github`
  (configured in `.changeset/config.json`), which prefixes each entry
  with the PR link and credits the author automatically.
- `apps/cli/src/release.ts` (`changelogSectionForVersion`) extracts the
  released version's `## <version>` section from `apps/cli/CHANGELOG.md`
  and uses it as the GitHub Release body. Missing section → falls back to
  `--generate-notes`.
- Per-package `CHANGELOG.md` seed files are still required for every
  workspace package (`bun run lint:changelog-stubs --fix` creates them);
  `changesets/action@v1` crashes with `ENOENT` on missing files.
- `@changesets/changelog-github` needs `GITHUB_TOKEN` during
  `changeset version`. CI provides it; locally:
  `GITHUB_TOKEN=$(gh auth token) bun run changeset:version`.

### Writing changeset bodies

- Lead with user-visible behavior, not implementation. One sentence for a
  typical fix; a short paragraph for a feature.
- Big releases: a changeset body can be a full markdown section — use
  **bold sub-headings** + bullets, never `#`/`##` headings (they end up
  nested inside a changelog list item).
- Breaking changes: include the before/after surface in the body.
- Don't duplicate content across changesets — every changeset in the
  release lands in the same version section.
- Attribution is automatic via changelog-github; don't hand-write
  `Thanks @...` lines.

### When drafting a release-spanning changeset from `git log`

- Look at `git diff v<last>..HEAD -- README.md` first — best single view of user-facing changes.
- Read commits in bulk (`git log --oneline v<last>..HEAD -- apps/cli apps/local packages`), bucket by theme, then write prose.
- Merged PRs without changesets still ship in the release — their content
  ships regardless; only the changelog text is driven by changesets. If
  something important landed without a changeset, fold its story into a
  release-summary changeset.

## Beta release flow

```
git checkout -b rs/beta-v<next>-start
bun run release:beta:start                 # creates .changeset/pre.json
# write .changeset/executor-<next>-beta.md (frontmatter + user-facing body)
git add ... && git commit                  # ONLY when owner says commit
git push -u origin rs/beta-v<next>-start
# Open PR -> merge -> release.yml opens "Version Packages (beta)" PR -> merge to publish
```

- Published under npm dist-tag `beta`.
- Users install: `npm i -g executor@beta`.
- Exit the train with `bun run release:beta:stop` when going back to stable.

## Stable release flow

Identical to beta except skip `release:beta:start`/`stop`. Changesets produce a normal `Version Packages` PR; merging publishes under `latest`.

## Owner preferences (hard rules)

- **Never commit until the owner explicitly says so.** Set everything up in the working tree, run `git status`, and stop.
- **No AI / Claude / Anthropic / Co-Authored-By trailers** in commits, commit messages, PRs, or any generated file. This is in `CLAUDE.md` — do not violate.
- **Branch naming**: `rs/<short-topic>` for Rhys's branches. Beta-start branch: `rs/beta-v<version>-start`.
- **Remote**: `origin` = `https://github.com/RhysSullivan/executor.git`. If another remote appears (e.g. a fork remote), ask whether to remove it.
- **Dirty working tree**: if there are uncommitted changes when starting a release, ask whether to include them, stash them, or commit separately first. Don't sweep them into the release commit silently.
- **Don't estimate time** — code is cheap to write. Focus on what to do, not how long it takes.
- **Fact-check scope claims** before publishing. If release notes say "does not affect X", verify by reading the diff.

## Common commands

```
bun run changeset                          # interactive; or write .changeset/*.md directly
bun run lint:changelog-stubs --fix         # seed missing per-package CHANGELOG.md files
bun run release:beta:start                 # enter prerelease
bun run release:beta:stop                  # exit prerelease
bun run release:publish:dry-run            # build full CLI payload without publishing
bun run release:publish:packages:dry-run   # pack @executor-js/* without publishing
bun run release:check                      # invoked by publish workflow
```

## What the workflow does after merge to `main`

1. `.github/workflows/release.yml` opens/updates a `Version Packages` PR.
2. Merging that PR:
   - Publishes every `@executor-js/*` library that's not yet on npm (via `scripts/publish-packages.ts`).
   - If `apps/cli/package.json` bumped, tags the commit and dispatches `publish-executor-package.yml`, which runs `release:check`, does a full dry-run build, publishes the CLI to npm, and creates/updates the GitHub Release with binary assets.

## Fallback behavior

If something is unclear (bump level, whether to include in-flight work, whether to push), **ask the owner**. A release is a high-blast-radius action; one clarifying question is cheaper than a rogue publish.
