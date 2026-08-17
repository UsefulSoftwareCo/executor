---
"executor": patch
---

**Add `integrations.remove` to the core tools so an agent can drop a catalog integration**

`integrations.list` advertises `canRemove` per integration, but nothing on the agent surface could act on it: removal existed only on the HTTP API and the web console, so an agent that could add an integration could never take one back out. Cleaning up a catalog meant clicking through the UI once per integration.

The core-tools plugin now contributes `integrations.remove`, taking the `slug` reported by `integrations.list` and cascading to every connection under the integration and the tools those produced. It is approval-gated, being strictly more destructive than `connections.remove`. The `removed` flag is honest rather than always-true: `false` means no catalog row matched, so an already-absent slug and a built-in namespace like `executor` are distinguishable from a real removal, and an integration pinned with `canRemove: false` is refused with `IntegrationRemovalNotAllowedError` instead of silently surviving.
