---
"@executor-js/mcp": patch
"@executor-js/app-templates": patch
---

The MCP `skills` tool advertises the input it accepts: every input except `{}`
needs `app`, stated as `dependentRequired` in its input schema, which is
generated from the schema the tool decodes with. The `execute` descriptions and
the Executor app's entry skill give the exact call,
`skills({app: "executor", name: "executor"})`.
