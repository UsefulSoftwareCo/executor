---
title: Skills
description: "Package instructions and reference files in an app's skills/ folder, read them with the MCP skills tool, MCP Skills extension, or CLI, and edit them in the dashboard."
---

Skills are Markdown instructions and reference files that apps ship to teach agents how to use their tools. Package them under `skills/<name>/SKILL.md` (or load via `folderSkills`, `dynamicSkills`, `githubSkills`, and `wellKnownSkills`), read them with MCP `skills`, the MCP Skills extension (`io.modelcontextprotocol/skills`), or `executor skills`, and edit them on the **Skills** tab (**New skill**, **Add file**, **Save**). Available on **Local**, **Self-host**, and **Cloud**.

**Key step:** add `skills/<name>/SKILL.md` with `name` and `description` frontmatter, deploy the app, and read it with `executor skills --app <slug> --name <name>`.

**Prerequisites:** a deployed app that your connection can access (plus any account the app requires to read its skills) for reading, or app edit permission for dashboard editing.

**You'll know it worked when…** `executor skills --app <slug>` lists your skill by name, and `executor skills --app <slug> --name <name>` returns `file: "SKILL.md"` with your instructions in `content` (or `skills({ app: "<slug>", name: "<name>" })` returns it in MCP).

## How to use it

### 1. Connect on Local, Cloud, or Self-host

- **Local:** install the Executor 2 CLI and run `executor skills`. With no host configured or remembered, it starts or uses your local Executor.
- **Cloud:** run `executor login` and approve access to the app you want to read, then run the same `executor skills` commands. (If you deploy an app with `executor apps` in CLI beta.79, also run `executor apps login`.)
- **Self-host:** run `executor login --host https://executor.example.com` and approve access, then run the same `executor skills` commands. (Use `executor apps login --host https://executor.example.com` for `executor apps` deploys in CLI beta.79.)

Connect your MCP client to the same target with access to that app (see [CLI setup](/docs/run/cli#use-your-tools-from-a-shell) and [Add an MCP client](/docs/mcp-clients); using Executor CLI 2.0.0-beta.79? Use the separate `executor login` and `executor apps login` commands above). Apps that require a linked account may need that account connected before their skills can be read.

### 2. Create and edit skills in the dashboard

1. Open an app and select the **Skills** tab.
2. Click **New skill**, enter **Name** and **Description** (click **Edit** next to **Identifier** if you want to customize it), and click **Create skill** (this commits and starts a deploy).
3. To add a reference file, click **Add file**, enter a new relative **File path** (such as `references/examples.md`), and click **Create file**. Invalid relative paths and duplicate file paths are rejected.
4. Select **Instructions** to edit `SKILL.md`. Use **Editor settings** to switch a Markdown file to **Markdown** or enable **Vim mode**.
5. Click **Save** to commit and start a deploy (if the deploy fails, the status shows **Not deployed** with **Retry deploy**). Click **Discard** and confirm to revert unsaved edits.
6. In the editing workspace, skills supplied by a catalog without editable source appear as **Read-only**. People with view-only access can read deployed skills.

### 3. Ship static or dynamic skills in app code

- **Packaged folder (default):** omit `skills` in `defineApp` to bundle every `skills/<name>/SKILL.md` and its sibling UTF-8 text files automatically. To load from a different folder, import `folderSkills` from `apps/skills` and return `skills: await folderSkills({ files: ctx.files, path: "guides" })` from your `defineApp` factory (or `skills: []` to disable auto-discovery).
- **Remote skills (`dynamicSkills`):** import `dynamicSkills` from `apps` and `githubSkills` or `wellKnownSkills` from `apps/skills`. Return `dynamicSkills: dynamicSkills({ list: async () => ... })` and call the remote helper inside `list` using the invocation's `ctx.fetch` and `ctx.signal`. Executor can call `list` when it lists or reads skills, including Skills extension discovery. Keep the remote fetch inside `list` so ordinary tool calls do not depend on that fetch.
- **Router instructions:** a router's `instructions` option produces a skill. The root router becomes `tools`, and a simple path such as `issues.open` becomes `tools-issues-open` (other paths or overlong names are hashed; check the skill listing for generated names). An authored skill with the same name takes precedence.

### 4. Read skills from MCP or the CLI

- **MCP `skills` tool:** `skills({})` lists summaries from accessible apps whose skills can be listed. Call `skills({ app: "<slug>", name: "<name>" })` to read `SKILL.md`. Pass the returned `version` and `revision` with a path from `files` to verify that the reference file matches the skill you read; if the revision changed (`SkillRevisionChanged`), read `SKILL.md` again.
- **MCP Skills extension (`io.modelcontextprotocol/skills`):** MCP clients that negotiate the Skills extension can discover `skill://<app-slug>/<skill-name>/SKILL.md` resources with SHA-256 digests and byte sizes.
- **CLI:**
  ```bash
  executor skills
  executor skills --app executor --name executor
  executor skills --app executor --name executor --file feedback.md
  ```

## Example

Save the four files below in `./shared-skills`. Set `dependencies.apps` in `package.json` to the version printed by `executor apps framework`:

`shared-skills/package.json`:
```json
{
  "name": "shared-skills",
  "private": true,
  "type": "module",
  "dependencies": {
    "apps": "<framework-version>"
  }
}
```

`shared-skills/index.ts`:
```ts
import { defineApp } from "apps";

export default defineApp({}, async () => ({}));
```

`shared-skills/skills/shared-guide/SKILL.md`:
```markdown
---
name: shared-guide
description: Synthetic shared-guide instructions.
---

Read [notes](references/deep/notes.md) for escalation rules.
```

`shared-skills/skills/shared-guide/references/deep/notes.md`:
```markdown
Escalation notes for shared-guide.
```

Create, deploy, and read both `SKILL.md` and the reference file. Run this on Local with no remembered host. On Cloud, run `executor apps login` before creating or deploying the app and `executor login` before reading skills. On Self-host, add `--host https://executor.example.com` to both login commands. The shell commands use `jq`; install it first, or copy the named fields from the JSON output:

```bash
CREATED="$(executor apps create --name "Shared skills" --files ./shared-skills)"
APP_ID="$(printf '%s' "$CREATED" | jq -r .id)"
APP_SLUG="$(printf '%s' "$CREATED" | jq -r .slug)"
executor apps deploy --app "$APP_ID" --files ./shared-skills

executor skills --app "$APP_SLUG" --name shared-guide
executor skills --app "$APP_SLUG" --name shared-guide --file references/deep/notes.md
```

## Limits

- **Names and metadata:** skill names must match their directory name, use lowercase Unicode letters and digits separated by single hyphens, and be at most 64 characters. `description` is capped at 1,024 characters and optional `compatibility` at 500 characters. Duplicate names among authored skills fail the app's skill read.
- **Remote loader limits and caching:** `githubSkills` and `wellKnownSkills` refuse HTTP redirects and enforce 1,000 files, 2 MB per response, and 20 MB total. With `cache: ctx.cache`, direct reads recheck a remote publication after `freshFor` (5 minutes by default; checks timing out after 5 seconds fail the read), while broad MCP and extension listings can reuse a retained catalog.
- **Packaged size:** packaged `skills/` files bundle into the app Worker and count toward the 16 MiB app source limit.
- **Listing omissions:** `skills({})` skips apps requiring an unlinked account and reports other load errors in `unavailableApps`. The MCP Skills extension listing omits apps without a deployed version, apps with duplicate visible slugs, apps requiring an unlinked account, failed loaders, and loaders that exceed the 5-second listing window.
- **Skill reader security:** listing or reading a skill can evaluate the app's code and run its dynamic skill loader with linked accounts. The skill reader returns UTF-8 files as text, including script files, and does not execute the returned file. Skill text and `allowed-tools` metadata grant no permissions. Tool calls still use the connection's authorization and selected approval mode. If you pass `cache: ctx.cache` to the built-in GitHub loader for a private repository, it stores the catalog in the linked GitHub account's cache scope.

## Related

- [The built-in Executor app](/docs/apps/executor-app)
- [Add an MCP client](/docs/mcp-clients)
- [App source and Git](/docs/apps/source-and-git)
- [Author an app](/docs/author-an-app)
- [The MCP endpoint](/docs/mcp)
- [Command line](/docs/run/cli)

Using Executor CLI 2.0.0-beta.79? For app management and Git, run `executor apps login`. For tool commands and MCP, run `executor login`. For Self-host, add `--host <your origin>` to the sign-in command.
