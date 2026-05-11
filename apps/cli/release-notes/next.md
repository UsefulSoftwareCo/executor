## Fixes

- 1Password vault items now appear in the secrets list without first being bound. `executor.secrets.list()` fans out to each provider's `list()` after collecting core routing rows, so read-only providers (1Password, file-secrets, workos-vault) surface their inventory directly. Core rows still win on id collisions; connection-owned ids stay hidden.
