---
"apps": patch
---

An OpenAPI import now names the operations that can never be sent: a path placeholder with no
declared parameter, a path that writes a declared parameter as `:name`, `*name` or a pattern such as `(\d+)`, a stray brace in a path
template, and a required GET or HEAD body. An optional GET or HEAD body is left out of the tool
input and named in its description, and so is a declared path parameter the path does not hold.
