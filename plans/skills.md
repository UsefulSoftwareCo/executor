# Skills — first-party capability plan

Skills are the "how" half of the catalog: [Agent Skills](https://agentskills.io/specification)
directories (`SKILL.md` with YAML frontmatter + optional `scripts/`, `references/`, `assets/`)
that carry procedure the way integrations carry capability. vision.md already stakes skills as
a first-party capability and an artifact kind; this plan pins the concrete shape.

Decisions (Ethan + Rhys, 2026-09-01). The design splits three ways: **bring in**, **use**,
**manage**.

## Format and posture

- The skill format is the [agentskills.io spec](https://agentskills.io/specification),
  unmodified. Executor stores and serves skills; it never interprets bodies.
- **Skills are pure content.** Executor does not execute `scripts/` — end agents run them
  locally if they choose. Bundled scripts are stored and served like any other skill file.
- **Security is deferred to users**, matching the trust posture integrations have today. If
  integrations grow an import-trust mechanism, skills adopt the same one. Imports are still
  hash-pinned (see below), so what you reviewed is what you have.

## Bring in

- **Add / create over MCP**: agent-facing bring-in tools on the MCP surface — add a skill
  from a source (GitHub URL, `.well-known` index) and create one in place (the vision.md
  `skills.create` authoring path), gated like the other authoring meta-capabilities.
- **Dashboard**: drop-in link, like adding an integration — paste a GitHub URL, we fetch and
  auto-fill name/description/file listing from the skill's frontmatter for confirmation.
- **CLI, `npx skills`-shaped**: `executor skills add <owner>/<repo>` (GitHub), plus import
  from the local filesystem (`executor skills add ./path`). Same discovery walk as the
  ecosystem CLI: `SKILL.md` directories under the usual container layouts. The CLI is a
  secondary surface — MCP and the dashboard are the primary bring-in paths.
- **Pinning + manual sync only.** Imports record source + content hash (lockfile semantics,
  the shape `skills-lock.json` already has). No background auto-update: a manual
  `executor skills sync` and a dashboard "check for updates" re-fetch from the source and
  show what changed before applying.

## Use

- **Adopt the MCP spec now**: serve skills per
  [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2640)
  (`io.modelcontextprotocol/skills`) — each skill file a resource under `skill://`, plus the
  `skill://index.json` enumeration. Track the SEP as it moves through review.
- **Pass-through**: when an upstream MCP server connected as an integration serves skills via
  the extension, Executor re-serves them transparently alongside locally stored ones — same
  index, same addressing, provenance recorded.
- **Code mode, while the spec standardizes**: the `execute` sandbox gets a `skills` function
  set — `skills.search()` / `skills.get(name)` — index entries are frontmatter only
  (name + description); bodies load only via `get`. Skills stay under `skills.*`; they do
  **not** appear in the general `tools.search` results.
- **Materialize to disk**: `executor skills sync` can also write the catalog into
  `.agents/skills/` for agents that only read local files. Nice-to-have, not a pillar —
  same secondary-CLI caveat as above.

## Manage

- **Own dashboard page**, separate from integrations: list, inspect (rendered SKILL.md +
  file tree), import, sync, delete.
- **Scoped like everything else**: a skill is personal or workspace-owned; visibility is
  union per the standard scope merge.
- **Toolsets**: skills attach to toolsets exactly like tools, so a scoped MCP endpoint
  serves the toolset's tools and its skills as one unit.

## Naming

The MCP host's existing `skills` tool serves Executor's own how-to docs
(`packages/core/execution/src/skills.ts`) and its comments already document models mistaking
it for a general skill reader. **Rename the internal tool** (it is a docs reader, not a skill
store) and free the `skills` name for the real capability. The internal registry stays a
separate, hand-curated thing.

## Sequencing

1. Rename the internal `skills` tool; land the skill store (workspace/personal scoped,
   file-backed) with `skills.search`/`skills.get` in code mode.
2. Bring-in surfaces: MCP add/create and dashboard drop-in with lockfile pinning and manual
   sync; CLI add (GitHub + filesystem) behind them.
3. Serve per SEP-2640 and pass through upstream MCP-served skills; `.agents/skills/`
   materialization.
4. Toolset attachment and the dashboard page's full management surface.

## References

- Spec: <https://agentskills.io/specification>
- SEP-2640 skills extension: <https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2640>;
  incubation: <https://github.com/modelcontextprotocol/experimental-ext-skills>
- `.well-known/agent-skills` discovery RFC (future serve surface):
  <https://github.com/cloudflare/agent-skills-discovery-rfc>
- Ecosystem CLI the bring-in mirrors: <https://github.com/vercel-labs/skills>
