---
"@executor-js/plugin-openapi": patch
"@executor-js/react": patch
---

Support POST health checks for APIs that expose reads through HTTP RPC. Warn that POST can change data, allow validated JSON request bodies, and display the reason when a configured probe cannot run.
