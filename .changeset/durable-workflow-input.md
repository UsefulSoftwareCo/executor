---
"apps": patch
"@executor-js/sdk": patch
"@executor-js/app-templates": patch
---

Workflows can request a durable form and wait for its answer across restarts.
The host stores the question before returning its review link. Only the saved
actor can answer through the product's authenticated browser API, subject to
current app, account and membership access. Answers resume the same run once;
withdrawal, expiry and termination close the wait. A form response grants no
permission to a later protected tool.

Pending questions support keyset pagination and safe evidence updates. This
adds the backend and author API; the Approvals interface follows separately.
