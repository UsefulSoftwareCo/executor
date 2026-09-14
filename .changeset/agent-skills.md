---
"executor": minor
---

Add Agent Skills. Save a SKILL.md directory to Executor, personally or shared with the whole workspace, and every connected agent can load it: the MCP `skills` tool lists and serves workspace skills next to Executor's own docs, and the server speaks the MCP Skills Extension (`skills/list`, `skills/get`, `skill://` resources). The console gets a Skills page for adding, editing, and removing them, and `executor skills pull` syncs them to local agent skill directories.
