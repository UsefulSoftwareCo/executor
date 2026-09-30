---
"@executor-js/sdk": minor
"@executor-js/api": minor
"@executor-js/react": minor
"@executor-js/local": minor
---

Serve a per-app loopback OAuth callback, so providers without dynamic client
registration can be connected from a local Executor.

Some providers only accept a `redirect_uri` that is already registered on their
own OAuth app — Slack's MCP server answers anything else with `redirect_uri did
not match any configured URIs` — and that app usually pins a loopback port this
Executor could not offer. A registered OAuth app can now declare a
`callbackPort` (and optionally a `callbackPath`, default `/callback`) in
"Register an OAuth app"; the host binds `http://127.0.0.1:<port><path>` for the
flow and sends it as `redirect_uri` on both the authorization request and the
token exchange. The listener forwards the provider's callback to the existing
completion route and closes once the flow is done. A port already in use — by
another local client mid-sign-in, say — fails the connect with that reason
instead of stranding the user at the provider.

Two behaviours worth knowing about:

- Starting a flow for an app that declares a callback requires passing that
  exact URI as `redirectUri` (a host reads it from `oauth.loopbackCallback` and
  binds it first). A caller that never asked for it — the agent-facing
  `oauth.start` tool, for one — is refused with an actionable message rather
  than handed an authorization URL nothing is listening at.
- A listener bound for a single flow closes as soon as it has served the
  callback. If a second flow claims the same URI, the listener is left to its
  TTL instead, so the first completion cannot pull the callback out from under
  the second.
