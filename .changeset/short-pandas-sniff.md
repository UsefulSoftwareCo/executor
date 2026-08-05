---
"@executor-js/sdk": patch
---

Fix a second OAuth connection for the same integration silently overwriting the first instead of being added. Connection names are now normalized consistently: `connectionIdentifier` is idempotent, and the OAuth start flow's free-name guard checks the same normalized name the mint stores, so connecting another account resolves to a distinct suffixed name (e.g. `myGmail2`) instead of re-minting the existing connection.
