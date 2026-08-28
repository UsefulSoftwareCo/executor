---
"executor": minor
---

**The 1Password provider can now be scoped to several vaults at once**

The provider previously bound exactly one vault. The configuration now holds an ordered list of vaults: the settings dialog offers a checkbox per vault, item listings aggregate across every selected vault (suffixing the vault name when more than one is selected), and a bare item id is resolved by trying each vault in order with the first match winning. A fully-qualified `op://` URI resolves when its vault segment names any configured vault, by id or by name.

Configurations saved before this change keep working: the stored single-vault shape is read as a one-vault list and upgrades to the new shape the next time it is saved. The `status` tool now reports `vaultNames` for all configured vaults and flags any configured vault the account can no longer see.
