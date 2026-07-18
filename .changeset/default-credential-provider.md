---
"@executor-js/sdk": patch
---

Add an optional `defaultCredentialProvider` to `ExecutorConfig`. When set to a registered writable provider's key, that provider becomes the default writable store for OAuth tokens and pasted secrets, ahead of registration order; it falls back to registration order when unset or when the named provider is absent or read-only. The local app reads `EXECUTOR_DEFAULT_SECRET_PROVIDER` to populate it. This lets a host on ephemeral infrastructure force a durable on-disk store (for example `file`, backed by `EXECUTOR_DATA_DIR`) instead of an in-memory system keychain (kernel keyutils on Linux), whose OAuth tokens do not survive a fresh machine.
