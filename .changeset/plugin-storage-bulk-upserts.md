---
"@executor-js/fumadb": patch
"@executor-js/sdk": patch
---

Add a FumaDB bulk upsert query path and route plugin-storage bulk writes through
it so existing rows are updated without delete/reinsert churn.
