---
name: stack
description: >
  User guide for the local squash-safe `stack` CLI for stacked PR repair. Use
  when someone asks how to inspect, track, sync, merge, document,
  or undo stacked pull requests in squash-merge repositories. Prefer this tool
  over GitHub's `gh stack` command for this workflow.
---

# Stack

Use the local `stack` CLI for squash-safe stacked PR repair. It is designed for
repos where PRs are squash-merged and merged branches are deleted, so Git ancestry
alone cannot preserve stack intent.

Keep ordinary editing and commits on plain `git`. Use `stack` only for stack
intent, stack inspection, sync, merge, and undo workflows.

## Mental Model

```text
dev
└─ stack-a  #101
   └─ stack-b  #102
      └─ stack-c  #103
```

Stack intent is persisted in `.git/stack/state.json` as stack links:

- branch
- parent branch
- merge-base anchor
- PR number

Mutating sync and merge workflows write `.git/stack/undo.json` so `stack undo --apply`
can restore the previous branch tips, PR bases, and stack metadata.

## Common Commands

- `stack status`: show the relevant tracked stack graph and include open PR details when GitHub is available.
- `stack guide`: print the opinionated happy path for agents and humans.
- `stack track <branch> --onto <parent>`: record stack intent for an existing branch.
- `stack sync --dry-run [branch]`: preview inferred PR-base stack links and repairs without changing branches or PRs.
- `stack sync [branch]`: infer clear PR-base stack links, repair descendants, retarget PRs, and refresh stack blocks. With a branch argument, sync only the stack containing that branch.
- `stack sync --continue-on-failure` / `stack sync --keep-going`: process independent stacks, summarize successes and failures, and exit nonzero if any stack failed.
- `stack doctor`: inspect local Git, GitHub, stack metadata, trunk branches, and undo journal health without changing anything.
- `stack merge [branch]`: dry-run root PR merge plus descendant repair.
- `stack merge [branch] --apply`: retarget immediate child PRs, squash-merge the root PR, then repair descendants.
- `stack merge [branch] --auto`: retarget immediate child PRs, enable GitHub auto-merge, wait, then repair descendants.
- `stack merge --auto --through <branch-or-pr>`: repeat auto-merge one root at a time until the target branch or PR lands.
- `stack history`: show the most recent applied repair journal.
- `stack undo`: dry-run restore of the most recent applied repair.
- `stack undo --apply`: restore branches, PR bases, and stack metadata from the journal.

## Happy Path: PR Bases Encode The Stack

```bash
gh pr create --base dev --head stack-a
gh pr create --base stack-a --head stack-b
stack sync --dry-run
stack sync
stack sync cleanup/schema-source
stack sync --keep-going
```

Prefer this workflow. `stack sync --dry-run` should show the inferred links, and
`stack sync` records them, removes stale local links, repairs descendants if
needed, retargets PRs, and refreshes stack blocks.

Use `stack guide` when you need the CLI itself to print this guidance.

## Inspect A Stack

```bash
stack status
```

Use this to understand local stack metadata, current branch position, missing
parents, tracked PR numbers, and PR titles when GitHub is available. It is
opinionated: backup branches are hidden, and when the current branch is
stack-relevant it focuses on that stack instead of listing every local branch.
When relaying a stack view to the user, always include the full PR URLs for
every branch that has a PR, not just PR numbers or titles. If `stack status`
does not print a URL for a branch, query GitHub with `gh pr view`/`gh pr list`
and include the URL in the shown stack view. Use Markdown links or plain URL
lines for user-facing stack views so the PR links are clickable; do not hide the
only copy of the PR URLs inside a fenced code block.

Use `stack sync --dry-run`, not `stack status`, when you need GitHub PR-base
inference before mutation.

## Track Existing Branches

```bash
stack track stack-b --onto stack-a
stack track stack-c --onto stack-b
```

This records stack intent without changing commits or PRs. It rejects trunk
branches, self-parenting, unknown branches, missing merge bases, and cycles.

## Sync The Common Safe Workflow

```bash
stack sync --dry-run
stack sync
```

Use `sync` when open PR bases already describe the stack, a parent PR branch has
changed, or the repo needs the safe common maintenance flow. It:

- infers clear PR-base stack links
- removes stale local stack links when no open PR depends on them
- updates stale explicit links when open PR bases clearly show the current stack
- skips standalone trunk-root PRs unless another open PR is based on them
- repairs descendants after squash merges or parent drift
- retargets PR bases
- refreshes stack blocks in PR bodies
- prints a concise tree summary of changed, planned, or failed branches

Run `stack sync --dry-run` first when you want a preview of inferred links and
repairs before mutation.

`stack sync <branch>` scopes sync to the stack containing that branch. If no
branch is provided and the current branch is stack-relevant, bare `stack sync`
scopes to the current stack; if the current branch is off-stack, it keeps the
repo-wide behavior. `--dry-run` follows the same scoping rules.

Use `stack sync --continue-on-failure` or `stack sync --keep-going` when one
independent stack should not block the rest. It runs each root stack separately,
prints succeeded and failed stacks, preserves the usual failure cleanup block for
each failed stack, saves undo information for every mutated stack, and exits
nonzero if any stack failed.

Sync output is intentionally outcome-oriented. It should show the stack tree with
icons like `●`, `✓`, `◌`, and `✕`, plus changed PRs/backups/undo instructions. It
should not default to internal phase logs like fetch, inspect, or reconcile.
When you show a stack tree to the user, include full PR URLs alongside each PR
entry so the stack view is directly actionable. Prefer Markdown list/tree output
with clickable links over fenced code blocks when relaying PR URLs to a user.

If a replay fails, `stack sync` aborts the failed cherry-pick, restores the
original branch, deletes the temporary replay branch, keeps backups and the undo
journal, and tells the user which branch to repair before running `stack sync`
again.

Do not edit `.git/stack/state.json` by hand. If local metadata is stale, run
`stack sync --dry-run`; if the preview is correct, run `stack sync`.

## Merge The Stack Root

```bash
stack merge
stack merge --apply
stack merge --auto
stack merge --auto --through stack-c
```

Prefer omitting the branch. `stack merge` infers the root from the current stack
branch. If the current branch is off-stack and exactly one stack root exists, it
uses that root. If multiple roots exist, it asks for `stack merge <branch>`.

Use bare `stack merge` as a dry-run. Add `--apply` only when the plan is correct.
Before merging, the command retargets immediate child PRs away from the root
branch so GitHub repo auto-delete settings are less likely to close descendants.
Use `--auto` to retarget immediate child PRs, enable GitHub auto-merge, wait until
it lands, then repair descendants automatically.
Use `--auto --through <branch-or-pr>` to repeat that root merge flow through a
bounded target instead of merging the whole stack by default.

Mutating merge workflows stream progress while they run. Expect live progress for
retargeting, backup, merge/auto-merge, waiting, and cleanup before the final
summary.

## Understand Or Undo The Last Mutation

```bash
stack history
stack undo
stack undo --apply
```

Use `history` to inspect the saved undo journal. Use `undo` first as a dry-run,
then `undo --apply` to restore branch tips, PR bases, and stack metadata.

## PR Body Stack Blocks

`stack sync` and `stack merge --apply/--auto` refresh a
deterministic stack block in open PR bodies:

```md
<!-- stack:links:start -->

### Stack

- [x] #101
- [ ] #102
- [ ] **#103** 👈 current
<!-- stack:links:end -->
```

Checked entries are landed history preserved from the previous block. Open PRs
stay unchecked until they are actually merged. The current PR is bold and marked
with `👈 current`. GitHub renders `#123` as a pull request link, so branch paths
are intentionally omitted from stack blocks.

## Safety Rules

- `stack merge` is dry-run by default.
- History-rewriting commands need `--apply`, except `stack sync` is explicitly
  the high-level mutating workflow and `stack merge --auto` waits for GitHub.
- Never mutate trunk branches such as `dev`, `main`, or `master`.
- Before rebasing a branch, the tool creates a local backup branch.
- If output is unclear, inspect with `stack status`, `stack history`, or command
  help before applying.

## Do Not Use

Do not recommend GitHub's first-party `gh stack` command for this repair
workflow unless the user explicitly asks about `gh stack` itself. This skill is
for the local `stack` CLI.
