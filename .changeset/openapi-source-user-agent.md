---
"apps": patch
---

An OpenAPI definition downloaded from a URL now sends `User-Agent: Executor`, as generated operation requests already do. A host that refuses requests without a User-Agent no longer fails the source with an `invalid_definition` error.
