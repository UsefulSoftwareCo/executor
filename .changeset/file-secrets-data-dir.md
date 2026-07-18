---
"@executor-js/plugin-file-secrets": patch
---

`fileSecretsPlugin()` now stores `auth.json` under `EXECUTOR_DATA_DIR` when that variable is set (an explicit `directory` option still wins; the XDG location remains the fallback when it is unset). Existing secrets in the legacy XDG location are migrated automatically on first use. This keeps all daemon state under one directory, so persisting `EXECUTOR_DATA_DIR` alone preserves credentials across environment recreation.
