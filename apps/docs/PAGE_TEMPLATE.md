# Documentation page template

This file is internal authoring guidance and is not published (it sits outside
`apps/docs/content/`).

Every feature page under `apps/docs/content/` follows this fixed shape so a
person or a cold agent can find the page, verify applicability, complete the
task, and confirm it worked from one read.

## File and front matter

- Choose `.mdx` when the page uses Blume components (`Steps`, `Tabs`,
  `CodeGroup`, `CardGroup`/`Card`, `FileTree`) and `.md` when it is plain
  Markdown.
- Use `title` and `description` for Executor feature pages. Blume's default
  strict build rejects unknown front-matter keys.
- Name the feature in the words people search for. `llms.txt` prints
  `description`, so write it as the page's one-sentence pitch.
- Target **400–1,500 words**. Hard ceiling: **~1,800 words**.

```markdown
---
title: <Feature name in plain words>
description: "<One-sentence pitch naming the feature and what a reader can do with it.>"
---
```

## Required structure

### 1. Opening (first ~150 words)

Deliver these elements before the first `##` heading (or within the opening
section):

1. **What it is** in one plain sentence.
2. **Exact names** people and agents need: button labels, tab names, CLI
   commands, MCP tool names, API exports, or environment variables.
3. **Target availability**: explicitly state which targets have it
   (**Local**, **Self-host**, **Cloud**).
4. **The one command or step that matters** most.
5. **Prerequisites and permissions** (when the page has a task to do): state
   required accounts, roles (such as organization owner/admin vs member), app
   edit permissions, connection scopes (**Full access** / **All apps**), and
   CLI host-selection rules _before_ the steps.
6. **Success check** ("You'll know it worked when…") stating an observable
   outcome that actually proves the feature worked (not a listing-only check
   when a read or write is the goal).

### 2. How to use it

- Walk through the task directly with exact UI labels, routes, and commands.
- **Per-target worked paths**: where a page has a task to do, include one
  worked path per target (**Local**, **Self-host**, **Cloud**) that behaves
  differently (including different authentication, origins, host selection, or
  permissions). If two targets share the exact same steps, state that once
  rather than duplicating identical instructions.
- Put destructive or cleanup actions (such as unpublishing or removing) in a
  separate step from initial creation so a reader running the block top to
  bottom does not undo what they just built.

### 3. Example

- Use released code, built-in skills, or e2e tests for behavior and synthetic
  data for names, tokens, and payloads.
- **Examples must actually run and type-check**: include every file required
  for the example to succeed (such as `package.json` with the host's pinned
  `apps` version and SQL `migrations/*.sql` files when the example uses
  `ctx.sql`). Type-check TypeScript examples against the released `packages/apps`
  types, avoid shell redirection placeholders like `<app-id>` in runnable
  commands (use shell variables such as `"$APP_ID"`), and include the expected
  result.
- Record the exact repository source or fixture paths in `apps/docs/SOURCES.md`
  (outside `apps/docs/content/`). Do **not** embed `<!-- Source: ... -->` HTML
  comments inside published pages—Blume emits HTML comments into both the
  rendered HTML and the raw `.md` files served to agents.

### 4. Limits

- Document real limits, validation rules, error codes, platform caveats, and
  missing capabilities verified from code.
- Do not promise behavior that only exists in a subset of targets or operating
  systems without stating the condition.
- Never write claims stronger than what the code actually enforces (for
  example, do not claim committed source files cannot contain secrets, or that
  pattern-based log masking is comprehensive redaction).

### 5. Related

- End every page with a `## Related` section.
- Write every internal docs link with the `/docs/...` prefix (for example
  `[Author an app](/docs/author-an-app)`) so links work both on the HTML site
  and in the raw `.md` files served to agents.
- Verify that every linked destination exists, renders cleanly, and does not
  send a reader into `main`-only instructions that contradict the released
  version documented on the page.

## Accuracy, release scope, and public claims review

- **Code is the truth**: verify every command, flag, file name, API export,
  MCP tool, UI label, limit, permission check, and target claim against source
  code at the released commit.
- **Released behavior only**: document behavior shipped in the current released
  versions (the published CLI/desktop beta and deployed Cloud). Leave out
  flag-gated experiments and changes that exist only on `main`.
- **Public claims needing founder sign-off**: collect every statement about
  security, where credentials live, what team members can see, pricing, plans,
  or SSO verbatim in the PR description or review hand-back for founder
  sign-off. Do **not** leave `<!-- RHYS-REVIEW: ... -->` HTML comments in
  published pages under `apps/docs/content/` because they leak into public HTML
  and `.md` copies.
- **Vocabulary**: follow `CONTEXT.md` (`provider`, `account`, `app`, `version`,
  `tool`, `approval`, `organization`). Avoid `integration`, `toolkit`, or
  `policy` as substitutes.
- **Privacy**: never include customer names or customer-derived data. Use
  synthetic examples only.
