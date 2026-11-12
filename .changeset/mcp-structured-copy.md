---
"apps": patch
"@executor-js/app-templates": patch
---

Remote MCP results drop a text block that only repeats `structuredContent` as
JSON. Servers send that copy for clients that cannot read structured results;
kept, it doubled the result at every nested MCP hop, such as Executor behind
Executor. Read `structuredContent`; other content is unchanged.
