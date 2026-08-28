---
"executor": patch
---

**The 1Password provider can now be scoped to several vaults, with explicit per-vault addressing**

The provider previously bound exactly one vault. The configuration now holds a set of vaults selected with checkboxes, and every reference is explicit about which vault it means: the item picker is a searchable list that shows each item's vault and stores a vault-qualified `op://` reference, so identically-titled items in different vaults can never collide. A bare item name is accepted only when it matches exactly one item across the selected vaults — a name that exists in more than one place fails with an error naming the matching vaults instead of silently picking one.

Reopening the vault or item pickers no longer flashes a loading state: listings are retained and re-validated in the background, so the last-known list renders instantly.

Configurations saved before this change keep working: the stored single-vault shape is read as a one-vault list and upgrades to the new shape the next time it is saved. The `status` tool reports `vaultNames` for all configured vaults and flags any configured vault the account can no longer see. Provider entries also gained an optional `group` label, which pickers use to show where an item lives.
