---
"executor": patch
---

Self-hosted MCP now delivers `elicitation_mode=native` approvals to the client. Before this fix, the server answered each `tools/call` as a single JSON body, so an `elicitation/create` sent during the call never reached the client and the call failed after 60s with `-32001 Request timed out`. Responses now stream, as they already do in the local app. Native approvals also wait up to 4 minutes for a human to answer, up from the MCP SDK's 60s default.
