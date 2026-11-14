---
"@executor-js/sdk": patch
---

Webhook source ticks and account check reads use indexes instead of reading
every row of their tables. Storage version 4.0.16 adds the indexes.
