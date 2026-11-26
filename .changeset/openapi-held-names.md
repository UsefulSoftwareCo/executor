---
"apps": patch
---

An OpenAPI operation keeps its tool name when a later sibling's refined name
would land on it. The sibling is refined further instead, so a name an agent or
an approval policy already uses keeps calling the same operation. A document
that already declares both operations names them the same way, so an app that
upgrades to this release sees those two names change once: in a document with
`GET /forks` and `GET /stars` (both `operationId: list`) and `GET /starred`
(`operationId: listStars`), `repos.listStars` calls `/starred` again and `/stars`
becomes `repos.listGet`.
