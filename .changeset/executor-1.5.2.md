---
"executor": patch
---

**Desktop**

- Fixed the desktop app failing to launch: the packaged sidecar was missing its native SQLite and keychain bindings, so the local server exited before the window appeared. The release pipeline now smoke-tests the compiled sidecar before publishing.
- Mac auto-updates now serve the correct architecture — the arm64 and x64 update manifests previously collided, so Apple Silicon machines could be offered Intel builds.
- If the local server fails to start, the app now shows the error (with a pointer to the log) and installs any available update on quit, instead of closing silently.

**Integrations & auth**

- Integrations can declare multiple authentication methods in every plugin. MCP servers join the slugged template model used by OpenAPI and GraphQL, so a server can offer OAuth and an API key side by side, and adding a custom method appends instead of replacing a detected one. Existing connections keep working with no migration.
- OAuth app management is folded into the connect modal, so client setup happens where accounts are added.
