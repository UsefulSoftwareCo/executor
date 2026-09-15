---
"@executor-js/api": patch
---

Advertise refresh-token support in OAuth client ID metadata documents.

OAuth providers may reject the `offline_access` scope when the client's
metadata declares only the authorization-code grant. Hosted and local client
metadata now declare both `authorization_code` and `refresh_token`, matching
Executor's dynamic client registration behavior.
