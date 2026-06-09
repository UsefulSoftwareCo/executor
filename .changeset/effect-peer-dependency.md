---
"@executor-js/codemode-core": patch
"@executor-js/config": patch
"@executor-js/execution": patch
"@executor-js/plugin-file-secrets": patch
"@executor-js/plugin-graphql": patch
"@executor-js/plugin-keychain": patch
"@executor-js/plugin-mcp": patch
"@executor-js/plugin-onepassword": patch
"@executor-js/plugin-openapi": patch
"@executor-js/runtime-quickjs": patch
"@executor-js/sdk": patch
"executor": patch
---

Move `effect` from `dependencies` to `peerDependencies` in the published library packages so consumers provide a single shared Effect instance.
