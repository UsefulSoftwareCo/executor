---
"@executor-js/mcp": patch
"@executor-js/sdk": patch
"@executor-js/app-templates": patch
---

`execute` and `call` no longer limit the size of a result. A value over
100,000 bytes used to come back from `execute` as a success with its JSON cut
into a string that could not be parsed, and `call` refused it; both now return
the whole value, and logs come back whole. Approval requests and an app's own
questions are no longer refused for their size either. A failure that matches
the runtime's 32 MiB limit on one value crossing Workers RPC now names that limit
as the likely cause and says to ask for less if the result could be that large;
the app's Worker can produce the same text, so a read stays retryable once. On
local and self-host the runtime's reason for a failed call now reaches the host.
The code-mode skill states this.
