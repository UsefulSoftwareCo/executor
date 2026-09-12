---
"executor": patch
---

Report an MCP `execute` call that dies with a session reset as a JSON-RPC error instead of a silently closed stream. The front worker answers outstanding request ids when the session socket closes abnormally or a response deadline passes, and a rebuilt session answers ids stranded by a previous incarnation on the next stream. The plain memory-limit reset is now classified as transient.
