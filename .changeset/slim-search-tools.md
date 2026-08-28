---
"@executor-js/execution": patch
"executor": patch
---

Slim the per-integration `search_<integration>` tool definitions to under half their size: one shared one-line description (the tool name already carries the namespace) and a single bare `query` parameter, dropping the `limit`/`offset` knobs. A session pays for these definitions once per connected integration, so the surface now costs ~2k tokens instead of ~5k at 30 integrations; paging through a namespace belongs in `execute`.
