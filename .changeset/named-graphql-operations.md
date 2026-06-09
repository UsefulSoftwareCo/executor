---
"@executor-js/plugin-graphql": patch
---

GraphQL sources now emit named operations (e.g. `query Hello { ... }`) instead of anonymous ones. This fixes invocation against servers that reject anonymous operations, and gives APM tooling that keys on the operation name a meaningful value. The operation name is derived from the root field name.
