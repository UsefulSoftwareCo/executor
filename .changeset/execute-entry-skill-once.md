---
"@executor-js/mcp": patch
---

The `execute` and `skills` descriptions no longer tell agents to read the
Executor app's entry skill first. The server instructions are that skill, so an
agent that received them would fetch the same text again; the descriptions now
say so and name the `skills` call only for clients that do not show server
instructions.
