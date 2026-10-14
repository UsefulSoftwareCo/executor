---
"@executor-js/sdk": minor
---

Accounts are saved only by completing an app's connection request. `accounts.add`
(`POST /v1/accounts`) and `accounts.replaceCredentials`
(`PUT /v1/accounts/:account/credentials`) are removed; products write the
credentials of accounts they provision themselves through the host-only
`managedAccounts`. Every connection now has a non-null `target`.
