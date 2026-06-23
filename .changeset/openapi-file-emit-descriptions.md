---
"executor": patch
---

OpenAPI tools that return a file now spell out how to emit it directly in the
tool's description, so an agent sees the `emit(result.data)` contract before its
first call instead of only discovering it after a failed attempt or by reading
`describe.tool`. Non-file tools are unchanged.
