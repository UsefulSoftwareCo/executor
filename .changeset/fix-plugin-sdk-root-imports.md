---
"@executor-js/plugin-file-secrets": patch
"@executor-js/plugin-keychain": patch
---

Import plugin-authoring symbols from `@executor-js/sdk/core` instead of the package root. The published root is the Promise surface and does not export `StorageError`, `definePlugin`, `PluginCtx`, or `Plugin`, so both packages failed to load when installed from npm.
