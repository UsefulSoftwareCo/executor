---
"@executor-js/react": patch
---

Use Dynamic Client Registration instead of a Client ID Metadata Document when Executor runs on a private host (localhost, a LAN address, or a tailnet name) and the OAuth provider is public. The provider fetches the CIMD URL itself, so these sign-ins previously failed with `invalid_client`. A provider on a private host keeps using CIMD.
