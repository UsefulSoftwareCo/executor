---
"@executor-js/sdk": patch
---

**Fix: the admin joined user view no longer issues one connection query per subject**

`admin.listSubjectsWithConnections` read a page of subjects and then queried
connections once per subject, sequentially. A default page therefore cost 100
round trips inside a single request, which on a per-request socket dominated
the response. It now reads the page and then batches every subject's
connections into one query, so the cost is two queries regardless of page size.
A subject with no connections still reports an empty array rather than dropping
out of the page, and the batched read carries the same `owner: "user"` and
tenant scoping the per-subject read did.

The `?email=` filter on the admin users endpoints is also applied before the
read rather than after it: the address resolves to a principal id and that id is
read directly, instead of paging the tenant and keeping the row that matched.
Paging still applies to a filtered response, but to the selected row — one row
at `offset: 0`, empty beyond it.
