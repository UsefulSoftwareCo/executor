# AGENTS.md

Principles: the contracts that stay true while implementations churn. For how to
run, boot, share, or navigate things today, see [RUNNING.md](RUNNING.md); for
e2e scenarios, [e2e/AGENTS.md](e2e/AGENTS.md). Run `bun run bootstrap` first in
any fresh checkout or worktree.

## Task Completion

- Tests use Effect Vitest. Run scoped tests with `vitest run ...`. `bun run test`
  is fine (it delegates to Vitest); NEVER run `bun test`.
- Run the narrowest useful verification for a change. For broad or merge-ready
  work the full gates are `bun run format:check`, `lint`, `typecheck`, `test`.
- Run `bun run format` before opening a PR, staging only files your branch
  touched (leave unrelated files `format` rewrites out of the PR).

## Handing Back Work: Evidence, Not Assertions

"Done" is something the user can open, not a claim. When work changes what a user
sees, hand back: an e2e run that proves it (link the specific run with one line
on what to look at, not a wall of green), the dev server left running so they can
poke at it, and the paths worth trying by hand including ones no scenario covers
yet. If no scenario covers the change, write one, and embed its recording in the
PR. The machinery runs in reverse too: seed an environment into a state
(reproduce a bug live, stage data) and hand across the link.

## Service Emulators

For any test or demo needing an upstream API, OAuth/OIDC provider, or webhook
source, use the `@executor-js/emulate` emulators instead of writing a stub:
wire-level and stateful, real SDKs run unmodified, each serves a full OpenAPI
spec, mints real-shaped credentials, and records every call in a request ledger
to assert against. Hosted at `https://<service>.emulators.dev`. See the `emulate`
skill (`.claude/skills/emulate/SKILL.md`). They are a standalone project
(`github.com/UsefulSoftwareCo/emulate`) consumed here as the published package:
full autonomy to change, publish, and deploy them on their `main`; don't re-vendor.

## Attribution

No AI/Claude/Anthropic/Co-Authored-By attribution in commits, messages, PRs, or
generated files. PR titles and descriptions go to a public repo: no internal info
or specific names unless explicitly stated.

## Collaboration Notes

- The user uses speech-to-text; infer likely intent from odd wording, ask only
  when needed.
- Code is cheap to write: no time estimates, implementation time isn't a blocker.
- Never use em-dashes anywhere. Use commas, colons, parentheses, or separate
  sentences.

## Reference Repos

Repos in `.reference` (Effect, effect-atom, …) are available for patterns. Clone
a given Git URL into `.reference` and pull latest before using it.

## Engineering Priorities

- Prefer correctness and predictable behavior over short-term convenience.
- Preserve runtime behavior when changing lint, typing, or test structure.
- Keep package boundaries clear; use public package exports, not cross-package
  relative imports.
- Extract shared logic only when the shared behavior is real; avoid broad generic
  abstractions for one-off duplication.

## Package Roles

- `packages/core/sdk`: core contracts, plugin wiring, scopes, integrations, secrets,
  policies, fixtures. `@executor-js/sdk/http-auth` carries the shared auth-method
  vocabulary the HTTP protocol plugins compose (core never imports it, keeping it
  carrier-agnostic).
- `packages/core/storage-*`: storage adapters and test support.
- `packages/plugins/*`: protocol and provider plugins; their runtime, React, API,
  and testing helpers live with the owning plugin.
- `packages/react`: shared React UI and atom/client integration.
- `packages/hosts/mcp`: MCP host surface.
- `packages/kernel/*`: execution runtimes and code execution substrate.
- `apps/{local,cloud,cli,desktop}`: product entry points composing the packages.

## Other

Note mistakes in MISTAKES.md, missing context or tools in DESIRES.md, and env
learnings in LEARNINGS.md.
