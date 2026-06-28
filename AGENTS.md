# AGENTS.md

This file is principles — the contracts that stay true while implementations
churn. For how to actually run, boot, share, or navigate things today
(fresh-worktree setup, dev servers, ports, environment gotchas), see
[RUNNING.md](RUNNING.md) (which may lag reality; it says so itself). For
writing e2e scenarios, see [e2e/AGENTS.md](e2e/AGENTS.md). Run
`bun run bootstrap` first in any fresh checkout or worktree.

## Task Completion Requirements

- Use Effect Vitest for tests.
- Run targeted tests with `vitest run ...` when working on a scoped area.
- The root/package `bun run test` scripts are allowed because they delegate to
  Vitest.
- NEVER run `bun test`.
- For code changes, run the narrowest useful verification before handing back.
- For broad or merge-ready changes, the full gates are `bun run format:check`,
  `bun run lint`, `bun run typecheck`, and `bun run test`.
- Always run `bun run format` before opening a PR so the diff lands
  already-formatted. Only commit formatting changes to files your branch
  actually touches: if `format` rewrites unrelated pre-existing files, leave
  those out of the PR (stage just your files).

## Handing Back Work: Evidence, Not Assertions

"Done" is something the user can open, not a claim. When work changes what a
user sees or touches, the handoff has three parts, delivered unprompted:

1. **Watch it** — an e2e scenario covers the change, and the handoff links
   directly to the specific run(s) that prove it, with one line each on what
   to look at. Never hand back a bare wall of green results: the user's
   question is "show me the new thing working," not "is everything healthy?"
2. **Touch it** — leave the session's dev server running and reachable over
   the user's tailnet, with credentials, so they can take over and poke at
   it. The instance you already booted for e2e IS this — leave it up rather
   than standing up something separate.
3. **What to try** — name the paths worth exercising by hand, especially
   ones no scenario pins yet. Honesty about coverage gaps is part of the
   handoff. A human driving a real browser from another device reaches
   states the test harness structurally cannot; invite that.

The same machinery runs in reverse: you can seed an environment INTO a
state — reproduce a bug live, stage data for the user to take over, set up
a walkthrough — and hand across the link. "Here's the broken state, live"
beats a paragraph describing it.

If no scenario covers the change yet, that is the cue to write one. When a
change is user-visible, embed the run's recording in the PR description —
reviewers should see the change, not just read about it.

Don't memorize the mechanics (ports, viewer, sharing commands) — discover
them from RUNNING.md and the code; they change.

## Service Emulators

When a test or demo needs an upstream API, OAuth/OIDC provider, or webhook
source, use the `@executor-js/emulate` emulators (GitHub, Google, Stripe,
Resend, WorkOS, and a dozen more) instead of writing a stub. They are
wire-level and stateful — real SDKs run against them unmodified — and each
serves a full OpenAPI spec ready for addSpec, mints real-shaped credentials,
runs working OAuth flows, and records every call in a request ledger you can
assert against. Hosted instances exist at `https://<service>.emulators.dev`
with zero setup. See the `emulate` skill
(`.claude/skills/emulate/SKILL.md`) for the control-plane reference and
recipes.

The emulators are a standalone project (`github.com/UsefulSoftwareCo/emulate`),
not vendored here — this repo only consumes the published `@executor-js/emulate`
package. You have full autonomy to change, publish, and deploy the emulators,
working directly on their `main`; the skill covers the loop. Don't re-introduce
a `vendor/` submodule for them.

## Attribution

Do not add any AI assistant, Claude, Anthropic, or Co-Authored-By
attribution/trailers to commits, commit messages, PRs, or generated files.

Pull request titles and descriptions are going to a public GitHub repo, so
avoid using specific names or internal info unless explicitly stated to.

## Collaboration Notes

The user uses speech to text occasionally, so if sentences are weird or words
are not right, infer the likely intent and ask only when needed.

Code is very cheap to write. Do not give time estimates; with agents, code is
practically instant to generate. Unless stated otherwise, time to implement is
not a blocker.

Never use em-dashes (the `—` character) anywhere: prose, docs, code comments,
commit messages, or PRs. Use commas, colons, parentheses, or separate sentences
instead.

## Reference Repos

Repos in `.reference`, such as Effect and effect-atom, are available for
patterns. If given a Git URL for reference, clone it into `.reference` and
inspect it there. Make sure to pull the latest changes from the reference repo
before using it.

## Engineering Priorities

- Prefer correctness and predictable behavior over short-term convenience.
- Preserve runtime behavior when changing lint, typing, or test structure.
- Keep package boundaries clear; use public package exports instead of relative
  imports across package roots.
- Extract shared logic only when the shared behavior is real and local patterns
  support it. Avoid broad generic abstractions for one-off duplication.

## Package Roles

- `packages/core/sdk`: executor core contracts, plugin wiring, scopes, sources,
  secrets, policies, and test fixtures. The `@executor-js/sdk/http-auth`
  subpath carries the shared placements-based auth-method vocabulary the HTTP
  protocol plugins compose (core itself never imports it — composition, not
  location, keeps core carrier-agnostic).
- `packages/core/storage-*`: storage adapters and storage test support.
- `packages/plugins/*`: protocol and provider plugins. Plugin-specific
  runtime, React, API, and testing helpers should live with the owning plugin.
- `packages/react`: shared React UI and atom/client integration.
- `packages/hosts/mcp`: MCP host surface for exposing Executor through MCP.
- `packages/kernel/*`: execution runtimes and code execution substrate.
- `apps/local`, `apps/cloud`, `apps/cli`, and `apps/desktop`: product entry
  points that compose the packages.

## Other

Please make note of mistakes you make in MISTAKES.md. If you find you wish you
had more context or tools, write that down in DESIRES.md. If you learn anything
about your env write that down in LEARNINGS.md.
