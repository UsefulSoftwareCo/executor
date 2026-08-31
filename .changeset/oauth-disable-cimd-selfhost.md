---
"executor": patch
---

Add `EXECUTOR_OAUTH_DISABLE_CIMD` for self-hosts on private networks: suppresses Client ID Metadata Document support in OAuth probe results, so automatic connects use dynamic client registration or manual setup instead of a CIMD client_id URL the provider cannot fetch.
