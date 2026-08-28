---
"@executor-js/plugin-mcp": patch
---

**An MCP tool's reserved `_meta` map survives `tools/list` decoding and reaches the persisted catalog**

The MCP spec reserves `_meta` on `Tool` for implementation-defined data, and servers use it for host-only routing and policy hints that do not belong in the closed `annotations` set. The plugin decoded each listed tool with a closed struct that did not declare the field, so `_meta` was discarded before the manifest entry was built. A host that embeds the plugin as its MCP client had no way to recover it: no hook exposes the raw `tools/list` result, and `connections.refresh()` answers with already-built tools.

The listed-tool decode now declares `_meta`, and the manifest entry carries it through. Executor's own `Tool` has no `_meta` field, so `toToolDef` stamps the map into the `mcp` envelope the plugin already persists in each tool row's annotations, next to the real MCP tool name. The stamp schema declares it too, so it is not stripped a second time when a row is read back at invoke time. A host reads it from `annotations.mcp._meta`.

The map stays opaque. Nothing in the plugin interprets its contents, and it is never merged into anything the model sees. Because it is entirely server-controlled, it is decoded permissively: a `_meta` that is not the spec's map shape is ignored for that tool rather than failing the whole-list decode, which would otherwise drop every tool the server advertises.
