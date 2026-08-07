---
"executor": minor
---

**New: an audit trail of every tool call — which integration an agent used, when, and how it ended**

Executor kept no record of tool usage. A run that called GitHub or Search Console left one HTTP line (`POST /mcp 200`) and nothing about which integration, which tool, or what came back; the analytics catalog is anonymous by construction and deliberately drops exactly those fields. That made two questions unanswerable after the fact: what did this agent touch, and what did my policies actually stop.

Every call through `execute` now writes a row: the address as called, its integration/connection/tool, the outcome, the policy that governed it, and how long it took. The rows that matter most are the ones with no other trace — a call a `block` policy stopped, and an approval someone declined, both of which end before any request is made. Read them from `executor.toolCalls.list()`, from `GET /api/tool-calls` (filter by integration, connection, outcome or time), or on the new **Activity** page in the console.

Arguments, results, and any text that came from outside are never stored: an argument can be a credential, and an upstream error message routinely echoes the request back. A failed call keeps its upstream `code`, never its message; a call keeps its top-level argument _names_, and only those that look like parameters rather than payloads. Writing a row can never fail a call, and never delays one by more than its own timeout.

Retention is left to the host: `executor.toolCalls.prune({ before })` removes old rows, and nothing schedules it for you — an audit log that quietly deletes itself on a default nobody chose is worse than one that grows.
