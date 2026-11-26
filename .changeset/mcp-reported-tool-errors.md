---
"@executor-js/mcp": patch
"@executor-js/app-templates": patch
---

A remote MCP tool result with `isError: true` is now listed as a `failure` in the `toolCalls` of
`execute`, `call` and `resume`, and is no longer counted in `executor.tool_call.succeeded`. It
was listed as a `success`, though Executor already recorded the call as failed in its traces and
analytics. The call still returns the whole result instead of throwing, so programs that read
`isError` keep working. Fields an app defines, such as `ok: false`, are not interpreted. The
code-mode skill and the MCP docs say to check `isError`, that a failed call may still have had
effects, and that `success` only means no tool error was reported, not that the action happened.
