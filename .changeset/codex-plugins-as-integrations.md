---
"executor": patch
"@executor-js/plugin-mcp": patch
"@executor-js/sdk": patch
---

Add locally installed OpenAI Codex plugins as one-click integrations: Messages
(iMessage/SMS), Chrome, Computer Use, Computer History, and OpenAI Developer
Docs. They appear in the connect dialog with their own icons, and a card that
cannot run yet says what to install and links to it.

Tool calls reach the plugins through `codex app-server` rather than a plugin's
own MCP server, because their services only honour calls from a Codex host
session. Computer Use and Chrome ship no MCP server at all, so their APIs are
projected as typed tools — `list_apps`, `click`, `read_page`, `navigate` — that
compile to a single call each. No model turn is involved; nothing is bundled or
downloaded, and a machine without Codex simply sees the setup steps.

A plugin's own approval prompt now reaches the caller, and states the terms it
carries: a browser prompt that persists for a site says so. Approvals are asked
once per session rather than per call.

Elicitation requests can carry implementation-defined metadata through
`FormElicitation` / `UrlElicitation`, and a paused execution reports it. Both
fields are optional and additive.
