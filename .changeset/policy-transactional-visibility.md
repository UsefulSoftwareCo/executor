---
"@executor-js/sdk": patch
---

Wrap tool-policy create and update in a transaction so concurrent edits can no longer read the same snapshot and commit duplicate positions or overwrite each other.
