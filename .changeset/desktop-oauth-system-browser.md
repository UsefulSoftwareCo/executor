---
"executor": patch
"@executor-js/desktop": patch
---

Desktop OAuth flows now open in the user's default browser instead of an
Electron child window. The renderer skips the in-page popup, calls
`window.executor.openExternal(authorizationUrl)`, and polls
`/api/oauth/await/:sessionId` for the completed result. Provider sessions
the user is already signed into (Google, GitHub, etc.) are picked up
without re-authenticating inside an isolated Electron cookie jar.

The completion side channel is local-only: `setOAuthCompletionListener`
is a noop hook in `@executor-js/api`, and the in-memory result store +
HTTP polling route are registered by the local server. Stateless
deployments (Cloudflare Workers) carry no footprint and continue to use
the existing `postMessage`/`BroadcastChannel` handoff.

Also hides the stdio MCP install command in the desktop renderer — that
path required the `executor` CLI on PATH, which the desktop app does not
provide. Desktop users see only the HTTP install command, which routes
through the running sidecar.
