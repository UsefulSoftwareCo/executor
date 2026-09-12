---
"executor": patch
---

Compile `describe.tool` previews against only the definitions a tool references, drop the compiler's per-call retained graph, and fall back to `unknown` for schemas over a node limit. Describing a tool from a large OpenAPI spec no longer burns seconds of CPU or leaks memory in the shared session isolate.
