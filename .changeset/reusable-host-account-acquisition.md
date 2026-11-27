---
"apps": minor
"@executor-js/sdk": minor
"@executor-js/local-server": minor
"@executor-js/hosted-self-host": minor
"@executor-js/hosted-server": patch
"@executor-js/hosted-web": patch
"@executor-js/local-web": patch
"@executor-js/utils": patch
---

Allow hosts to register reusable interactive account drivers. Apps can request
host-owned sign-in without owning its credential lifecycle. Saved accounts survive
app removal, reconnect in place, retain private references and record native driver
health checks. Explicit deletion uses an idempotent operation that can be retried.

Host protocol 22 retains protocols 1 through 15. Storage 4.0.23 adds account-driver
bindings and check receipts without changing existing tables.
