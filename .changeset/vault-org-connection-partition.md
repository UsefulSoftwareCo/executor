---
"executor": patch
---

**Fix: workspace connections were resolvable only by whoever created them**

The WorkOS Vault credential provider filed a credential's metadata under the _acting user's_ private partition instead of the credential's own owner. Org-shared connections (and OAuth tokens, and OAuth client secrets) created by one member therefore resolved only for that member — every other member of the workspace hit `connection_value_missing` ("no resolvable credential value") even though the key was saved correctly. The provider now partitions by the owner embedded in the credential's item id (`connection:org:…` → org-shared, `connection:user:…` → private), so a key pasted by one member works for the whole workspace. Pre-existing mis-filed metadata is repaired by a one-off cloud migration (`db:repartition-vault:prod`); the stored secret value itself was never affected.
