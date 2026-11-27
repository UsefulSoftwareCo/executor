---
title: Ship skills with an app
description: "Bundle Agent Skills in skills/<name>/SKILL.md, load skills lazily with dynamicSkills, or publish router instructions in an Executor app."
slug: "/build/skills"
---

An Executor app can ship Agent Skills (Markdown instructions and reference files) read through the MCP `skills` tool. Put skill folders under `skills/<name>/SKILL.md` for automatic discovery, load remote collections lazily with `dynamicSkills`, `githubSkills`, and `wellKnownSkills` (`apps/skills`), or attach `instructions` to a router on **Local**, **Self-host**, and **Cloud**.

**The step that matters most:** add `skills/<skill-name>/SKILL.md` with YAML `name` and `description` frontmatter and deploy—omitting `skills` in `defineApp` loads `skills/` automatically.

**Prerequisites:** an editable app ([Build an app](/docs/build)) and a connection that can use it. Link any account the app requires.

**You'll know it worked when…** the skill appears on **Skills** and `executor skills --app review-skills --name triage` returns your `SKILL.md`.

## How to use it

Skill files and loaders work the same way on **Local**, **Self-host**, and **Cloud**. Deploy to the target you plan to read from: on **Local** without a configured (`--host` / `EXECUTOR_HOST`) or remembered host, `executor skills` uses the background service. On **Cloud** and **Self-host**, tools CLI sign-in (`executor login --host <origin>`) is separate from `executor apps login` on `2.0.0-beta.79`; alternatively use an MCP connection with access to the same organization and app. Link any accounts required by the app or its loader before reading.

### 1. Ship a packaged `skills/` folder

Create one folder per skill under `skills/` containing a required `SKILL.md` and any optional UTF-8 text reference files (for example `skills/triage/SKILL.md` and `skills/triage/severity.md`):

- Each `SKILL.md` starts with YAML frontmatter containing `name` (must match the directory name) and `description`.
- Optional frontmatter keys are `license`, `compatibility`, `metadata` (string map), and `allowed-tools`.
- Omit `skills` from `defineApp` to load `skills/` automatically. If you supply an explicit `skills` array in `defineApp` (including `[]`), it replaces automatic discovery—call `folderSkills({ files: ctx.files })` (or `{ files: ctx.files, path: "guides" }`) from `apps/skills` to include packaged folders alongside other skills.

### 2. Load remote skills lazily with `dynamicSkills`

To load remote skills when skills are listed or read, return `dynamicSkills({ list: async () => ... })` in `defineApp`:

- **`githubSkills({ repo, path?, ref?, fetch?, cache?, signal? })`** reads a public repository. See the helper's `GitHubSkillsOptions` for private repositories. When you supply a cache, private catalogs use account-scoped caching.
- **`wellKnownSkills({ url, fetch?, cache?, signal? })`** reads `/.well-known/agent-skills/index.json` and its listed UTF-8 files.
- **`skillReader({ service, fetch: ctx.fetch, signal: ctx.signal })`** returns a reader with `.text(url)` and `.json(url)` that share a byte budget. Parse collected `{ path, content }` files into one skill with `await fileSkill(files)`.

### 3. Publish router instructions as skills

Setting `instructions` on `router(children, { instructions: "..." })` automatically publishes a skill:

- The root router's skill is named `tools`; a nested router's skill is `tools-<path>` (for example `tools-issues`). Router paths receive a slug plus a hash when any segment is outside `[a-z][a-z0-9]*` or the prefixed skill name would exceed 64 characters.
- Avoid naming your own skills `tools` or `tools-...` unless you intend to replace a router's instructions.

## Example

Save these files in `./review-skills` (replacing `0.0.1-beta.148` with the `version` reported by `executor apps framework` if your host reports a different release):

```json review-skills/package.json
{
  "name": "review-skills",
  "private": true,
  "dependencies": {
    "apps": "0.0.1-beta.148"
  }
}
```

```ts review-skills/index.ts
import { defineApp } from "apps";

export default defineApp({}, {});
```

```markdown review-skills/skills/triage/SKILL.md
---
name: triage
description: "How to search, label, and escalate incoming support issues."
---

# Issue triage

1. Call `issues.list` first to check for duplicates before creating an issue.
2. Never close an issue you did not open unless the user confirms.
3. Read `severity.md` for escalation criteria.
```

```markdown review-skills/skills/triage/severity.md
# Severity levels

- **P1:** Customer-facing outage or data loss. Page the on-call engineer immediately.
- **P2:** Degraded workflow with a workaround. Assign to the owning team within one business day.
```

Deploy `./review-skills` as **Review Skills** and read both files through the CLI:

```bash
APP_ID=$(executor apps create --name "Review Skills" --files ./review-skills | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).id')
executor apps deploy --app "$APP_ID" --files ./review-skills
executor skills --app review-skills --name triage
executor skills --app review-skills --name triage --file severity.md
```

Check that the first read returns `file: "SKILL.md"` with the `# Issue triage` heading and lists `severity.md` in `files`, and the second read returns `file: "severity.md"` with the `# Severity levels` heading.

### Combining packaged and remote GitHub skills

Use `dynamicSkills` and `githubSkills` to combine packaged and remote skills. Replace `owner/repo` with a public repository containing valid `skills/<name>/SKILL.md` files. Use names distinct from your packaged skills. Listing or reading skills can run the dynamic loader.

```ts
import { defineApp, dynamicSkills, router } from "apps";
import { folderSkills, githubSkills } from "apps/skills";

export default defineApp({}, async ({ cache, files, signal }) => ({
  tools: router({}),
  skills: await folderSkills({ files }),
  dynamicSkills: dynamicSkills({
    list: () =>
      githubSkills({
        repo: "owner/repo",
        path: "skills",
        cache,
        signal,
      }),
  }),
}));
```

## Limits

- **Skill format rules:** `name` permits lowercase Unicode letters and numbers plus single separating ASCII hyphens, at most 64 characters, and must match its folder name. `description` must be non-empty and at most 1,024 characters; `compatibility` is at most 500 characters. Skill names must be unique across static and dynamic catalogs.
- **Text files, app evaluation, and permissions:** the skill reader returns UTF-8 files as text, including script files, and does not execute the returned file. Listing or reading skills can evaluate the app's code and run its dynamic skill loader with linked accounts. Skill text and `allowed-tools` frontmatter metadata grant no permissions; tool calls still use the connection's authorization and [tool approvals](/docs/build/input-and-approvals).
- **Load budgets:** packaged skill files count toward the app's 16 MiB source limit (see [Build an app](/docs/build#limits)). Each `skillReader` instance limits reads to 2,000,000 bytes per response and 20,000,000 bytes total. Bound file count and parallel requests in your custom loader. The built-in `githubSkills` and `wellKnownSkills` loaders apply those byte limits plus a 1,000-file limit and up to eight parallel file fetches.
- **Caching remote skills:** pass `cache: ctx.cache` to the built-in remote catalog loaders. Cached direct reads recheck the upstream publication after `freshFor` (five minutes by default). Broad listings can use a retained catalog.

## Related

- [Build an app](/docs/build)
- [Tools, routers, and schemas](/docs/build/tools)
- [Input prompts and tool approvals](/docs/build/input-and-approvals)
- [Tools and approvals](/docs/concepts/tools-and-approvals)
